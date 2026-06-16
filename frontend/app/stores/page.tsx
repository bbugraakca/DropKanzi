"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Layout } from "@/components/layout/Layout";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { getStores, deleteStore } from "@/lib/api";
import type { Store } from "@/lib/types";

export default function StoresPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const data = await getStores();
      setStores(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load stores");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleDelete = async (id: string) => {
    try {
      await deleteStore(id);
      toast.success("Store disconnected");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  return (
    <Layout title="Stores" breadcrumb="Home / Stores">
      <Card className="p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-semibold text-text-primary">
              Connected stores
            </div>
            <div className="text-sm text-text-muted">
              Manage connected eBay stores.
            </div>
          </div>
          <Link href="/stores/oauth">
            <Button variant="primary">Connect eBay</Button>
          </Link>
        </div>

        <div className="mt-5 border-t border-border">
          {loading ? (
            <div className="py-6 text-sm text-text-muted">Loading…</div>
          ) : stores.length === 0 ? (
            <div className="py-10 text-sm text-text-muted">
              No stores yet. Click “Connect eBay”.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {stores.map((s) => (
                <div key={s.id} className="py-4 flex items-center gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-text-primary truncate">
                      {s.ebayUsername}
                    </div>
                    <div className="text-xs text-text-muted">
                      {s.country} • {new Date(s.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <Link href={`/stores/${s.id}`}>
                    <Button variant="secondary">Open</Button>
                  </Link>
                  <Button
                    variant="danger"
                    onClick={() => handleDelete(s.id)}
                  >
                    Disconnect
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </Layout>
  );
}

