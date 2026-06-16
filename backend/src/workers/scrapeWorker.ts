import { Prisma } from "@prisma/client";
import { Worker } from "bullmq";
import { connection } from "../services/queue";
import { prisma } from "../services/db";
import { parseItemStats, type ItemScrapeStat } from "../utils/jobStats";
import {
  extractAsin,
  needsFullPage,
  upsertFromScrape,
} from "../services/productService";
import {
  scrapeBatch,
  scrapeDidFullFetch,
  ScrapeResult,
} from "../services/scraper";

/** Tek scraper HTTP istegi ile gonderilecek maksimum ASIN (100 paralel hedef) */
const CHUNK_SIZE = parseInt(process.env.BULK_CHUNK_SIZE || "100", 10);
const BATCH_CONCURRENCY = parseInt(process.env.BULK_CONCURRENCY || "40", 10);
const UPSERT_PARALLEL = parseInt(process.env.BULK_UPSERT_PARALLEL || "20", 10);

function isScrapeSuccess(item: ScrapeResult, aodOnly: boolean): boolean {
  if (item.error) return false;
  if (aodOnly) {
    return item.price != null || (item.stock != null && item.stock !== "Unknown");
  }
  const hasTitle = !!item.title?.trim();
  const hasPrice = item.price != null;
  const hasBullets = (item.bullet_points?.length ?? 0) > 0;
  const hasImages = (item.images?.length ?? 0) > 0;
  return hasTitle || hasPrice || hasBullets || hasImages;
}

async function resolveScrapePlan(asins: string[]): Promise<{
  fullPageAsins: string[];
  lastFullFetchByAsin: Record<string, string | null>;
}> {
  const rows = await prisma.product.findMany({
    where: { asin: { in: asins } },
    select: {
      asin: true,
      title: true,
      fullFetchAt: true,
      price: true,
      bulletPoints: true,
    },
  });
  const byAsin = new Map(rows.map((r) => [r.asin, r]));
  const fullPageAsins: string[] = [];
  const lastFullFetchByAsin: Record<string, string | null> = {};

  for (const asin of asins) {
    const p = byAsin.get(asin);
    lastFullFetchByAsin[asin] = p?.fullFetchAt?.toISOString() ?? null;
    if (
      needsFullPage(p?.title, p?.fullFetchAt, p?.price ?? null, p?.bulletPoints)
    ) {
      fullPageAsins.push(asin);
    }
  }
  return { fullPageAsins, lastFullFetchByAsin };
}

async function upsertResults(
  results: ScrapeResult[],
  fullPageAsins: Set<string>
): Promise<{ done: number; failed: number }> {
  let done = 0;
  let failed = 0;

  for (let i = 0; i < results.length; i += UPSERT_PARALLEL) {
    const slice = results.slice(i, i + UPSERT_PARALLEL);
    const outcomes = await Promise.all(
      slice.map(async (item) => {
        const aodOnly = !fullPageAsins.has(item.asin);
        if (!isScrapeSuccess(item, aodOnly)) {
          return "failed" as const;
        }
        try {
          await upsertFromScrape(
            item,
            scrapeDidFullFetch(item) || fullPageAsins.has(item.asin)
          );
          return "done" as const;
        } catch {
          return "failed" as const;
        }
      })
    );
    for (const o of outcomes) {
      if (o === "done") done++;
      else failed++;
    }
  }

  return { done, failed };
}

async function scrapeChunk(asins: string[]): Promise<{
  results: ScrapeResult[];
  fullPageAsins: Set<string>;
}> {
  const plan = await resolveScrapePlan(asins);
  const fullPageAsins = new Set(plan.fullPageAsins);
  try {
    const results = await scrapeBatch(asins, {
      concurrency: BATCH_CONCURRENCY,
      fullPageAsins: plan.fullPageAsins,
      lastFullFetchByAsin: plan.lastFullFetchByAsin,
    });
    return { results, fullPageAsins };
  } catch (err) {
    console.error(`[${new Date().toISOString()}] batch scrape failed`, err);
    return {
      fullPageAsins,
      results: asins.map(
        (asin) =>
          ({
            asin,
            price: null,
            stock: "Unknown",
            is_in_stock: false,
            buy_box_seller: null,
            is_amazon_fulfilled: false,
            scraped_at: new Date().toISOString(),
            error: "batch_failed",
          }) as ScrapeResult
      ),
    };
  }
}

