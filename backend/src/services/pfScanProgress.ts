import { createRedisClient } from "./redis";

export async function publishCancel(jobId: string) {
  const redis = createRedisClient(`pf-cancel:${jobId}`);
  try {
    await redis.setex(`pf:cancel:${jobId}`, 3600, "1");
    await redis.publish(
      `pf:progress:${jobId}`,
      JSON.stringify({ jobId, status: "canceled", stage: null })
    );
  } finally {
    await redis.quit().catch(() => undefined);
  }
}
