import { Worker } from "bullmq";
import { connection, getPfScanQueue } from "../services/queue";
import { prisma } from "../services/db";

const SCRAPER_URL = process.env.SCRAPER_URL || "http://localhost:8001";

async function refreshSavedAndReserved() {
  const rows = await prisma.pfLibraryProduct.findMany({
    select: { tenantId: true, payload: true },
    take: 5000,
  });
  const byTenant = new Map<string, Set<string>>();
  for (const row of rows) {
    const asin = String((row.payload as Record<string, unknown>)?.amazon_asin || "")
      .trim()
      .toUpperCase();
    if (!asin || asin.length !== 10) continue;
    if (!byTenant.has(row.tenantId)) byTenant.set(row.tenantId, new Set());
    byTenant.get(row.tenantId)!.add(asin);
  }
  for (const [tenantId, set] of byTenant.entries()) {
    const asins = [...set];
    if (asins.length === 0) continue;
    await fetch(`${SCRAPER_URL}/product-finder/prices`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tenant-id": tenantId },
      body: JSON.stringify({ asins }),
    }).catch(() => undefined);
  }
}

const worker = new Worker(
  "pf-reprice",
  async () => {
    await refreshSavedAndReserved();
    return { ok: true };
  },
  { connection, concurrency: 1 }
);

void getPfScanQueue().add(
  "pf-reprice-daily",
  {},
  {
    repeat: { every: 12 * 60 * 60 * 1000 },
    removeOnComplete: 50,
    removeOnFail: 50,
  }
);

worker.on("failed", (job, err) => {
  console.error("pfRepriceWorker failed", job?.id, err);
});

console.log("PF reprice worker started");
