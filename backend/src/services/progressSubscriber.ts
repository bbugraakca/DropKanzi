import { prisma } from "./db";
import { Prisma } from "@prisma/client";
import { createRedisClient } from "./redis";

let started = false;

export function startPfProgressSubscriber() {
  if (started) return;
  started = true;
  const sub = createRedisClient("pf-progress-subscriber");
  const pattern = "pf:progress:*";
  void sub
    .connect()
    .then(() => sub.psubscribe(pattern))
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[pf-progress-subscriber] subscribe failed: ${message}`);
      await sub.quit().catch(() => undefined);
    });

  sub.on("pmessage", (_pattern, channel, message) => {
    const jobId = channel.split("pf:progress:")[1];
    if (!jobId) return;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(message) as Record<string, unknown>;
    } catch {
      payload = { raw: message };
    }
    const stage = typeof payload.stage === "string" ? payload.stage : undefined;
    const status = typeof payload.status === "string" ? payload.status : undefined;
    void prisma.pfScanJob
      .update({
        where: { id: jobId },
        data: {
          ...(stage ? { stage } : {}),
          ...(status ? { status } : {}),
          progress: payload as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
  });
}
