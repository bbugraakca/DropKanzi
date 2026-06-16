"use client";

import { useMemo, useState } from "react";
import { Layout } from "@/components/layout/Layout";
import { BulkJobProductsPanel } from "@/components/bulk/BulkJobProductsPanel";
import { BulkProductsTable, type BulkProductTableRow } from "@/components/bulk/BulkProductsTable";
import { BulkUpload } from "@/components/BulkUpload";
import { BulkStatusPanel } from "@/components/bulk/BulkStatusPanel";
import { Card } from "@/components/ui/Card";
import { getAllListings } from "@/lib/api";
import { useAppStore } from "@/lib/store/appStore";
import type { Listing, Product } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function BulkPage() {
  const [tab, setTab] = useState<"upload" | "status">("upload");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const storeId = useAppStore((s) => s.activeStoreId);

  const uploadRows: BulkProductTableRow[] = useMemo(() => {
    const listingByAsin = new Map(listings.map((l) => [l.asin, l]));
    return products.map((p) => ({
      asin: p.asin,
      product: p,
      note: "",
      listing: listingByAsin.get(p.asin) ?? null,
    }));
  }, [products, listings]);

  const handleComplete = async (list: Product[]) => {
    setProducts(list);
    if (storeId) {
      try {
        const data = await getAllListings(storeId);
        setListings(data);
      } catch {
        setListings([]);
      }
    }
  };

  return (
    <Layout title="Bulk" breadcrumb="Home / Bulk">
      <div className="space-y-6 max-w-[1400px] min-h-[520px]">
        <div className="tabs-bar">
          {(
            [
              { id: "upload" as const, label: "Bulk upload" },
              { id: "status" as const, label: "Bulk status" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn("tab-item", tab === t.id && "tab-item-active")}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className={tab === "upload" ? undefined : "hidden"}>
          <div className="space-y-6">
            <Card className="p-5">
              <div className="text-sm font-semibold text-text-primary mb-1">
                Bulk Amazon scrape
              </div>
              <div className="text-sm text-text-muted mb-4">
                Paste ASINs or Amazon links (one per line or comma-separated). Products are
                saved to the database for use in Add Product and listings.
              </div>
              <BulkUpload
                onJobStarted={(id) => {
                  setActiveJobId(id);
                  setTab("status");
                }}
                onComplete={(list) => void handleComplete(list)}
              />
            </Card>

            {products.length > 0 ? (
              <Card className="p-5">
                <div className="text-sm font-semibold text-text-primary mb-1">
                  Last batch results ({products.length})
                </div>
                <div className="text-xs text-text-muted mb-4">
                  {activeJobId
                    ? "Notes are saved on the job — open Bulk status for the same job to edit notes later."
                    : "Run a scrape to attach notes to a job."}
                </div>
                {activeJobId ? (
                  <BulkJobProductsPanel jobId={activeJobId} />
                ) : (
                  <BulkProductsTable rows={uploadRows} />
                )}
              </Card>
            ) : null}
          </div>
        </div>

        <div className={tab === "status" ? undefined : "hidden"}>
          <BulkStatusPanel highlightJobId={activeJobId} autoRefresh />
        </div>
      </div>
    </Layout>
  );
}
