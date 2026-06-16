import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

function logRedisError(name: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[redis:${name}] ${message}`);
}

/** Command client — SET, publish, rate-limit keys (not subscribe). */
export function createRedisClient(name: string): IORedis {
  const redis = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  });
  redis.on("error", (err) => logRedisError(name, err));
  return redis;
}

/** Dedicated pub/sub subscriber (separate TCP connection per ioredis guidance). */
export function createRedisSubscriber(name: string): IORedis {
  const redis = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    enableOfflineQueue: true,
  });
  redis.on("error", (err) => logRedisError(name, err));
  return redis;
}

/** Wait until the client is connected; does not throw on transient errors. */
export function ensureRedisConnected(redis: IORedis): Promise<void> {
  if (redis.status === "ready") return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      redis.off("ready", onReady);
    };
    redis.once("ready", onReady);
    if (redis.status === "wait" || redis.status === "end") {
      void redis.connect().catch((err) => {
        cleanup();
        reject(err);
      });
    }
  });
}

export async function subscribeWhenReady(redis: IORedis, ...channels: string[]): Promise<void> {
  await ensureRedisConnected(redis);
  await redis.subscribe(...channels);
}

export async function psubscribeWhenReady(redis: IORedis, ...patterns: string[]): Promise<void> {
  await ensureRedisConnected(redis);
  await redis.psubscribe(...patterns);
}
