import { Router } from "express";
import type IORedis from "ioredis";
import { cancelPfScan, createPfScanJob, getPfScanJobById, listPfScanJobs } from "../services/pfScanJob";
import { tenantFromRequest } from "../services/tenant";
import { requirePfAuth } from "../middleware/auth";
import { createRedisSubscriber, subscribeWhenReady } from "../services/redis";

export const pfScanRouter = Router();
pfScanRouter.use(requirePfAuth);

function normalizeScanType(raw: unknown): "sold" | "active" {
  return String(raw).trim().toLowerCase() === "active" ? "active" : "sold";
}

pfScanRouter.post("/", async (req, res) => {
  const seller = String(req.body?.seller ?? "").trim();
  if (!seller) return res.status(400).json({ error: "seller is required" });
  const scanType = normalizeScanType(req.body?.scanType);
  const daysBack = scanType === "active" ? 0 : Math.max(1, Number(req.body?.daysBack || 30));
  try {
    const out = await createPfScanJob({
      seller,
      scanType,
      daysBack,
      forceRefresh: Boolean(req.body?.forceRefresh),
      fetchPrices: req.body?.fetchPrices !== false,
      storeSettings:
        req.body?.storeSettings && typeof req.body.storeSettings === "object"
          ? req.body.storeSettings
          : {},
    });
    return res.json(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : "enqueue failed";
    return res.status(500).json({ error: message });
  }
});

pfScanRouter.get("/jobs", async (req, res) => {
  try {
    const status = String(req.query.status ?? "").trim() || undefined;
    const jobs = await listPfScanJobs(status);
    return res.json({ jobs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "list failed";
    return res.status(500).json({ error: message });
  }
});

pfScanRouter.post("/:id/cancel", async (req, res) => {
  try {
    const out = await cancelPfScan(String(req.params.id));
    return res.json(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : "cancel failed";
    return res.status(500).json({ error: message });
  }
});

pfScanRouter.get("/stream", async (req, res) => {
  const tenantId = tenantFromRequest(req);
  const jobId = String(req.query.jobId ?? "").trim();
  if (!jobId) {
    return res.status(400).json({ error: "jobId query param is required" });
  }
  const row = await getPfScanJobById(jobId);
  if (!row) return res.status(404).json({ error: "job not found" });

  let redis: IORedis | null = null;
  const channel = `pf:progress:${jobId}`;

  const send = (event: string, payload: unknown) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    redis = createRedisSubscriber(`pf-scan-stream:${jobId}`);

    redis.on("message", (_ch, message) => {
      try {
        send("progress", JSON.parse(message));
      } catch {
        send("progress", { jobId, raw: message });
      }
    });

    await subscribeWhenReady(redis, channel);
    send("ready", { jobId, tenantId, job: row });

    const ping = setInterval(() => {
      send("ping", { at: Date.now() });
    }, 15_000);

    req.on("close", () => {
      clearInterval(ping);
      void redis?.unsubscribe(channel).catch(() => undefined);
      void redis?.quit().catch(() => undefined);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[pf-scan-stream:${jobId}] subscribe failed: ${message}`);
    void redis?.quit().catch(() => undefined);
    if (!res.headersSent) {
      return res.status(503).json({ error: "Redis unavailable for progress stream" });
    }
    send("error", { error: "Redis unavailable", detail: message });
    res.end();
  }
});
