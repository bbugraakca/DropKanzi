"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import {
  BulkJobListingTable,
  type BulkListingRow,
} from "@/components/bulk/BulkJobListingTable";
import { Button } from "@/components/ui/Button";
import { getAllListings, getJob, getProductsByAsins } from "@/lib/api";
import { formatBytes } from "@/lib/formatBytes";
import { useAppStore } from "@/lib/store/appStore";
import type { Listing, ScrapeJob } from "@/lib/types";

export function BulkJobListingsPanel({
  jobId,
  onClose,
  onTotalBytes,
}: {
  jobId: string;
  onClose?: () => void;
  onTotalBytes?: (jobId: string, bytes: number) => void;
}) {
  const storeId = useAppStore((s) => s.activeStoreId);
  const [job, setJob] = useState<ScrapeJob | null>(null);
  const [rows, setRows] = useState<BulkListingRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const jobData = await getJob(jobId);
      setJob(jobData);
      const asins = jobData.asins ?? [];
      if (asins.length === 0) {
        setRows([]);
        return;
      }

      const [{ products }, listings] = await Promise.all([
        getProductsByAsins(asins),
        storeId ? getAllListings(storeId).catch(() => [] as Listing[]) : Promise.resolve([] as Listing[]),
      ]);

      const productByAsin = new Map(products.map((p) => [p.asin, p]));
      const listingByAsin = new Map<string, Listing>();
      for (const l of listings) {
        if (!listingByAsin.has(l.asin)) listingByAsin.set(l.asin, l);
      }

      const stats = jobData.itemStats ?? {};
      const ordered: BulkListingRow[] = asins.map((asin) => ({
        asin,
        product: productByAsin.get(asin) ?? null,
        listing: listingByAsin.get(asin) ?? null,
        scrapeStat: stats[asin] ?? null,
      }));

      setRows(ordered);

      const rowSum = ordered.reduce(
        (sum, r) => sum + (r.scrapeStat?.bytesDownloaded ?? 0),
        0
      );
      const total = jobData.totalBytesDownloaded || rowSum;
      if (total > 0) onTotalBytes?.(jobId, total);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load job");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [jobId, storeId, onTotalBytes]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalBytes = useMemo(() => {
    const rowSum = rows.reduce((sum, r) => sum + (r.scrapeStat?.bytesDownloaded ?? 0), 0);
    return job?.totalBytesDownloaded || rowSum;
  }, [job, rows]);

  const summary = useMemo(() => {
    if (!job) return null;
    const parts = [`${job.done} ok`, `${job.failed} failed`, `${job.total} total`];
    if (totalBytes > 0) parts.push(formatBytes(totalBytes));
    return parts.join(" · ");
  }, [job, totalBytes]);

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-semibold text-text-primary">Job listings</div>
          <div className="text-xs text-text-muted font-mono mt-0.5">{jobId}</div>
          {summary ? <div className="text-xs text-text-muted mt-1">{summary}</div> : null}
          {totalBytes > 0 ? (
            <div className="text-xs font-medium text-text-primary mt-1">
              Total download: {formatBytes(totalBytes)}
            </div>
          ) : null}
        </div>
        {onClose ? (
          <Button variant="secondary" type="button" onClick={onClose} className="shrink-0 px-2">
            <X className="w-4 h-4" />
          </Button>
        ) : null}
      </div>
      <BulkJobListingTable rows={rows} loading={loading} />
    </div>
  );
}
