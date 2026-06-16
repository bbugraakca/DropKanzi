"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { saveBulkJobNote } from "@/lib/api";
import { formatBytes } from "@/lib/formatBytes";
import type { ProductComplianceResult } from "@/lib/productCompliance";
import type { ItemScrapeStat, Listing, Product } from "@/lib/types";
import { cn } from "@/lib/utils";

export type BulkProductTableRow = {
  asin: string;
  product: Product | null;
  note: string;
  listing: Listing | null;
  compliance?: ProductComplianceResult | null;
  highlightConflicts?: boolean;
  scrapeStat?: ItemScrapeStat | null;
};

function amazonUrl(asin: string) {
  return `https://www.amazon.com/dp/${asin}`;
}

function ebayUrl(listing: Listing | null) {
  if (!listing?.ebayListingId) return null;
  return `https://www.ebay.com/itm/${listing.ebayListingId}`;
}

function productDescription(product: Product | null): string {
  if (!product) return "";
  if (product.description?.trim()) return product.description.trim();
  if (product.aboutText?.trim()) return product.aboutText.trim();
  if (product.bulletPoints?.length) return product.bulletPoints.join(" · ");
  return "";
}

function NoteCell({
  asin,
  value,
  jobId,
  onSaved,
}: {
  asin: string;
  value: string;
  jobId?: string | null;
  onSaved?: (asin: string, note: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const save = useCallback(async () => {
    if (!jobId || draft === value) return;
    setSaving(true);
    try {
      await saveBulkJobNote(jobId, asin, draft);
      onSaved?.(asin, draft);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Note save failed");
      setDraft(value);
    } finally {
      setSaving(false);
    }
  }, [asin, draft, jobId, onSaved, value]);

  return (
    <textarea
      className={cn(
        "w-full min-w-[140px] min-h-[52px] text-xs rounded-md border border-border bg-surface px-2 py-1.5",
        "resize-y focus:outline-none focus:ring-1 focus:ring-accent",
        saving && "opacity-60"
      )}
      placeholder="Vero / liste notu…"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void save()}
      disabled={!jobId || saving}
      title={jobId ? "Blur to save" : "Open a saved job to persist notes"}
    />
  );
}

export function BulkProductsTable({
  rows,
  jobId,
  onNoteSaved,
  loading,
  emptyMessage = "No products in this job.",
}: {
  rows: BulkProductTableRow[];
  jobId?: string | null;
  onNoteSaved?: (asin: string, note: string) => void;
  loading?: boolean;
  emptyMessage?: string;
}) {
  if (loading) {
    return <div className="text-sm text-text-muted py-8 text-center">Loading products…</div>;
  }

  if (rows.length === 0) {
    return <div className="text-sm text-text-muted py-8 text-center">{emptyMessage}</div>;
  }

  return (
    <div className="overflow-auto rounded-xl border border-border-subtle bg-surface shadow-card">
      <table className="min-w-[1100px] w-full text-sm">
        <thead className="text-xs text-text-muted bg-surface-muted border-b border-border-subtle">
          <tr>
            <th className="text-left py-2.5 px-3 w-[72px]">Photo</th>
            <th className="text-left py-2.5 px-3 min-w-[180px]">Title</th>
            <th className="text-left py-2.5 px-3 min-w-[200px]">Description</th>
            <th className="text-left py-2.5 px-3 w-[88px]">Source</th>
            <th className="text-left py-2.5 px-3 w-[88px]">Listing</th>
            <th className="text-left py-2.5 px-3 w-[80px]">Price</th>
            <th className="text-left py-2.5 px-3 w-[88px]">Download</th>
            <th className="text-left py-2.5 px-3 min-w-[140px]">VeRO / Prime</th>
            <th className="text-left py-2.5 px-3 min-w-[160px]">Notes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle bg-surface">
          {rows.map((row) => {
            const p = row.product;
            const img = p?.images?.[0];
            const desc = productDescription(p);
            const ebay = ebayUrl(row.listing);
            const listStatus = row.listing?.status;
            const compliance = row.compliance;
            const flagged =
              row.highlightConflicts !== false &&
              compliance &&
              (compliance.veroHit || compliance.primeBlocked);

            return (
              <tr
                key={row.asin}
                className={cn(
                  "align-top",
                  flagged && "bg-amber-50/80"
                )}
              >
                <td className="py-3 px-3">
                  {img ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={img}
                      alt=""
                      className="w-14 h-14 object-contain rounded border border-border bg-surface"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded border border-dashed border-border bg-surface flex items-center justify-center text-[10px] text-text-muted">
                      —
                    </div>
                  )}
                </td>
                <td className="py-3 px-3">
                  <div className="font-medium text-text-primary line-clamp-3">
                    {p?.title || "—"}
                  </div>
                  <div className="font-mono text-[10px] text-text-muted mt-1">{row.asin}</div>
                </td>
                <td className="py-3 px-3">
                  <p className="text-xs text-text-body line-clamp-4" title={desc || undefined}>
                    {desc || "—"}
                  </p>
                </td>
                <td className="py-3 px-3">
                  <a
                    href={amazonUrl(row.asin)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                  >
                    Amazon
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </td>
                <td className="py-3 px-3">
                  {ebay ? (
                    <a
                      href={ebay}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                    >
                      eBay
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : row.listing ? (
                    <span className="text-xs text-text-muted capitalize">
                      {listStatus || "draft"}
                    </span>
                  ) : (
                    <span className="text-xs text-text-muted">—</span>
                  )}
                </td>
                <td className="py-3 px-3 whitespace-nowrap">
                  {p?.price != null ? (
                    <span className="font-mono text-xs">${p.price.toFixed(2)}</span>
                  ) : (
                    <span className="text-text-muted">—</span>
                  )}
                </td>
                <td className="py-3 px-3 whitespace-nowrap">
                  {row.scrapeStat && row.scrapeStat.bytesDownloaded > 0 ? (
                    <span className="font-mono text-[10px] text-text-body">
                      {formatBytes(row.scrapeStat.bytesDownloaded)}
                      {row.scrapeStat.fetchType ? (
                        <span className="block text-text-muted font-sans">
                          {row.scrapeStat.fetchType}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-xs text-text-muted">—</span>
                  )}
                </td>
                <td className="py-3 px-3">
                  {compliance?.blocked ? (
                    <div className="space-y-1">
                      {compliance.veroHit ? (
                        <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium bg-dangerLight text-danger">
                          VeRO list
                        </span>
                      ) : null}
                      {compliance.primeBlocked ? (
                        <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-900">
                          Prime
                        </span>
                      ) : null}
                      <p className="text-[10px] text-text-body leading-snug line-clamp-4">
                        {compliance.summary}
                      </p>
                    </div>
                  ) : (
                    <span className="text-xs text-text-muted">OK</span>
                  )}
                </td>
                <td className="py-3 px-3">
                  <NoteCell
                    asin={row.asin}
                    value={row.note}
                    jobId={jobId}
                    onSaved={onNoteSaved}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
