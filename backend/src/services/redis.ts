import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export function createRedisClient(name: string) {
  const redis = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    enableOfflineQueue: false,
    reconnectOnError: () => false,
    retryStrategy: () => null,
  });
  redis.on("error", (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[redis:${name}] ${message}`);
  });
  return redis;
}
