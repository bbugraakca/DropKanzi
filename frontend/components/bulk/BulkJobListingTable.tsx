"use client";

import { ExternalLink } from "lucide-react";
import { formatBytes } from "@/lib/formatBytes";
import type { ItemScrapeStat, Listing, Product } from "@/lib/types";

export type BulkListingRow = {
  asin: string;
  product: Product | null;
  listing: Listing | null;
  scrapeStat?: ItemScrapeStat | null;
};

function money(n: number | null | undefined) {
  if (n == null) return "—";
  return `$${Number(n).toFixed(2)}`;
}

function amazonUrl(asin: string) {
  return `https://www.amazon.com/dp/${asin}`;
}

function ebayUrl(listing: Listing | null) {
  if (!listing?.ebayListingId) return null;
  return `https://www.ebay.com/itm/${listing.ebayListingId}`;
}

function rowStatus(product: Product | null, listing: Listing | null) {
  if (!product?.price && !listing) return "failed";
  if (listing?.status) return listing.status;
  if (product) return "scraped";
  return "—";
}

export function BulkJobListingTable({
  rows,
  loading,
  emptyMessage = "No items in this job.",
}: {
  rows: BulkListingRow[];
  loading?: boolean;
  emptyMessage?: string;
}) {
  if (loading) {
    return <div className="text-sm text-text-muted py-8 text-center">Loading…</div>;
  }

  if (rows.length === 0) {
    return <div className="text-sm text-text-muted py-8 text-center">{emptyMessage}</div>;
  }

  return (
    <div className="overflow-auto rounded-xl border border-border-subtle bg-surface shadow-card">
      <table className="min-w-[960px] w-full text-sm">
        <thead className="text-xs text-text-muted bg-surface-muted border-b border-border-subtle">
          <tr>
            <th className="text-left py-3 px-3 w-16">Photo</th>
            <th className="text-left py-3 px-3 min-w-[200px]">Title</th>
            <th className="text-left py-3 px-3 w-[100px]">ASIN</th>
            <th className="text-left py-3 px-3 w-[88px]">Source</th>
            <th className="text-left py-3 px-3 w-[88px]">Price</th>
            <th className="text-left py-3 px-3 w-[56px]">Qty</th>
            <th className="text-left py-3 px-3 w-[80px]">Status</th>
            <th className="text-left py-3 px-3 w-[72px]">Download</th>
            <th className="text-left py-3 px-3 w-[72px]">eBay</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle bg-surface">
          {rows.map((row) => {
            const p = row.product;
            const l = row.listing;
            const img = p?.images?.[0];
            const ebay = ebayUrl(l);
            const title = l?.title || p?.title || "—";
            const sourcePrice = p?.price ?? null;
            const ebayPrice = l?.price ?? null;
            const qty = l?.quantity;

            return (
              <tr key={row.asin} className="align-middle">
                <td className="py-3 px-3">
                  {img ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={img}
                      alt=""
                      className="w-12 h-12 object-contain rounded-lg border border-border-subtle bg-surface-muted"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-lg border border-dashed border-border-subtle bg-surface-muted" />
                  )}
                </td>
                <td className="py-3 px-3 font-medium text-text-primary max-w-[280px]">
                  <span className="line-clamp-2">{title}</span>
                </td>
                <td className="py-3 px-3 font-mono text-xs">{row.asin}</td>
                <td className="py-3 px-3 font-mono text-xs text-text-body">
                  {money(sourcePrice)}
                </td>
                <td className="py-3 px-3 font-mono text-xs">{money(ebayPrice)}</td>
                <td className="py-3 px-3 text-text-body">{qty ?? "—"}</td>
                <td className="py-3 px-3 capitalize text-text-body text-xs">
                  {rowStatus(p, l)}
                </td>
                <td className="py-3 px-3 font-mono text-[10px] text-text-muted whitespace-nowrap">
                  {row.scrapeStat && row.scrapeStat.bytesDownloaded > 0
                    ? formatBytes(row.scrapeStat.bytesDownloaded)
                    : "—"}
                </td>
                <td className="py-3 px-3">
                  {ebay ? (
                    <a
                      href={ebay}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                    >
                      View
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : (
                    <a
                      href={amazonUrl(row.asin)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-text-muted hover:underline"
                    >
                      Amazon
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
