import { Router } from "express";
import { prisma } from "../services/db";
import { enqueueBulkJob } from "../services/queue";
import { extractAsin } from "../services/productService";

export const bulkRouter = Router();

bulkRouter.post("/", async (req, res) => {
  try {
    const { asins } = req.body;
    if (!Array.isArray(asins) || asins.length === 0) {
      return res.status(400).json({ error: "asins array is required" });
    }
    if (asins.length > 1000) {
      return res.status(400).json({ error: "Maximum 1000 ASINs per request" });
    }

    const normalized: string[] = [];
    for (const a of asins) {
      const v = extractAsin(String(a));
      if (!v) {
        return res.status(400).json({ error: `Invalid ASIN: ${a}` });
      }
      normalized.push(v);
    }

    const job = await prisma.scrapeJob.create({
      data: {
        total: normalized.length,
        asins: normalized,
        status: "pending",
      },
    });

    await enqueueBulkJob(job.id, normalized);

    await prisma.scrapeJob.update({
      where: { id: job.id },
      data: { status: "running" },
    });

    return res.json({ jobId: job.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[${new Date().toISOString()}] POST /bulk`, message);
    return res.status(500).json({ error: message });
  }
});
