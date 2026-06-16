import { Router } from "express";
import { listPfScanJobs } from "../services/pfScanJob";

export const metricsRouter = Router();

metricsRouter.get("/", async (_req, res) => {
  try {
    const jobs = await listPfScanJobs();
    const queueDepth = jobs.filter((j) => j.status === "queued" || j.status === "active").length;
    const failed = jobs.filter((j) => j.status === "failed").length;
    const done = jobs.filter((j) => j.status === "done").length;
    return res.json({
      queue_depth: queueDepth,
      failed_jobs: failed,
      done_jobs: done,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "metrics unavailable";
    return res.status(503).json({
      error: "metrics unavailable",
      detail: message,
      queue_depth: 0,
      failed_jobs: 0,
      done_jobs: 0,
    });
  }
});
