"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import type { ProductFinderListing } from "@/lib/api";

const COLUMNS: Array<[string, (l: ProductFinderListing) => string | number]> = [
  ["Title", (l) => l.title],
  ["List price", (l) => l.list_price ?? l.sold_price ?? ""],
  ["Sold price", (l) => l.sold_price ?? ""],
  ["Qty sold", (l) => l.quantity_sold ?? ""],
  ["Sold date", (l) => l.sold_date ?? ""],
  ["ASIN", (l) => l.amazon_asin ?? ""],
  ["Amazon price", (l) => l.amazon_price ?? ""],
  ["Match confidence", (l) => (l.match_confidence != null ? l.match_confidence : "")],
  ["Net profit", (l) => (l.net_profit != null ? l.net_profit : "")],
  ["Margin %", (l) => (l.margin_percent != null ? l.margin_percent : "")],
  ["Seller", (l) => l.source_seller ?? ""],
  ["eBay URL", (l) => l.url],
];

function escapeCsv(value: string | number): string {
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(seller: string, listings: ProductFinderListing[]) {
  const header = COLUMNS.map(([h]) => escapeCsv(h)).join(",");
  const rows = listings.map((l) =>
    COLUMNS.map(([, fn]) => escapeCsv(fn(l))).join(",")
  );
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `product-finder-${seller}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportButton({
  seller,
  listings,
  totalCount,
  fetchAll,
}: {
  seller: string;
  listings: ProductFinderListing[];
  /** When set, export loads all server-filtered rows (not just the current page). */
  totalCount?: number;
  fetchAll?: () => Promise<ProductFinderListing[]>;
}) {
  const [exporting, setExporting] = useState(false);
  const exportAll = Boolean(fetchAll && totalCount != null && totalCount > listings.length);

  const exportCsv = async () => {
    setExporting(true);
    try {
      let rows = listings;
      if (exportAll && fetchAll) {
        toast.message(`Loading ${totalCount!.toLocaleString()} rows for export…`);
        rows = await fetchAll();
      }
      if (rows.length === 0) {
        toast.message("Nothing to export.");
        return;
      }
      downloadCsv(seller, rows);
      toast.success(`Exported ${rows.length.toLocaleString()} rows`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => void exportCsv()}
      disabled={listings.length === 0 || exporting}
      type="button"
    >
      {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      {exportAll ? `Export all CSV (${totalCount!.toLocaleString()})` : "Export CSV"}
    </Button>
  );
}
