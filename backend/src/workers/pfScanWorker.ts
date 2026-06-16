import { Prisma } from "@prisma/client";
import { UnrecoverableError, Worker } from "bullmq";
import { connection } from "../services/queue";
import { prisma, withTenantContext } from "../services/db";
import { updatePfScanJob } from "../services/pfScanJob";
import { acceptedListingsForClient, summaryWithAcceptedCount, type FinderListing } from "../services/foundProducts";
import { mergeActiveListings } from "../services/activeList";
import { mergeMatchedIntoFound } from "../services/foundMerge";

const SCRAPER_URL = process.env.SCRAPER_URL || "http://localhost:8001";
const PF_SCAN_BUDGET_USD = Number(process.env.PF_SCAN_BUDGET_USD || "2");

async function fetchScraper(path: string, payload: Record<string, unknown>) {
  const r = await fetch(`${SCRAPER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Scraper failed (${r.status}): ${text.slice(0, 300)}`);
  }
  return (await r.json()) as {
    seller: string;
    listings: FinderListing[];
    summary: Record<string, unknown>;
  };
}

const worker = new Worker(
  "pf-scan",
  async (job) => {
    const data = job.data as {
      tenantId: string;
      seller: string;
      scanType: "sold" | "active";
      daysBack: number;
      forceRefresh: boolean;
      fetchPrices?: boolean;
      storeSettings?: Record<string, unknown>;
    };

    return withTenantContext(data.tenantId, async () => {
      const setJob = async (patch: {
        status?: string;
        stage?: string | null;
        progress?: Prisma.InputJsonValue | null;
        error?: string | null;
        result?: Prisma.InputJsonValue | null;
      }) => updatePfScanJob(job.id!, patch);

      await setJob({ status: "active", stage: "ebay_scrape" });

      const endpoint =
        data.scanType === "active" ? "/product-finder/analyze-active" : "/product-finder/analyze";
      const body =
        data.scanType === "active"
          ? {
              seller: data.seller,
              store_settings: data.storeSettings ?? {},
              fetch_prices: data.fetchPrices !== false,
              force_refresh: data.forceRefresh,
              job_id: job.id,
            }
          : {
              seller: data.seller,
              days_back: data.daysBack,
              store_settings: data.storeSettings ?? {},
              fetch_prices: data.fetchPrices !== false,
              force_refresh: data.forceRefresh,
              job_id: job.id,
            };

      const res = await fetchScraper(endpoint, body);
      const rawListings = Array.isArray(res.listings) ? res.listings : [];
      const listings = acceptedListingsForClient(rawListings);
      const summary = summaryWithAcceptedCount(
        listings,
        res.summary as Record<string, unknown> | null
      );
      const proxyCost = Number(summary.proxy_cost_usd ?? 0);
      if (proxyCost > PF_SCAN_BUDGET_USD) {
        await setJob({
          status: "failed",
          stage: null,
          error: `budget: proxy_cost_usd=${proxyCost.toFixed(4)} over limit ${PF_SCAN_BUDGET_USD.toFixed(2)}`,
          result: {
            matched: Number(summary.matched_to_amazon ?? 0),
            proxyCostUsd: proxyCost,
          } as Prisma.InputJsonValue,
        });
        throw new UnrecoverableError("budget");
      }

      await setJob({
        stage: "merging",
        progress: {
          summary,
          scanType: data.scanType,
          seller: data.seller,
        } as Prisma.InputJsonValue,
      });

      if (data.scanType === "active") {
        await prisma.sellerAnalysis.deleteMany({
          where: { tenantId: data.tenantId, seller: data.seller, scanType: "active", daysBack: 0 },
        });
        await prisma.sellerAnalysis.create({
          data: {
            tenantId: data.tenantId,
            seller: data.seller,
            daysBack: 0,
            scanType: "active",
            listings: listings as unknown as Prisma.InputJsonValue,
            summary: summary as Prisma.InputJsonValue,
          },
        });
        await mergeActiveListings(data.seller, listings, {
          replaceSeller: true,
          tenantId: data.tenantId,
        });
      } else {
        await prisma.sellerAnalysis.deleteMany({
          where: {
            tenantId: data.tenantId,
            seller: data.seller,
            daysBack: data.daysBack,
            scanType: "sold",
          },
        });
        await prisma.sellerAnalysis.create({
          data: {
            tenantId: data.tenantId,
            seller: data.seller,
            daysBack: data.daysBack,
            scanType: "sold",
            listings: listings as unknown as Prisma.InputJsonValue,
            summary: summary as Prisma.InputJsonValue,
          },
        });
        await mergeMatchedIntoFound(data.seller, data.daysBack, listings, {
          replaceWindow: true,
          tenantId: data.tenantId,
        });
      }

      await setJob({
        status: "done",
        stage: null,
        progress: { summary } as Prisma.InputJsonValue,
        result: {
          matched: Number(summary.matched_to_amazon ?? 0),
          proxyCostUsd: Number(summary.proxy_cost_usd ?? 0),
          total: Number(summary.total_listings ?? 0),
        } as Prisma.InputJsonValue,
      });
      return { ok: true };
    });
  },
  { connection, concurrency: 2, lockDuration: 60_000 }
);

worker.on("failed", async (job, err) => {
  const id = job?.id;
  if (!id) return;
  if (err instanceof UnrecoverableError && String(err.message).includes("budget")) return;
  await prisma.pfScanJob
    .update({
      where: { id },
      data: {
        status: "failed",
        stage: null,
        error: err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400),
      },
    })
    .catch(() => undefined);
});

console.log("PF scan worker started (queue=pf-scan, concurrency=2)");
