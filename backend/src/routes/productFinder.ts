import { Router } from "express";
import IORedis from "ioredis";
import { Prisma } from "@prisma/client";
import { isPlausibleAsin } from "../utils/asin";
import { prisma } from "../services/db";
import {
  acceptedListingsForClient,
  listingKey,
  allRemoveKeys,
  activeRemoveKeys,
  mergeListing,
  summaryWithAcceptedCount,
  withSource,
  type FinderListing,
} from "../services/foundProducts";
import {
  getFoundStats,
  getFoundStatsForQuery,
  invalidateFoundStatsCache,
  listFoundPage,
  listFoundSellers,
  listMissingPriceAsins,
  countFoundBySeller,
  applyFoundPricesByAsin,
  type FoundSortKey,
  dedupeFoundProducts,
} from "../services/foundList";
import type { ProfitQueryParams } from "../services/productFinderProfit";
import {
  clearLibrary,
  countLibrary,
  listLibrary,
  listLibraryPage,
  mergeLibrary,
  moveLibrary,
  parseLibraryBucket,
  removeLibraryKeys,
  restoreLibraryToFound,
  syncLibrary,
  dedupeLibrary,
} from "../services/libraryList";
import {
  archiveFoundBeforeClear,
  getArchiveStatus,
  restoreLatestArchive,
  type PfArchiveSource,
} from "../services/pfArchive";
import {
  countActiveBySeller,
  getActiveStats,
  listActivePage,
  listActiveSellers,
  mergeActiveListings,
  removeActiveListings,
  clearActiveForSeller,
  clearAllActiveListings,
  applyActivePricesByAsin,
  type ActiveSortKey,
} from "../services/activeList";

function parseProfitQuery(req: { query: Record<string, unknown> }): ProfitQueryParams {
  const vatPct = parseFloat(String(req.query.vatRatePercent ?? ""));
  const additionalFee = parseFloat(String(req.query.additionalFee ?? ""));
  return {
    vatRate: Number.isFinite(vatPct) ? vatPct / 100 : 0,
    additionalFee: Number.isFinite(additionalFee) ? additionalFee : 0,
  };
}

export const productFinderRouter = Router();

const SCRAPER_URL = process.env.SCRAPER_URL || "http://localhost:8001";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
/** Default on — Amazon price fetched with each match. Set env to false to save proxy. */
const FINDER_FETCH_PRICES_ON_ANALYZE =
  process.env.FINDER_FETCH_PRICES_ON_ANALYZE !== "false" &&
  process.env.FINDER_FETCH_PRICES_ON_ANALYZE !== "0";
const RATE_LIMIT_TTL = 3600; // 1 analysis per seller per hour
const CACHE_DAYS = 7;

const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

function cacheCutoff(): Date {
  const d = new Date();
  d.setDate(d.getDate() - CACHE_DAYS);
  return d;
}

const SCRAPER_FETCH_RETRIES = 3;
const SCRAPER_FETCH_RETRY_MS = 8000;

function isTransientScraperError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  const cause = err as Error & { cause?: { code?: string; message?: string } };
  const code = String(cause.cause?.code || "");
  const causeMsg = String(cause.cause?.message || "").toLowerCase();
  return (
    /fetch failed|econnrefused|enotfound|socket|other side closed|und_err|connect/i.test(
      msg
    ) ||
    /fetch failed|econnrefused|enotfound|socket|other side closed|und_err|connect/i.test(
      causeMsg
    ) ||
    /ECONNREFUSED|ENOTFOUND|UND_ERR_SOCKET|ECONNRESET/i.test(code)
  );
}

