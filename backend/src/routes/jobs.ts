import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../services/db";
import { parseItemStats, sumItemStatsBytes } from "../utils/jobStats";

export const jobsRouter = Router();

function jobPayload(job: {
  id: string;
  status: string;
  total: number;
  done: number;
  failed: number;
  asins: string[];
  itemNotes: unknown;
  itemStats: unknown;
  totalBytesDownloaded?: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  const percent =
    job.total > 0 ? Math.round(((job.done + job.failed) / job.total) * 100) : 0;
  const notes =
    job.itemNotes && typeof job.itemNotes === "object" && !Array.isArray(job.itemNotes)
      ? (job.itemNotes as Record<string, string>)
      : {};
  const itemStats = parseItemStats(job.itemStats);
  const totalBytesDownloaded = Math.max(
    job.totalBytesDownloaded ?? 0,
    sumItemStatsBytes(itemStats)
  );
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    done: job.done,
    failed: job.failed,
    percent,
    asins: job.asins,
    itemNotes: notes,
    itemStats,
    totalBytesDownloaded,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

// GET /api/jobs — recent bulk scrape jobs
jobsRouter.get("/", async (_req, res) => {
  try {
    const jobs = await prisma.scrapeJob.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return res.json(jobs.map(jobPayload));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

jobsRouter.get("/:jobId", async (req, res) => {
  try {
    const job = await prisma.scrapeJob.findUnique({
      where: { id: req.params.jobId },
    });

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    return res.json(jobPayload(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[${new Date().toISOString()}] GET /jobs/:jobId`, message);
    return res.status(500).json({ error: message });
  }
});

// PATCH /api/jobs/:jobId/notes { asin, note }
jobsRouter.patch("/:jobId/notes", async (req, res) => {
  try {
    const { asin, note } = req.body as { asin?: string; note?: string };
    if (!asin) return res.status(400).json({ error: "asin is required" });

    const job = await prisma.scrapeJob.findUnique({
      where: { id: req.params.jobId },
    });
    if (!job) return res.status(404).json({ error: "Job not found" });

    const current =
      job.itemNotes && typeof job.itemNotes === "object" && !Array.isArray(job.itemNotes)
        ? { ...(job.itemNotes as Record<string, string>) }
        : {};

    if (note?.trim()) {
      current[asin] = note.trim();
    } else {
      delete current[asin];
    }

    const updated = await prisma.scrapeJob.update({
      where: { id: job.id },
      data: { itemNotes: current as Prisma.InputJsonValue },
    });

    return res.json(jobPayload(updated));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});
