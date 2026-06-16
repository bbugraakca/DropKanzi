"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { createDemoStore, getStores } from "@/lib/api";
import { STORE_SETTINGS_CATALOG } from "@/lib/storeSettingsMeta";
import { useAppStore } from "@/lib/store/appStore";

export default function SettingsEntryPage() {
  const router = useRouter();
  const { activeStoreId, setActiveStoreId } = useAppStore();
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [demoName, setDemoName] = useState("Demo Store");

  useEffect(() => {
    (async () => {
      try {
        const stores = await getStores();
        if (stores.length === 0) {
          setLoading(false);
          return;
        }
        const target =
          stores.find((s) => s.id === activeStoreId)?.id || stores[0].id;
        setActiveStoreId(target);
        router.replace(`/stores/${target}/settings`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to load stores");
        setLoading(false);
      }
    })();
  }, [activeStoreId, router, setActiveStoreId]);

  const startDemo = async () => {
    setCreating(true);
    try {
      const store = await createDemoStore(demoName.trim() || "Demo Store");
      setActiveStoreId(store.id);
      toast.success("Demo store created — configure all settings without eBay");
      router.push(`/stores/${store.id}/settings`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create demo store");
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <Layout title="Store Settings" breadcrumb="Home / Store Settings">
        <div className="text-sm text-text-muted py-8">Loading…</div>
      </Layout>
    );
  }

  return (
    <Layout title="Store Settings" breadcrumb="Home / Store Settings">
      <div className="max-w-[720px] space-y-6">
        <Card className="p-5 space-y-4">
          <div className="text-sm font-semibold text-text-primary">No store selected</div>
          <p className="text-sm text-text-muted">
            eBay OAuth is optional for now. Create a demo store to open every
            Store Settings screen (repricing, tracking, listing template) and save values to the
            database. Connect eBay later when your Developer keys are ready.
          </p>
          <div>
            <div className="text-xs text-text-muted mb-1">Store name (label only)</div>
            <Input
              value={demoName}
              onChange={(e) => setDemoName(e.target.value)}
              placeholder="Demo Store"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={startDemo} disabled={creating}>
              {creating ? "Creating…" : "Create demo store & open settings"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => router.push("/stores/oauth")}
            >
              eBay setup guide
            </Button>
          </div>
        </Card>

        <Card className="p-5">
          <div className="text-sm font-semibold text-text-primary mb-3">
            All Store Settings ({STORE_SETTINGS_CATALOG.length} pages)
          </div>
          <ul className="text-sm text-text-body space-y-2">
            {STORE_SETTINGS_CATALOG.map((s) => (
              <li key={s.href}>
                <span className="font-medium">{s.label}</span>
                <span className="text-text-muted"> — {s.summary}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </Layout>
  );
}
