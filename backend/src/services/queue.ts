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

export const scrapeQueue = new Queue("scrape-jobs", { connection });

export async function enqueueBulkJob(jobId: string, asins: string[]) {
  await scrapeQueue.add(
    "bulk-scrape",
    { jobId, asins },
    { jobId: `bulk-${jobId}` }
  );
}