async function mergeJobItemStats(
  jobId: string,
  results: ScrapeResult[]
): Promise<void> {
  if (results.length === 0) return;

  const patch: Record<string, ItemScrapeStat> = {};
  let chunkBytes = 0;
  for (const r of results) {
    const bytes = r.bytes_downloaded ?? 0;
    chunkBytes += bytes;
    patch[r.asin] = {
      bytesDownloaded: bytes,
      fetchType: r.fetch_type,
    };
  }

  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ itemStats: unknown }>>`
      SELECT "itemStats" FROM "ScrapeJob" WHERE id = ${jobId} FOR UPDATE
    `;
    if (rows.length === 0) return;

    const current = parseItemStats(rows[0].itemStats);
    const merged = { ...current, ...patch };

    await tx.scrapeJob.update({
      where: { id: jobId },
      data: {
        itemStats: merged as Prisma.InputJsonValue,
        totalBytesDownloaded: { increment: chunkBytes },
      },
    });
  });
}

async function processChunk(jobId: string, asins: string[]) {
  let { results, fullPageAsins } = await scrapeChunk(asins);

  const retryAsins = results
    .filter((r) => !isScrapeSuccess(r, !fullPageAsins.has(r.asin)))
    .map((r) => r.asin)
    .filter(Boolean);

  if (retryAsins.length > 0) {
    const toRetry = retryAsins.slice(0, 100);
    console.log(
      `[${new Date().toISOString()}] Retrying ${toRetry.length} ASINs for job ${jobId}`
    );
    const retryPlan = await resolveScrapePlan(toRetry);
    for (const a of retryPlan.fullPageAsins) fullPageAsins.add(a);
    const retryResults = await scrapeBatch(toRetry, {
      concurrency: BATCH_CONCURRENCY,
      fullPageAsins: retryPlan.fullPageAsins,
      lastFullFetchByAsin: retryPlan.lastFullFetchByAsin,
    });
    const byAsin = new Map(results.map((r) => [r.asin, r]));
    for (const r of retryResults) {
      if (isScrapeSuccess(r, !fullPageAsins.has(r.asin))) {
        byAsin.set(r.asin, r);
      }
    }
    results = Array.from(byAsin.values());
  }

  await mergeJobItemStats(jobId, results);

  const { done, failed } = await upsertResults(results, fullPageAsins);

  if (done > 0 || failed > 0) {
    await prisma.scrapeJob.update({
      where: { id: jobId },
      data: {
        done: { increment: done },
        failed: { increment: failed },
      },
    });
  }
}

const worker = new Worker(
  "scrape-jobs",
  async (job) => {
    const { jobId, asins: rawAsins } = job.data as {
      jobId: string;
      asins: string[];
    };

    const asins = rawAsins
      .map((a) => extractAsin(String(a)))
      .filter((a): a is string => a !== null);

    const chunks: string[][] = [];
    for (let i = 0; i < asins.length; i += CHUNK_SIZE) {
      chunks.push(asins.slice(i, i + CHUNK_SIZE));
    }

    const parallelChunks = parseInt(process.env.BULK_PARALLEL_CHUNKS || "2", 10);
    for (let i = 0; i < chunks.length; i += parallelChunks) {
      const batch = chunks.slice(i, i + parallelChunks);
      await Promise.all(batch.map((chunk) => processChunk(jobId, chunk)));
    }

    const jobRow = await prisma.scrapeJob.findUnique({ where: { id: jobId } });
    const processed = (jobRow?.done ?? 0) + (jobRow?.failed ?? 0);
    await prisma.scrapeJob.update({
      where: { id: jobId },
      data: {
        status: processed >= asins.length ? "done" : "done",
      },
    });
  },
  { connection, concurrency: parseInt(process.env.WORKER_CONCURRENCY || "3", 10) }
);

worker.on("failed", (job, err) => {
  console.error(`[${new Date().toISOString()}] Worker failed`, job?.id, err);
});

console.log(
  `Scrape worker: chunk=${CHUNK_SIZE} batchConcurrency=${BATCH_CONCURRENCY} upsertParallel=${UPSERT_PARALLEL} (AOD for price refresh, full page if fullFetchAt > 24h)`
);
