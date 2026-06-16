import { createRedisClient, ensureRedisConnected } from "./redis";

export async function clearCancel(jobId: string) {
  const redis = createRedisClient(`pf-clear-cancel:${jobId}`);
  try {
    await ensureRedisConnected(redis);
    await redis.del(`pf:cancel:${jobId}`);
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

export async function publishCancel(jobId: string) {
  const redis = createRedisClient(`pf-cancel:${jobId}`);
  try {
    await ensureRedisConnected(redis);
    await redis.setex(`pf:cancel:${jobId}`, 3600, "1");
    await redis.publish(
      `pf:progress:${jobId}`,
      JSON.stringify({ jobId, status: "canceled", stage: null })
    );
  } finally {
    await redis.quit().catch(() => undefined);
  }
}
