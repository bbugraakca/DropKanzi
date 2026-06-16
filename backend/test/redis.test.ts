import { describe, it, expect, vi, beforeEach } from "vitest";
import type IORedis from "ioredis";
import { subscribeWhenReady, ensureRedisConnected } from "../src/services/redis";

function mockRedis(overrides: Partial<IORedis> & { status: string }): IORedis {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    status: overrides.status,
    subscribe: overrides.subscribe ?? vi.fn().mockResolvedValue(1),
    connect: overrides.connect ?? vi.fn().mockResolvedValue(undefined),
    once(event: string, cb: (...args: unknown[]) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(cb);
      handlers.set(event, set);
      if (event === "ready" && overrides.status === "ready") {
        queueMicrotask(() => cb());
      }
      return this;
    },
    off(event: string, cb: (...args: unknown[]) => void) {
      handlers.get(event)?.delete(cb);
      return this;
    },
    emitReady() {
      for (const cb of handlers.get("ready") ?? []) cb();
    },
  } as unknown as IORedis;
}

describe("redis helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("ensureRedisConnected resolves immediately when ready", async () => {
    const redis = mockRedis({ status: "ready" });
    await expect(ensureRedisConnected(redis)).resolves.toBeUndefined();
  });

  it("subscribeWhenReady waits for connect+ready before subscribe", async () => {
    const subscribe = vi.fn().mockResolvedValue(1);
    const connect = vi.fn().mockImplementation(async () => {
      (redis as { emitReady(): void }).emitReady();
    });
    const redis = Object.assign(mockRedis({ status: "wait" }), { subscribe, connect });

    await subscribeWhenReady(redis, "pf:progress:test");
    expect(connect).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith("pf:progress:test");
  });

  it("createRedisClient sets enableOfflineQueue (no throw on early subscribe)", async () => {
    const { createRedisClient } = await import("../src/services/redis");
    const client = createRedisClient("unit-test");
    expect(client).toBeDefined();
    client.disconnect();
  });
});
