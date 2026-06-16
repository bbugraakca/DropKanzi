"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { BulkProductsTable, type BulkProductTableRow } from "@/components/bulk/BulkProductsTable";
import { getAllListings, getJob, getProductsByAsins, getStoreSettings } from "@/lib/api";
import {
  formatComplianceNote,
  runProductCompliance,
  type VeroBlacklistSettings,
} from "@/lib/productCompliance";
import { formatBytes } from "@/lib/formatBytes";
import { useAppStore } from "@/lib/store/appStore";
import type { Listing, ScrapeJob } from "@/lib/types";

export function BulkJobProductsPanel({
  jobId,
  onClose,
}: {
  jobId: string;
  onClose?: () => void;
}) {
  const storeId = useAppStore((s) => s.activeStoreId);
  const [job, setJob] = useState<ScrapeJob | null>(null);
  const [rows, setRows] = useState<BulkProductTableRow[]>([]);
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

      const [{ products }, listings, storeSettingsRes] = await Promise.all([
        getProductsByAsins(asins),
        storeId ? getAllListings(storeId).catch(() => [] as Listing[]) : Promise.resolve([] as Listing[]),
        storeId
          ? getStoreSettings(storeId).catch(() => ({ settings: {} }))
          : Promise.resolve({ settings: {} }),
      ]);

      const storeSettings = storeSettingsRes.settings || {};
      const vero = storeSettings.veroBlacklist as VeroBlacklistSettings | undefined;
      const highlightConflicts = vero?.highlightConflicts !== false;

      const productByAsin = new Map(products.map((p) => [p.asin, p]));
      const listingByAsin = new Map<string, Listing>();
      for (const l of listings) {
        if (!listingByAsin.has(l.asin)) listingByAsin.set(l.asin, l);
      }

      const notes = jobData.itemNotes ?? {};
      const stats = jobData.itemStats ?? {};
      const ordered: BulkProductTableRow[] = asins.map((asin) => {
        const product = productByAsin.get(asin) ?? null;
        const compliance = product
          ? runProductCompliance(product, storeSettings)
          : null;
        const autoNote = compliance ? formatComplianceNote(compliance) : "";
        const savedNote = notes[asin] ?? "";
        const note = savedNote.trim() ? savedNote : autoNote;
        return {
          asin,
          product,
          note,
          listing: listingByAsin.get(asin) ?? null,
          compliance,
          highlightConflicts,
          scrapeStat: stats[asin] ?? null,
        };
      });

      setRows(ordered);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load job products");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [jobId, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => {
    if (!job) return null;
    const parts = [`${job.done} ok`, `${job.failed} failed`, `${job.total} total`];
    if (job.totalBytesDownloaded && job.totalBytesDownloaded > 0) {
      parts.push(`total ${formatBytes(job.totalBytesDownloaded)}`);
    }
    return parts.join(" · ");
  }, [job]);

  const handleNoteSaved = useCallback((asin: string, note: string) => {
    setJob((j) =>
      j ? { ...j, itemNotes: { ...(j.itemNotes ?? {}), [asin]: note } } : j
    );
    setRows((prev) => prev.map((r) => (r.asin === asin ? { ...r, note } : r)));
  }, []);

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-semibold text-text-primary">Job products</div>
          <div className="text-xs text-text-muted font-mono mt-0.5">{jobId}</div>
          {summary ? <div className="text-xs text-text-muted mt-1">{summary}</div> : null}
          {!storeId ? (
            <div className="text-xs text-amber-700 mt-1">
              Select an active store (top bar) to show eBay listing links.
            </div>
          ) : null}
        </div>
        {onClose ? (
          <Button variant="secondary" type="button" onClick={onClose} className="shrink-0 px-2">
            <X className="w-4 h-4" />
          </Button>
        ) : null}
      </div>
      <BulkProductsTable
        rows={rows}
        jobId={jobId}
        loading={loading}
        onNoteSaved={handleNoteSaved}
        emptyMessage="No ASINs on this job yet."
      />
    </div>
  );
}
