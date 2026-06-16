import { Queue } from "bullmq";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || "6379", 10),
    maxRetriesPerRequest: null,
  };
}

export const connection = parseRedisUrl(REDIS_URL);

let scrapeQueue: Queue | null = null;
let pfScanQueue: Queue | null = null;

export function getScrapeQueue() {
  if (!scrapeQueue) {
    scrapeQueue = new Queue("scrape-jobs", { connection });
  }
  return scrapeQueue;
}

export function getPfScanQueue() {
  if (!pfScanQueue) {
    pfScanQueue = new Queue("pf-scan", { connection });
  }
  return pfScanQueue;
}

export async function enqueueBulkJob(jobId: string, asins: string[]) {
  await getScrapeQueue().add(
    "bulk-scrape",
    { jobId, asins },
    { jobId: `bulk-${jobId}` }
  );
}

export async function enqueuePfScanJob(
  jobId: string,
  data: {
    tenantId: string;
    seller: string;
    scanType: "sold" | "active";
    daysBack: number;
    forceRefresh: boolean;
    fetchPrices?: boolean;
    storeSettings?: Record<string, unknown>;
  }
) {
  await getPfScanQueue().add(
    "scan",
    data,
    {
      jobId,
      removeOnComplete: 1000,
      removeOnFail: 2000,
      attempts: 3,
      backoff: { type: "exponential", delay: 6000 },
    }
  );
}