async function fetchScraper(
  path: string,
  init: RequestInit,
  retries = SCRAPER_FETCH_RETRIES
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(`${SCRAPER_URL}${path}`, init);
    } catch (err) {
      lastErr = err;
      if (!isTransientScraperError(err) || attempt === retries) {
        throw err;
      }
      console.warn(
        `[product-finder] scraper fetch retry ${attempt + 1}/${retries} for ${path}:`,
        err instanceof Error ? err.message : err
      );
      await new Promise((r) => setTimeout(r, SCRAPER_FETCH_RETRY_MS * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** POST /api/product-finder/analyze */
productFinderRouter.post("/analyze", async (req, res) => {
  const seller: string = (req.body?.seller || "").trim();
  const daysBack = clampDaysBack(req.body?.daysBack);
  const storeId: string | undefined = req.body?.storeId;
  const forceRefresh: boolean = Boolean(req.body?.forceRefresh);
  const fetchPrices: boolean =
    req.body?.fetchPrices === false || req.body?.fetchPrices === "false"
      ? false
      : FINDER_FETCH_PRICES_ON_ANALYZE;

  if (!seller) {
    return res.status(400).json({ error: "seller is required" });
  }

  try {
    // 1) DB cache: same seller + daysBack within CACHE_DAYS (skip when forceRefresh)
    if (!forceRefresh) {
      const cached = await prisma.sellerAnalysis.findFirst({
        where: {
          seller,
          daysBack,
          scanType: "sold",
          createdAt: { gte: cacheCutoff() },
        },
        orderBy: { createdAt: "desc" },
      });
      if (cached && Array.isArray(cached.listings)) {
        const listings = acceptedListingsForClient(cached.listings as FinderListing[]);
        const summary = summaryWithAcceptedCount(
          listings,
          cached.summary as Record<string, unknown> | null
        );
        if (listings.length > 0 || Number(summary.total_listings ?? 0) > 0) {
          if (listings.length > 0) {
            try {
              await mergeMatchedIntoFound(seller, daysBack, listings, {
                replaceWindow: true,
              });
            } catch (mergeErr) {
              console.error(`[product-finder] cached Found merge for ${seller}:`, mergeErr);
            }
          }
          const omitListings = listings.length > 150;
          return res.json({
            seller,
            cached: true,
            listings: omitListings ? [] : listings,
            listings_omitted: omitListings,
            summary: { ...summary, proxy_bytes: 0, proxy_cost_usd: 0 },
          });
        }
      }
    }

    // 2) Redis rate limit — temporarily disabled.
    // const rlKey = `pf:rl:${seller.toLowerCase()}`;
    // const set = await redis.set(rlKey, "1", "EX", RATE_LIMIT_TTL, "NX");
    // if (set === null) {
    //   const ttl = await redis.ttl(rlKey);
    //   return res.status(429).json({
    //     error: "Rate limit: one analysis per seller per hour.",
    //     retryAfterSeconds: ttl > 0 ? ttl : RATE_LIMIT_TTL,
    //   });
    // }

    // 3) Load store settings (for fees/VAT in profit calc)
    let storeSettings: Record<string, unknown> = {};
    if (storeId) {
      const store = await prisma.store.findUnique({ where: { id: storeId } });
      if (store?.settings && typeof store.settings === "object") {
        storeSettings = store.settings as Record<string, unknown>;
      }
    }

    // 4) Call scraper pipeline (large sellers can run 15–30+ min)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_800_000);
    let scraperRes: Response;
    try {
      scraperRes = await fetchScraper("/product-finder/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seller,
          days_back: daysBack,
          store_settings: storeSettings,
          fetch_prices: fetchPrices,
          force_refresh: forceRefresh,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!scraperRes.ok) {
      const detail = await scraperRes.text();
      let parsedDetail = detail.slice(0, 400);
      try {
        const j = JSON.parse(detail) as { detail?: string };
        if (j.detail) parsedDetail = j.detail;
      } catch {
        /* raw text */
      }
      const hint =
        /ssl|proxy|wrong_version|curl/i.test(parsedDetail)
          ? "Proxy/SSL error — retry in 1 min or set EBAY_PROXY_MODE=never in .env"
          : parsedDetail;
      return res.status(502).json({ error: "Scraper failed", detail: hint });
    }

    const rawText = await scraperRes.text();
    let data: { seller: string; listings: unknown[]; summary: Record<string, unknown> };
    try {
      data = JSON.parse(rawText) as typeof data;
    } catch {
      return res.status(502).json({
        error: "Scraper returned invalid JSON",
        detail: `Response size ${rawText.length} bytes — retry with Fresh scan off`,
      });
    }

    const allListings = Array.isArray(data.listings) ? (data.listings as FinderListing[]) : [];
    const clientListings = acceptedListingsForClient(allListings);
    const summary = summaryWithAcceptedCount(
      clientListings,
      data.summary as Record<string, unknown> | null
    );

    let persistWarning: string | undefined;
    const totalSold = Number(summary.total_listings ?? 0);
    if (totalSold > 0 || clientListings.length > 0) {
      try {
        await prisma.sellerAnalysis.deleteMany({ where: { seller, daysBack, scanType: "sold" } });
        await prisma.sellerAnalysis.create({
          data: {
            seller,
            daysBack,
            scanType: "sold",
            listings: clientListings as Prisma.InputJsonValue,
            summary: summary as Prisma.InputJsonValue,
          },
        });
      } catch (persistErr) {
        const msg =
          persistErr instanceof Error ? persistErr.message : "Database save failed";
        console.error(`[product-finder] persist failed for ${seller}:`, persistErr);
        persistWarning = msg.slice(0, 200);
      }

      if (clientListings.length > 0) {
        try {
          await mergeMatchedIntoFound(seller, daysBack, clientListings, {
            replaceWindow: true,
          });
        } catch (mergeErr) {
          console.error(`[product-finder] Found merge failed for ${seller}:`, mergeErr);
          persistWarning = persistWarning
            ? `${persistWarning}; Found DB merge incomplete`
            : "Found DB merge incomplete — use Import on Found tab";
        }
      }
    }

    return res.json({
      cached: false,
      seller: data.seller || seller,
      listings: clientListings,
      summary: persistWarning ? { ...summary, persist_warning: persistWarning } : summary,
    });
  } catch (err) {
    if (isTransientScraperError(err)) {
      console.error("[product-finder/analyze] scraper unreachable:", err);
      return res.status(503).json({
        error: "Scraper connection lost — wait a moment for the matcher to warm up, then retry.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "Analysis timed out after 30 minutes — try a shorter date range or retry."
        : err instanceof Prisma.PrismaClientKnownRequestError
          ? `Database error (${err.code}) — retry; only matched rows are stored now.`
          : err instanceof Error && /JSON|parse|heap|memory/i.test(err.message)
            ? "Response too large — retry; deploy latest backend/scraper (slim response fix)."
            : err instanceof Error
              ? err.message
              : "Analysis failed";
    console.error("[product-finder/analyze]", err);
    return res.status(500).json({ error: message });
  }
});

const FINDER_UPSERT_CHUNK = 50;

function clampDaysBack(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 30;
  return Math.min(365, Math.max(1, Math.round(n)));
}

async function mergeMatchedIntoFound(
  seller: string,
  daysBack: number,
  matched: FinderListing[],
  options?: { replaceWindow?: boolean }
): Promise<number> {
  if (matched.length === 0) return 0;

  // Batched merge — thousands of per-row upserts inside one interactive
  // transaction blow Prisma's 5s transaction timeout and abort everything,
  // silently leaving Found empty for big sellers.
  const byKey = new Map<string, FinderListing>();
  for (const raw of matched) {
    const payload = withSource(raw, seller, daysBack);
    const key = listingKey(payload);
    const prev = byKey.get(key);
    byKey.set(key, prev ? (mergeListing(prev, payload) as FinderListing) : payload);
  }
  const keys = [...byKey.keys()];

  const existing = await prisma.foundProduct.findMany({
    where: { listingKey: { in: keys } },
  });
  for (const row of existing) {
    const incoming = byKey.get(row.listingKey);
    if (incoming) {
      byKey.set(
        row.listingKey,
        mergeListing(row.payload as FinderListing, incoming) as FinderListing
      );
    }
  }

  if (options?.replaceWindow) {
    await prisma.foundProduct.deleteMany({ where: { seller, daysBack } });
  }

  const rows = keys.map((key) => ({
    listingKey: key,
    seller,
    daysBack,
    payload: byKey.get(key) as unknown as Prisma.InputJsonValue,
  }));
  for (let i = 0; i < rows.length; i += FINDER_UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + FINDER_UPSERT_CHUNK);
    await prisma.$transaction([
      prisma.foundProduct.deleteMany({
        where: { listingKey: { in: chunk.map((r) => r.listingKey) } },
      }),
      prisma.foundProduct.createMany({ data: chunk, skipDuplicates: true }),
    ]);
  }

  invalidateFoundStatsCache();
  return rows.length;
}

async function bootstrapFoundFromAnalyses(): Promise<number> {
  const analyses = await prisma.sellerAnalysis.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  let count = 0;
  for (const row of analyses) {
    if (!Array.isArray(row.listings)) continue;
    const matched = (row.listings as FinderListing[]).filter((l) => l.amazon_asin);
    for (const raw of matched) {
      const payload = withSource(raw, row.seller, row.daysBack);
      const key = listingKey(payload);
      const existing = await prisma.foundProduct.findUnique({ where: { listingKey: key } });
      const merged = mergeListing(
        existing?.payload as FinderListing | undefined,
        payload
      );
      await prisma.foundProduct.upsert({
        where: { listingKey: key },
        create: {
          listingKey: key,
          seller: row.seller,
          daysBack: row.daysBack,
          payload: merged as Prisma.InputJsonValue,
        },
        update: {
          seller: row.seller,
          daysBack: row.daysBack,
          payload: merged as Prisma.InputJsonValue,
        },
      });
      count += 1;
    }
  }
  return count;
}

/** GET /api/product-finder/found — paginated Found list (default 50/page). */
productFinderRouter.get("/found", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit), 10) || 50));
    const seller = String(req.query.seller ?? "").trim();
    const q = String(req.query.q ?? "").trim();
    const profitable = req.query.profitable === "true" || req.query.profitable === "1";
    const missingPrice =
      req.query.missingPrice === "true" || req.query.missingPrice === "1";
    const hasPrice = req.query.hasPrice === "true" || req.query.hasPrice === "1";
    const minMatchConfidence = parseFloat(String(req.query.minMatchConfidence ?? ""));
    const minMargin = parseFloat(String(req.query.minMargin ?? ""));
    const minSoldPrice = parseFloat(String(req.query.minSoldPrice ?? ""));
    const sortRaw = String(req.query.sort ?? "profit");
    const sort = (
      ["profit", "margin", "sold_date", "sold_price", "quantity", "match"] as const
    ).includes(sortRaw as FoundSortKey)
      ? (sortRaw as FoundSortKey)
      : "profit";

    const pageQuery = {
      page,
      limit,
      seller: seller || undefined,
      q: q || undefined,
      profitable: profitable || undefined,
      missingPrice: missingPrice || undefined,
      hasPrice: hasPrice || undefined,
      minMatchConfidence: Number.isFinite(minMatchConfidence) ? minMatchConfidence : undefined,
      minMargin: Number.isFinite(minMargin) ? minMargin : undefined,
      minSoldPrice: Number.isFinite(minSoldPrice) ? minSoldPrice : undefined,
      sort,
      ...parseProfitQuery(req),
    };

    const result = await listFoundPage(pageQuery);

    const wantStats =
      req.query.includeStats === "true" || req.query.includeStats === "1";
    const stats = wantStats
      ? await getFoundStatsForQuery({
          seller: pageQuery.seller,
          q: pageQuery.q,
          profitable: pageQuery.profitable,
          missingPrice: pageQuery.missingPrice,
          hasPrice: pageQuery.hasPrice,
          minMatchConfidence: pageQuery.minMatchConfidence,
          minMargin: pageQuery.minMargin,
          minSoldPrice: pageQuery.minSoldPrice,
          sort: pageQuery.sort,
          vatRate: pageQuery.vatRate,
          additionalFee: pageQuery.additionalFee,
        })
      : undefined;

    return res.json({
      listings: result.listings,
      count: result.total,
      page: result.page,
      limit: result.limit,
      ...(stats ? { stats } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Load found failed";
    return res.status(500).json({ error: message });
  }
});

/** GET /api/product-finder/summary — tab badge counts (one fast request). */
productFinderRouter.get("/summary", async (_req, res) => {
  try {
    const [found, active, saved, reserved] = await Promise.all([
      prisma.foundProduct.count(),
      prisma.activeListingProduct.count(),
      countLibrary("saved"),
      countLibrary("reserved"),
    ]);
    return res.json({ found, active, saved, reserved });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Summary failed";
    return res.status(500).json({ error: message });
  }
});

/** GET /api/product-finder/found/stats — counts without loading rows. */
productFinderRouter.get("/found/stats", async (req, res) => {
  try {
    const stats = await getFoundStats(false, parseProfitQuery(req));
    return res.json(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stats failed";
    return res.status(500).json({ error: message });
  }
});

/** GET /api/product-finder/found/sellers — distinct source sellers for filter. */
productFinderRouter.get("/found/sellers", async (_req, res) => {
  try {
    const sellers = await listFoundSellers();
    return res.json({ sellers });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sellers failed";
    return res.status(500).json({ error: message });
  }
});

/** GET /api/product-finder/found/seller-counts — rows in Found per seller username. */
productFinderRouter.get("/found/seller-counts", async (_req, res) => {
  try {
    const counts = await countFoundBySeller();
    return res.json({ counts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Seller counts failed";
    return res.status(500).json({ error: message });
  }
});

/** GET /api/product-finder/found/missing-price-asins — ASINs needing price fetch. */
productFinderRouter.get("/found/missing-price-asins", async (req, res) => {
  try {
    const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit), 10) || 500));
    const asins = await listMissingPriceAsins(limit);
    return res.json({ asins, count: asins.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "ASIN list failed";
    return res.status(500).json({ error: message });
  }
});

/** @deprecated full dump — use paginated GET /found?page=1&limit=50 */
productFinderRouter.get("/found/all", async (_req, res) => {
  try {
    let rows = await prisma.foundProduct.findMany({
      orderBy: { updatedAt: "desc" },
    });
    if (rows.length === 0) {
      await bootstrapFoundFromAnalyses();
      rows = await prisma.foundProduct.findMany({ orderBy: { updatedAt: "desc" } });
    }
    return res.json({
      listings: rows.map((r) => r.payload),
      count: rows.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Load found failed";
    return res.status(500).json({ error: message });
  }
});

/** POST /api/product-finder/found/merge — upsert matched listings into DB cache. */
productFinderRouter.post("/found/merge", async (req, res) => {
  const seller: string | undefined = req.body?.seller?.trim?.() || req.body?.seller;
  const daysBack: number | undefined =
    req.body?.daysBack != null ? clampDaysBack(req.body.daysBack) : undefined;
  const listings: unknown[] = Array.isArray(req.body?.listings) ? req.body.listings : [];
  const matched = listings.filter(
    (l): l is FinderListing =>
      typeof l === "object" &&
      l != null &&
      Boolean((l as FinderListing).amazon_asin)
  );
  if (matched.length === 0) {
    return res.json({ merged: 0, total: await prisma.foundProduct.count() });
  }
  try {
    for (const raw of matched) {
      const payload = withSource(raw, seller, daysBack);
      const key = listingKey(payload);
      const existing = await prisma.foundProduct.findUnique({ where: { listingKey: key } });
      const merged = mergeListing(
        existing?.payload as FinderListing | undefined,
        payload
      );
      await prisma.foundProduct.upsert({
        where: { listingKey: key },
        create: {
          listingKey: key,
          seller: seller ?? null,
          daysBack: daysBack ?? null,
          payload: merged as Prisma.InputJsonValue,
        },
        update: {
          seller: seller ?? undefined,
          daysBack: daysBack ?? undefined,
          payload: merged as Prisma.InputJsonValue,
        },
      });
    }
    const total = await prisma.foundProduct.count();
    invalidateFoundStatsCache();
    return res.json({ merged: matched.length, total });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Merge failed";
    return res.status(500).json({ error: message });
  }
});

/** POST /api/product-finder/found/remove — delete specific rows by listingKey. */
productFinderRouter.post("/found/remove", async (req, res) => {
  const rawKeys: string[] = Array.isArray(req.body?.listingKeys)
    ? req.body.listingKeys.filter((k: unknown) => typeof k === "string" && k.trim())
    : [];
  const rawListings: unknown[] = Array.isArray(req.body?.listings) ? req.body.listings : [];
  const keySet = new Set<string>(rawKeys.map((k) => k.trim()).filter(Boolean));
  for (const item of rawListings) {
    if (!item || typeof item !== "object") continue;
    const row = item as FinderListing & { found_key?: string };
    for (const k of allRemoveKeys(row, row.found_key)) keySet.add(k);
  }
  const keys = Array.from(keySet);
  if (keys.length === 0) {
    return res.status(400).json({ error: "listingKeys or listings array is required" });
  }
  try {
    const { count } = await prisma.foundProduct.deleteMany({
      where: { listingKey: { in: keys } },
    });
    invalidateFoundStatsCache();
    const total = await prisma.foundProduct.count();
    return res.json({ removed: count, total });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Remove failed";
    return res.status(500).json({ error: message });
  }
});

/** DELETE /api/product-finder/found — clear accumulated cache (archives first). */
productFinderRouter.delete("/found", async (_req, res) => {
  try {
    const archived = await archiveFoundBeforeClear();
    const { count } = await prisma.foundProduct.deleteMany();
    invalidateFoundStatsCache();
    return res.json({ cleared: count, archived });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Clear failed";
    return res.status(500).json({ error: message });
  }
});

/** POST /api/product-finder/found/dedupe — remove duplicate ASINs/listings (keep best profit). */
productFinderRouter.post("/found/dedupe", async (_req, res) => {
  try {
    const { removed, total } = await dedupeFoundProducts();
    return res.json({ removed, total });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Dedupe failed";
    return res.status(500).json({ error: message });
  }
});

/** POST /api/product-finder/prices — refresh Amazon prices for ASIN list */
productFinderRouter.post("/prices", async (req, res) => {
  const raw: string[] = Array.isArray(req.body?.asins)
    ? req.body.asins.filter((a: unknown) => typeof a === "string")
    : [];
  const asins = Array.from(
    new Set(
      raw
        .map((a) => a.trim().toUpperCase())
        .filter((a) => isPlausibleAsin(a))
    )
  ).slice(0, 1000);
  if (asins.length === 0) {
    return res.status(400).json({
      error: "No valid Amazon ASINs in request (10 chars with at least one digit — not plain words like EXPERIENCE)",
    });
  }

  const CHUNK = 1000;
  const PARALLEL = 1;
  const mergedPrices: Record<
    string,
    { price: number | null; stock?: string; amazon_url: string }
  > = {};
  let proxy_bytes = 0;
  let proxy_cost_usd = 0;
  let proxy_requests = 0;
  const proxy_stages: Record<string, { bytes: number; requests: number; cost_usd: number }> =
    {};

  const fetchChunk = async (chunk: string[]) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900_000);
    try {
      const scraperRes = await fetch(`${SCRAPER_URL}/product-finder/prices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asins: chunk }),
        signal: controller.signal,
      });
      if (!scraperRes.ok) {
        const detail = await scraperRes.text();
        let parsedDetail = detail.slice(0, 400);
        try {
          const j = JSON.parse(detail) as { detail?: string };
          if (j.detail) parsedDetail = j.detail;
        } catch {
          /* raw */
        }
        throw new Error(parsedDetail);
      }
      return (await scraperRes.json()) as {
        prices?: Record<string, { price: number | null; stock?: string; amazon_url: string }>;
        proxy_bytes?: number;
        proxy_cost_usd?: number;
        proxy_requests?: number;
        proxy_stages?: Record<string, { bytes: number; requests: number; cost_usd: number }>;
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const mergePriceData = (data: {
    prices?: Record<string, { price: number | null; stock?: string; amazon_url: string }>;
    proxy_bytes?: number;
    proxy_cost_usd?: number;
    proxy_requests?: number;
    proxy_stages?: Record<string, { bytes: number; requests: number; cost_usd: number }>;
  }) => {
    Object.assign(mergedPrices, data.prices ?? {});
    proxy_bytes += data.proxy_bytes ?? 0;
    proxy_cost_usd += data.proxy_cost_usd ?? 0;
    proxy_requests += data.proxy_requests ?? 0;
    if (data.proxy_stages) {
      for (const [k, v] of Object.entries(data.proxy_stages)) {
        const prev = proxy_stages[k] ?? { bytes: 0, requests: 0, cost_usd: 0 };
        proxy_stages[k] = {
          bytes: prev.bytes + v.bytes,
          requests: prev.requests + v.requests,
          cost_usd: prev.cost_usd + v.cost_usd,
        };
      }
    }
  };

  try {
    for (let i = 0; i < asins.length; i += CHUNK * PARALLEL) {
      const wave: string[][] = [];
      for (let p = 0; p < PARALLEL; p++) {
        const start = i + p * CHUNK;
        if (start >= asins.length) break;
        wave.push(asins.slice(start, start + CHUNK));
      }
      const results = await Promise.all(wave.map((chunk) => fetchChunk(chunk)));
      for (const data of results) {
        mergePriceData(data);
      }
    }

    const withPrice = Object.fromEntries(
      Object.entries(mergedPrices).filter(([, v]) => v.price != null)
    );
    let rowsUpdated = 0;
    if (Object.keys(withPrice).length > 0) {
      const [foundUpdated, activeUpdated] = await Promise.all([
        applyFoundPricesByAsin(withPrice),
        applyActivePricesByAsin(withPrice),
      ]);
      rowsUpdated = foundUpdated + activeUpdated;
      invalidateFoundStatsCache();
    }

    return res.json({
      prices: mergedPrices,
      rows_updated: rowsUpdated,
      proxy_bytes,
      proxy_mb: Math.round((proxy_bytes / (1024 * 1024)) * 100) / 100,
      proxy_requests,
      proxy_cost_usd: proxy_cost_usd,
      proxy_stages: proxy_stages,
    });
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "Price fetch timed out — try fewer ASINs (select a batch)."
        : err instanceof Error
          ? err.message
          : "Price fetch failed";
    if (Object.keys(mergedPrices).length > 0) {
      let rowsUpdated = 0;
      try {
        rowsUpdated = await applyFoundPricesByAsin(
          Object.fromEntries(
            Object.entries(mergedPrices).filter(([, v]) => v.price != null)
          )
        );
        invalidateFoundStatsCache();
      } catch {
        rowsUpdated = 0;
      }
      return res.status(502).json({
        error: "Scraper failed",
        detail: message,
        prices: mergedPrices,
        rows_updated: rowsUpdated,
        proxy_bytes,
        proxy_cost_usd,
      });
    }
    console.error("[product-finder/prices]", err);
    return res.status(500).json({ error: message });
  }
});

/** GET /api/product-finder/library?bucket=saved|reserved — persisted Saved/Reserved lists. */
productFinderRouter.get("/library", async (req, res) => {
  const bucket = parseLibraryBucket(String(req.query.bucket ?? "saved"));
  if (!bucket) {
    return res.status(400).json({ error: "bucket must be saved or reserved" });
  }
  try {
    const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
    const limitRaw = parseInt(String(req.query.limit ?? "0"), 10);
    if (limitRaw > 0) {
      const limit = Math.min(1000, limitRaw);
      const { listings, total } = await listLibraryPage(bucket, { offset, limit });
      return res.json({
        listings,
        count: listings.length,
        total,
        bucket,
        offset,
        limit,
      });
    }
    const listings = await listLibrary(bucket);
    const total = await countLibrary(bucket);
    return res.json({ listings, count: listings.length, total, bucket });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Library load failed";
    return res.status(500).json({ error: message });
  }
});

/** PUT /api/product-finder/library — replace entire bucket (full sync). Requires force=true to wipe. */
productFinderRouter.put("/library", async (req, res) => {
  const bucket = parseLibraryBucket(req.body?.bucket);
  if (!bucket) {
    return res.status(400).json({ error: "bucket must be saved or reserved" });
  }
  const listings: unknown[] = Array.isArray(req.body?.listings) ? req.body.listings : [];
  const force = req.body?.force === true;
  const rows = listings.filter(
    (l): l is FinderListing =>
      typeof l === "object" &&
      l != null &&
      (Boolean((l as FinderListing).amazon_asin) ||
        Boolean((l as FinderListing).listing_id) ||
        Boolean((l as FinderListing).url))
  );
  try {
    const { count } = await syncLibrary(bucket, rows, { force });
    return res.json({ count, bucket });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Library sync failed";
    const status = message.includes("Refusing to wipe") ? 409 : 500;
    return res.status(status).json({ error: message });
  }
});

/** POST /api/product-finder/library/merge — upsert into bucket. */
productFinderRouter.post("/library/merge", async (req, res) => {
  const bucket = parseLibraryBucket(req.body?.bucket);
  if (!bucket) {
    return res.status(400).json({ error: "bucket must be saved or reserved" });
  }
  const listings: unknown[] = Array.isArray(req.body?.listings) ? req.body.listings : [];
  const rows = listings.filter(
    (l): l is FinderListing =>
      typeof l === "object" &&
      l != null &&
      (Boolean((l as FinderListing).amazon_asin) ||
        Boolean((l as FinderListing).listing_id) ||
        Boolean((l as FinderListing).url))
  );
  if (rows.length === 0) {
    return res.json({ merged: 0, bucket });
  }
  try {
    const { merged } = await mergeLibrary(bucket, rows);
    return res.json({ merged, bucket });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Library merge failed";
    return res.status(500).json({ error: message });
  }
});

/** POST /api/product-finder/library/restore-to-found — move Saved/Reserved rows back to Found. */
productFinderRouter.post("/library/restore-to-found", async (req, res) => {
  const bucket = parseLibraryBucket(req.body?.bucket ?? "saved");
  if (!bucket) {
    return res.status(400).json({ error: "bucket must be saved or reserved" });
  }
  const listings: unknown[] = Array.isArray(req.body?.listings) ? req.body.listings : [];
  const rows = listings.filter(
    (l): l is FinderListing => typeof l === "object" && l != null
  );
  if (rows.length === 0) {
    return res.status(400).json({ error: "listings array is required" });
  }
  try {
    const { restored } = await restoreLibraryToFound(bucket, rows);
    invalidateFoundStatsCache();
    const [saved, reserved, total] = await Promise.all([
      listLibrary("saved"),
      listLibrary("reserved"),
      prisma.foundProduct.count(),
    ]);
    return res.json({ restored, saved, reserved, foundTotal: total });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Restore to Found failed";
    return res.status(500).json({ error: message });
  }
});

/** POST /api/product-finder/library/move — atomic saved ↔ reserved move. */
productFinderRouter.post("/library/move", async (req, res) => {
  const from = parseLibraryBucket(req.body?.from);
  const to = parseLibraryBucket(req.body?.to);
  if (!from || !to || from === to) {
    return res.status(400).json({ error: "from and to must be saved or reserved (different)" });
  }
  const listings: unknown[] = Array.isArray(req.body?.listings) ? req.body.listings : [];
  const rows = listings.filter(
    (l): l is FinderListing =>
      typeof l === "object" && l != null && Boolean((l as FinderListing).amazon_asin)
  );
  if (rows.length === 0) {
    return res.status(400).json({ error: "listings array is required" });
  }
  try {
    const { moved } = await moveLibrary(from, to, rows);
    const [saved, reserved] = await Promise.all([
      listLibrary("saved"),
      listLibrary("reserved"),
    ]);
    return res.json({ moved, saved, reserved });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Library move failed";
    return res.status(500).json({ error: message });
  }
});

/** POST /api/product-finder/library/remove — delete rows from bucket. */
productFinderRouter.post("/library/remove", async (req, res) => {
  const bucket = parseLibraryBucket(req.body?.bucket);
  if (!bucket) {
    return res.status(400).json({ error: "bucket must be saved or reserved" });
  }
  const rawKeys: string[] = Array.isArray(req.body?.listingKeys)
    ? req.body.listingKeys.filter((k: unknown) => typeof k === "string" && k.trim())
    : [];
  const rawListings: unknown[] = Array.isArray(req.body?.listings) ? req.body.listings : [];
  try {
    const { removed } = await removeLibraryKeys(
      bucket,
      rawKeys,
      rawListings.filter(
        (l): l is FinderListing => typeof l === "object" && l != null
      )
    );
    return res.json({ removed, bucket });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Library remove failed";
    return res.status(500).json({ error: message });
  }
});

/** DELETE /api/product-finder/library?bucket=saved|reserved — clear bucket (archives first). */
productFinderRouter.delete("/library", async (req, res) => {
  const bucket = parseLibraryBucket(String(req.query.bucket ?? ""));
  if (!bucket) {
    return res.status(400).json({ error: "bucket query must be saved or reserved" });
  }
  try {
    const { cleared, archived } = await clearLibrary(bucket);
    return res.json({ cleared, archived, bucket });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Library clear failed";
    return res.status(500).json({ error: message });
  }
});

/** GET /api/product-finder/archive/status?source=found|saved|reserved */
productFinderRouter.get("/archive/status", async (req, res) => {
  const source = String(req.query.source ?? "").trim().toLowerCase() as PfArchiveSource;
  if (source !== "found" && source !== "saved" && source !== "reserved") {
    return res.status(400).json({ error: "source must be found, saved, or reserved" });
  }
  try {
    const status = await getArchiveStatus(source);
    return res.json({ source, ...status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Archive status failed";
    return res.status(500).json({ error: message });
  }
});

/** POST /api/product-finder/archive/restore — restore latest snapshot for a source. */
productFinderRouter.post("/archive/restore", async (req, res) => {
  const source = String(req.body?.source ?? "").trim().toLowerCase() as PfArchiveSource;
  if (source !== "found" && source !== "saved" && source !== "reserved") {
    return res.status(400).json({ error: "source must be found, saved, or reserved" });
  }
  try {
    const { restored } = await restoreLatestArchive(source);
    if (source === "found") invalidateFoundStatsCache();
    const payload: Record<string, unknown> = { restored, source };
    if (source === "found") {
      payload.foundTotal = await prisma.foundProduct.count();
    } else {
      const [saved, reserved] = await Promise.all([
        listLibrary("saved"),
        listLibrary("reserved"),
      ]);
      payload.saved = saved;
      payload.reserved = reserved;
    }
    return res.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Archive restore failed";
    return res.status(500).json({ error: message });
  }
});

/** POST /api/product-finder/library/dedupe?bucket=saved|reserved — remove duplicate rows. */
productFinderRouter.post("/library/dedupe", async (req, res) => {
  const bucket = parseLibraryBucket(String(req.query.bucket ?? req.body?.bucket ?? ""));
  if (!bucket) {
    return res.status(400).json({ error: "bucket must be saved or reserved" });
  }
  try {
    const { removed, total } = await dedupeLibrary(bucket);
    const listings = await listLibrary(bucket);
    return res.json({ removed, total, listings, bucket });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Library dedupe failed";
    return res.status(500).json({ error: message });
  }
});

/** GET /api/product-finder/history — list saved analyses (for restoring results). */
productFinderRouter.get("/history", async (_req, res) => {
  try {
    const rows = await prisma.sellerAnalysis.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        seller: true,
        daysBack: true,
        summary: true,
        createdAt: true,
      },
    });
    return res.json({ analyses: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "History failed";
    return res.status(500).json({ error: message });
  }
});

/** POST /api/product-finder/found/import-all — sync Found from all recent seller scans. */
productFinderRouter.post("/found/import-all", async (_req, res) => {
  try {
    const analyses = await prisma.sellerAnalysis.findMany({
      where: { createdAt: { gte: cacheCutoff() } },
      orderBy: { createdAt: "desc" },
    });
    let imported = 0;
    let sellers = 0;
    for (const row of analyses) {
      if (!Array.isArray(row.listings)) continue;
      const listings = acceptedListingsForClient(row.listings as FinderListing[]);
      if (listings.length === 0) continue;
      await mergeMatchedIntoFound(row.seller, row.daysBack, listings, {
        replaceWindow: true,
      });
      imported += listings.length;
      sellers += 1;
    }
    const total = await prisma.foundProduct.count();
    return res.json({ imported, total, sellers });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import all failed";
    console.error("[product-finder/found/import-all]", err);
    return res.status(500).json({ error: message });
  }
});

/** POST /api/product-finder/found/import/:seller/:daysBack — server-side import from saved scan. */
productFinderRouter.post("/found/import/:seller/:daysBack", async (req, res) => {
  const seller = req.params.seller.trim();
  const daysBack = clampDaysBack(req.params.daysBack);
  if (!seller) {
    return res.status(400).json({ error: "seller and daysBack required" });
  }
  try {
    const row = await prisma.sellerAnalysis.findFirst({
      where: { seller, daysBack, scanType: "sold" },
      orderBy: { createdAt: "desc" },
    });
    if (!row || !Array.isArray(row.listings) || row.listings.length === 0) {
      return res.status(404).json({ error: "No saved analysis found" });
    }
    const listings = acceptedListingsForClient(row.listings as FinderListing[]);
    if (listings.length === 0) {
      return res.status(404).json({ error: "No accepted matches in saved analysis" });
    }
    await mergeMatchedIntoFound(seller, daysBack, listings, { replaceWindow: true });
    const sellerInFound = await prisma.foundProduct.count({ where: { seller } });
    const total = await prisma.foundProduct.count();
    return res.json({
      seller: row.seller,
      daysBack,
      imported: listings.length,
      sellerInFound,
      total,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import failed";
    console.error("[product-finder/found/import]", err);
    return res.status(500).json({ error: message });
  }
});

/** GET /api/product-finder/history/:seller/:daysBack — load a saved analysis. */
productFinderRouter.get("/history/:seller/:daysBack", async (req, res) => {
  const seller = req.params.seller.trim();
  const daysBack = clampDaysBack(req.params.daysBack);
  if (!seller) {
    return res.status(400).json({ error: "seller and daysBack required" });
  }
  try {
    const row = await prisma.sellerAnalysis.findFirst({
      where: { seller, daysBack, scanType: "sold" },
      orderBy: { createdAt: "desc" },
    });
    if (!row || !Array.isArray(row.listings) || row.listings.length === 0) {
      return res.status(404).json({ error: "No saved analysis found" });
    }
    const listings = acceptedListingsForClient(row.listings as FinderListing[]);
    const summary = summaryWithAcceptedCount(
      listings,
      row.summary as Record<string, unknown> | null
    );
    return res.json({
      seller: row.seller,
      cached: true,
      listings,
      summary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Load failed";
    return res.status(500).json({ error: message });
  }
});

/** POST /api/product-finder/analyze-active — scrape seller's live eBay listings + Amazon match. */
productFinderRouter.post("/analyze-active", async (req, res) => {
  const seller: string = (req.body?.seller || "").trim();
  const storeId: string | undefined = req.body?.storeId;
  const forceRefresh: boolean = Boolean(req.body?.forceRefresh);
  const fetchPrices: boolean =
    req.body?.fetchPrices === false || req.body?.fetchPrices === "false"
      ? false
      : FINDER_FETCH_PRICES_ON_ANALYZE;

  if (!seller) {
    return res.status(400).json({ error: "seller is required" });
  }

  try {
    if (!forceRefresh) {
      const cached = await prisma.sellerAnalysis.findFirst({
        where: {
          seller,
          scanType: "active",
          daysBack: 0,
          createdAt: { gte: cacheCutoff() },
        },
        orderBy: { createdAt: "desc" },
      });
      if (cached && Array.isArray(cached.listings)) {
        const listings = acceptedListingsForClient(cached.listings as FinderListing[]);
        const summary = summaryWithAcceptedCount(
          listings,
          cached.summary as Record<string, unknown> | null
        );
        if (listings.length > 0 || Number(summary.total_listings ?? 0) > 0) {
          try {
            await mergeActiveListings(seller, listings, { replaceSeller: true });
          } catch (mergeErr) {
            console.error(`[product-finder] cached Active merge for ${seller}:`, mergeErr);
          }
          const omitListings = listings.length > 150;
          return res.json({
            seller,
            cached: true,
            listings: omitListings ? [] : listings,
            listings_omitted: omitListings,
            summary: { ...summary, proxy_bytes: 0, proxy_cost_usd: 0 },
          });
        }
      }
    }

    let storeSettings: Record<string, unknown> = {};
    if (storeId) {
      const store = await prisma.store.findUnique({ where: { id: storeId } });
      if (store?.settings && typeof store.settings === "object") {
        storeSettings = store.settings as Record<string, unknown>;
      }
    }

    const controller = new AbortController();
    // Full-store live scans can take a long time for big sellers (no match cap).
    const timer = setTimeout(() => controller.abort(), 7_200_000);
    let scraperRes: Response;
    try {
      scraperRes = await fetchScraper("/product-finder/analyze-active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seller,
          store_settings: storeSettings,
          fetch_prices: fetchPrices,
          force_refresh: forceRefresh,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!scraperRes.ok) {
      const detail = await scraperRes.text();
      let parsedDetail = detail.slice(0, 400);
      try {
        const j = JSON.parse(detail) as { detail?: string };
        if (j.detail) parsedDetail = j.detail;
      } catch {
        /* raw */
      }
      return res.status(502).json({ error: "Scraper failed", detail: parsedDetail });
    }

    const rawText = await scraperRes.text();
    let data: { seller: string; listings: unknown[]; summary: Record<string, unknown> };
    try {
      data = JSON.parse(rawText) as typeof data;
    } catch {
      return res.status(502).json({
        error: "Scraper returned invalid JSON",
        detail: `Response size ${rawText.length} bytes`,
      });
    }

    const allListings = Array.isArray(data.listings) ? (data.listings as FinderListing[]) : [];
    const clientListings = acceptedListingsForClient(allListings);
    const summary = summaryWithAcceptedCount(
      clientListings,
      data.summary as Record<string, unknown> | null
    );

    try {
      await prisma.sellerAnalysis.deleteMany({
        where: { seller, scanType: "active", daysBack: 0 },
      });
      await prisma.sellerAnalysis.create({
        data: {
          seller,
          daysBack: 0,
          scanType: "active",
          listings: clientListings as Prisma.InputJsonValue,
          summary: summary as Prisma.InputJsonValue,
        },
      });
    } catch (persistErr) {
      console.error(`[product-finder] Active analysis persist for ${seller}:`, persistErr);
    }

    try {
      await mergeActiveListings(seller, clientListings, { replaceSeller: true });
    } catch (mergeErr) {
      console.error(`[product-finder] Active merge for ${seller}:`, mergeErr);
    }

    const omitListings = clientListings.length > 150;
    return res.json({
      seller,
      cached: false,
      listings: omitListings ? [] : clientListings,
      listings_omitted: omitListings,
      summary,
    });
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "Active scan timed out — try again or scan a smaller seller"
        : err instanceof Error
          ? err.message
          : "Active analysis failed";
    console.error("[product-finder/analyze-active]", err);
    return res.status(500).json({ error: message });
  }
});

/** GET /api/product-finder/active — paginated live listings (matched). */
productFinderRouter.get("/active", async (req, res) => {
  try {
    const pq = parseProfitQuery(req);
    const sortRaw = String(req.query.sort ?? "profit");
    const sort: ActiveSortKey =
      sortRaw === "margin" || sortRaw === "sold_price" || sortRaw === "match"
        ? sortRaw
        : "profit";
    const minConf = parseFloat(String(req.query.minMatchConfidence ?? ""));
    const minMargin = parseFloat(String(req.query.minMargin ?? ""));
    const minListPrice = parseFloat(String(req.query.minListPrice ?? ""));

    const result = await listActivePage({
      page: parseInt(String(req.query.page ?? "1"), 10),
      limit: parseInt(String(req.query.limit ?? "50"), 10),
      seller: String(req.query.seller ?? "").trim() || undefined,
      q: String(req.query.q ?? "").trim() || undefined,
      profitable: req.query.profitable === "true" || req.query.profitable === "1",
      missingPrice: req.query.missingPrice === "true" || req.query.missingPrice === "1",
      hasPrice: req.query.hasPrice === "true" || req.query.hasPrice === "1",
      minMatchConfidence: Number.isFinite(minConf) ? minConf : undefined,
      minMargin: Number.isFinite(minMargin) ? minMargin : undefined,
      minListPrice: Number.isFinite(minListPrice) ? minListPrice : undefined,
      sort,
      vatRate: pq.vatRate,
      additionalFee: pq.additionalFee,
    });

    const includeStats = req.query.includeStats !== "false";

    return res.json({
      listings: result.listings,
      count: result.total,
      page: result.page,
      limit: result.limit,
      stats: includeStats
        ? await getActiveStats({
            seller: String(req.query.seller ?? "").trim() || undefined,
            vatRate: pq.vatRate,
            additionalFee: pq.additionalFee,
          })
        : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Load active failed";
    return res.status(500).json({ error: message });
  }
});

/** GET /api/product-finder/active/stats — global or seller-filtered stats. */
productFinderRouter.get("/active/stats", async (req, res) => {
  try {
    const pq = parseProfitQuery(req);
    const stats = await getActiveStats({
      seller: String(req.query.seller ?? "").trim() || undefined,
      vatRate: pq.vatRate,
      additionalFee: pq.additionalFee,
    });
    return res.json(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Active stats failed";
    return res.status(500).json({ error: message });
  }
});

/** GET /api/product-finder/active/sellers — sellers with stored active listings. */
productFinderRouter.get("/active/sellers", async (_req, res) => {
  try {
    const sellers = await listActiveSellers();
    return res.json({ sellers });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Active sellers failed";
    return res.status(500).json({ error: message });
  }
});

/** GET /api/product-finder/active/seller-counts */
productFinderRouter.get("/active/seller-counts", async (_req, res) => {
  try {
    const counts = await countActiveBySeller();
    return res.json({ counts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Active counts failed";
    return res.status(500).json({ error: message });
  }
});

/** POST /api/product-finder/active/remove — delete specific live rows by listingKey. */
productFinderRouter.post("/active/remove", async (req, res) => {
  const rawKeys: string[] = Array.isArray(req.body?.listingKeys)
    ? req.body.listingKeys.filter((k: unknown) => typeof k === "string" && k.trim())
    : [];
  const rawListings: unknown[] = Array.isArray(req.body?.listings) ? req.body.listings : [];
  const keySet = new Set<string>(rawKeys.map((k) => k.trim()).filter(Boolean));
  for (const item of rawListings) {
    if (!item || typeof item !== "object") continue;
    const row = item as FinderListing;
    for (const k of activeRemoveKeys(row)) keySet.add(k);
  }
  const keys = Array.from(keySet);
  if (keys.length === 0) {
    return res.status(400).json({ error: "listingKeys or listings array is required" });
  }
  try {
    const { removed, total } = await removeActiveListings(keys);
    return res.json({ removed, total });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Active remove failed";
    return res.status(500).json({ error: message });
  }
});

/** DELETE /api/product-finder/active — clear all live listings (optional ?seller= filter). */
productFinderRouter.delete("/active", async (req, res) => {
  const seller = String(req.query.seller ?? "").trim();
  try {
    const cleared = seller
      ? await clearActiveForSeller(seller)
      : await clearAllActiveListings();
    return res.json({ cleared, total: await prisma.activeListingProduct.count() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Clear active failed";
    return res.status(500).json({ error: message });
  }
});

/** GET /api/product-finder/seller-info/:seller */
productFinderRouter.get("/seller-info/:seller", async (req, res) => {
  const seller = req.params.seller.trim();
  if (!seller) return res.status(400).json({ error: "seller is required" });
  try {
    const r = await fetch(
      `${SCRAPER_URL}/product-finder/seller-info/${encodeURIComponent(seller)}`
    );
    if (!r.ok) {
      return res.status(502).json({ error: "Scraper failed" });
    }
    const data = await r.json();
    return res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Lookup failed";
    return res.status(500).json({ error: message });
  }
});
