"use client";

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { bulkScrape, getJob, getProductsByAsins } from "@/lib/api";
import { parseAsinsFromText } from "@/lib/asin";
import type { Product } from "@/lib/types";

export function BulkUpload({
  onComplete,
  onJobStarted,
}: {
  onComplete?: (products: Product[]) => void;
  onJobStarted?: (jobId: string) => void;
}) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{
    jobId: string;
    done: number;
    total: number;
    failed: number;
    percent: number;
    status: string;
  } | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const asins = useMemo(() => parseAsinsFromText(text), [text]);

  const handleSubmit = async () => {
    if (asins.length === 0) {
      toast.error("Enter at least one ASIN");
      return;
    }
    if (asins.length > 1000) {
      toast.error("Maximum 1000 ASINs per batch");
      return;
    }

    setLoading(true);
    setProgress({
      jobId: "",
      done: 0,
      total: asins.length,
      failed: 0,
      percent: 0,
      status: "pending",
    });

    try {
      const { jobId } = await bulkScrape(asins);
      onJobStarted?.(jobId);
      setProgress({
        jobId,
        done: 0,
        total: asins.length,
        failed: 0,
        percent: 0,
        status: "running",
      });

      const poll = async () => {
        try {
          const job = await getJob(jobId);
          const processed = job.done + job.failed;
          setProgress({
            jobId,
            done: job.done,
            total: job.total,
            failed: job.failed,
            percent: job.percent ?? Math.round((processed / job.total) * 100),
            status: job.status,
          });

          if (job.status === "done" || job.status === "failed") {
            const { products } = await getProductsByAsins(asins);
            onComplete?.(products);
            toast.success(`Bulk scrape: ${job.done} ok, ${job.failed} failed`);
            setLoading(false);
            return;
          }

          pollRef.current = setTimeout(poll, 600);
        } catch {
          pollRef.current = setTimeout(poll, 1200);
        }
      };

      poll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk scrape failed");
      setLoading(false);
      setProgress(null);
    }
  };

  return (
    <div className="space-y-4">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="One ASIN per line, or comma-separated Amazon links / ASINs…"
        rows={10}
        className="w-full rounded-xl border border-border-subtle bg-surface p-4 font-mono text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/15 resize-y shadow-card"
        disabled={loading}
      />
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="text-sm text-text-muted">{asins.length} ASIN(s)</span>
        <Button type="button" onClick={handleSubmit} disabled={loading || asins.length === 0}>
          {loading ? "Scraping…" : "Start bulk scrape"}
        </Button>
      </div>
      {progress ? (
        <div className="space-y-2 rounded-xl border border-border-subtle bg-surface-muted p-4">
          <div className="flex justify-between text-sm">
            <span className="text-text-muted">
              Job <span className="font-mono text-text-primary">{progress.jobId || "…"}</span>
            </span>
            <span className="capitalize text-text-primary">{progress.status}</span>
          </div>
          <div className="flex justify-between text-sm text-text-muted">
            <span>
              {progress.done} ok · {progress.failed} failed · {progress.total} total
            </span>
            <span>{progress.percent}%</span>
          </div>
          <div className="h-2 rounded-full bg-surface border border-border-subtle overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
