"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Layout } from "@/components/layout/Layout";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { getListings } from "@/lib/api";
import { useAppStore } from "@/lib/store/appStore";

export default function StoreDashboard({
  params,
}: {
  params: { storeId: string };
}) {
  const setActiveStoreId = useAppStore((s) => s.setActiveStoreId);
  const [listingTotal, setListingTotal] = useState(0);

  useEffect(() => {
    setActiveStoreId(params.storeId);
    getListings(params.storeId, { page: 1, limit: 1 })
      .then((r) => setListingTotal(r.total))
      .catch((e) => toast.error(e instanceof Error ? e.message : "Load failed"));
  }, [params.storeId, setActiveStoreId]);

  return (
    <Layout title="Store" breadcrumb={`Home / Stores / ${params.storeId}`}>
      <div className="space-y-6">
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-text-primary">
                Store dashboard
              </div>
              <div className="text-sm text-text-muted">
                Listings: {listingTotal}
              </div>
            </div>
            <div className="flex gap-2">
              <Link href={`/stores/${params.storeId}/listings`}>
                <Button variant="secondary">Listing</Button>
              </Link>
              <Link href={`/stores/${params.storeId}/settings`}>
                <Button variant="primary">Store Settings</Button>
              </Link>
            </div>
          </div>
        </Card>
      </div>
    </Layout>
  );
}

