"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Layout } from "@/components/layout/Layout";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { AsinInput } from "@/components/ui/Input";
import { toast } from "sonner";
import { searchProduct } from "@/lib/api";
import { parseAsinsFromText } from "@/lib/asin";

const STATS = [
  { label: "Listings", key: "listings" },
  { label: "Active", key: "active" },
  { label: "Out of stock", key: "oos" },
  { label: "Orders", key: "orders" },
] as const;

export default function Dashboard() {
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const asins = useMemo(() => parseAsinsFromText(value), [value]);

  const handleSearch = async () => {
    if (asins.length === 0) return;
    setLoading(true);
    try {
      await searchProduct(asins[0]);
      toast.success("Product fetched");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // placeholder for future KPI fetch
  }, []);

  return (
    <Layout title="Home" breadcrumb="Home">
      <div className="page-section">
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.key} className="bg-surface px-5 py-4">
              <p className="label-caps">{s.label}</p>
              <p className="stat-value mt-1">0</p>
            </div>
          ))}
        </div>

        <Card className="p-6">
          <div className="mb-1 text-[14px] font-semibold text-text-primary">
            Add your first product
          </div>
          <p className="mb-4 text-[13px] text-text-tertiary">
            Paste an ASIN or Amazon product link. For many ASINs use{" "}
            <a
              href="/bulk"
              className="text-text-primary underline decoration-border-default underline-offset-4 transition-colors hover:decoration-text-primary"
            >
              Bulk upload
            </a>
            .
          </p>
          <div className="flex gap-2">
            <AsinInput
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="ASIN or Amazon link"
            />
            <Button onClick={handleSearch} disabled={loading || asins.length === 0}>
              {loading ? "Fetching…" : "Fetch"}
            </Button>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
            <h2 className="text-[14px] font-semibold text-text-primary">
              Recent listings
            </h2>
            <span className="text-[12px] text-text-tertiary">View all →</span>
          </div>
          <div className="px-5 py-10 text-center text-[13px] text-text-tertiary">
            No listings yet.
          </div>
        </Card>
      </div>
    </Layout>
  );
}
