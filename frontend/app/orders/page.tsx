"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  Clock,
  PackageCheck,
  Truck,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Layout } from "@/components/layout/Layout";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { getOrders, syncOrders, getStores, updateOrder } from "@/lib/api";
import { useAppStore } from "@/lib/store/appStore";
import type { OrderRow, Store } from "@/lib/types";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

function StatusPill({ status }: { status: string }) {
  const s = String(status || "");
  const base =
    "inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md font-medium ring-1 ring-inset";
  if (s === "delivered") {
    return (
      <span className={`${base} bg-emerald-50 text-emerald-800 ring-emerald-600/10`}>
        <BadgeCheck className="w-3 h-3" /> Delivered
      </span>
    );
  }
  if (s === "tracking") {
    return (
      <span className={`${base} bg-sky-50 text-sky-800 ring-sky-600/10`}>
        <Truck className="w-3 h-3" /> Tracking
      </span>
    );
  }
  if (s === "ordered") {
    return (
      <span className={`${base} bg-amber-50 text-amber-900 ring-amber-600/10`}>
        <PackageCheck className="w-3 h-3" /> Ordered
      </span>
    );
  }
  return (
    <span className={`${base} bg-accent text-foreground/70 ring-black/[0.04]`}>
      <Clock className="w-3 h-3" /> Received
    </span>
  );
}

function money(n: number | null | undefined) {
  if (n == null) return "—";
  return `$${Number(n).toFixed(2)}`;
}

export default function OrdersPage() {
  const { activeStoreId, setActiveStoreId } = useAppStore();
  const [stores, setStores] = useState<Store[]>([]);
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const activeStore = useMemo(
    () => stores.find((s) => s.id === activeStoreId) || null,
    [stores, activeStoreId]
  );

  const loadStores = async () => {
    const s = await getStores();
    setStores(s);
    if (!activeStoreId && s[0]?.id) setActiveStoreId(s[0].id);
  };

  const loadOrders = async (storeId: string) => {
    setLoading(true);
    try {
      const data = await getOrders(storeId);
      setRows(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load orders");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStores().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeStoreId) return;
    loadOrders(activeStoreId).catch(() => undefined);
  }, [activeStoreId]);

  const doSync = async () => {
    if (!activeStoreId) return toast.error("Select a store first");
    setSyncing(true);
    try {
      const r = await syncOrders(activeStoreId);
      toast.success(`Synced (${r.upserted})`);
      await loadOrders(activeStoreId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const saveRow = async (id: string, patch: Partial<OrderRow>) => {
    if (!activeStoreId) return;
    setSavingId(id);
    try {
      const updated = await updateOrder(activeStoreId, id, {
        notes: typeof patch.notes === "string" ? patch.notes : undefined,
        sourceOrderUrl:
          typeof patch.sourceOrderUrl === "string" ? patch.sourceOrderUrl : undefined,
        carrier: typeof patch.carrier === "string" ? patch.carrier : undefined,
        tracking: typeof patch.tracking === "string" ? patch.tracking : undefined,
        status:
          patch.status === "received_not_ordered" ||
          patch.status === "ordered" ||
          patch.status === "tracking" ||
          patch.status === "delivered"
            ? patch.status
            : undefined,
      });
      setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
      toast.success("Saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <Layout
      title="Orders"
      breadcrumb="Operations"
      description={
        activeStore
          ? `Managing orders for ${activeStore.ebayUsername}. Sync from eBay or update fulfillment manually.`
          : "Select a store in the sidebar to view orders."
      }
    >
      <Card className="p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-medium text-foreground">
              Order queue
            </div>
            <div className="text-[13px] text-muted-foreground mt-0.5">
              {activeStore ? activeStore.ebayUsername : "No store selected"}
            </div>
          </div>
          <Button variant="secondary" onClick={doSync} disabled={syncing || !activeStoreId}>
            <RefreshCw className="w-4 h-4" />
            {syncing ? "Syncing…" : "Sync eBay"}
          </Button>
        </div>

        <div className="mt-6 border-t border-border/80">
          {loading ? (
            <div className="py-12 text-[13px] text-muted-foreground animate-pulse">
              Loading orders…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-[13px] text-muted-foreground">
                No orders yet.
              </p>
              <p className="text-[12px] text-muted-foreground/80 mt-1">
                Connect eBay and sync to import your latest sales.
              </p>
            </div>
          ) : (
            <div className="overflow-auto -mx-1 px-1">
              <table className="min-w-[1200px] w-full text-[13px]">
                <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr className="border-b border-border/80">
                    <th className="text-left py-3 pr-3">Title</th>
                    <th className="text-left py-3 pr-3">Status</th>
                    <th className="text-left py-3 pr-3">Notes</th>
                    <th className="text-left py-3 pr-3">Target</th>
                    <th className="text-left py-3 pr-3">Buyer</th>
                    <th className="text-left py-3 pr-3">Qty</th>
                    <th className="text-left py-3 pr-3">Paid</th>
                    <th className="text-left py-3 pr-3">Source</th>
                    <th className="text-left py-3 pr-3">Price</th>
                    <th className="text-left py-3 pr-3">Profit</th>
                    <th className="text-left py-3 pr-3">Source Order</th>
                    <th className="text-left py-3 pr-3">Carrier</th>
                    <th className="text-left py-3 pr-3">Tracking</th>
                    <th className="text-left py-3 pr-3">Store</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.id} className="align-top">
                      <td className="py-3 pr-3">
                        <div className="flex gap-3">
                          <div className="h-10 w-10 rounded-[8px] bg-surface border border-border overflow-hidden shrink-0">
                            {r.image ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={r.image} alt="" className="h-full w-full object-cover" />
                            ) : null}
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium text-text-primary line-clamp-2">
                              {r.title}
                            </div>
                            <div className="text-xs text-text-muted font-mono">
                              {r.ebayOrderId}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="space-y-2">
                          <StatusPill status={r.status} />
                          <Select
                            value={r.status}
                            onChange={(e) =>
                              setRows((prev) =>
                                prev.map((x) =>
                                  x.id === r.id ? { ...x, status: e.target.value } : x
                                )
                              )
                            }
                          >
                            <option value="received_not_ordered">Received (not ordered)</option>
                            <option value="ordered">Ordered</option>
                            <option value="tracking">Tracking</option>
                            <option value="delivered">Delivered</option>
                          </Select>
                          <Button
                            variant="secondary"
                            className="h-8 px-2.5 text-xs"
                            disabled={savingId === r.id}
                            onClick={() => saveRow(r.id, { status: r.status })}
                            type="button"
                          >
                            {savingId === r.id ? "Saving…" : "Save status"}
                          </Button>
                        </div>
                      </td>
                      <td className="py-3 pr-3 text-text-muted">
                        <div className="space-y-2">
                          <Input
                            value={r.notes || ""}
                            placeholder="Notes…"
                            onChange={(e) =>
                              setRows((prev) =>
                                prev.map((x) =>
                                  x.id === r.id ? { ...x, notes: e.target.value } : x
                                )
                              )
                            }
                          />
                          <Button
                            variant="secondary"
                            className="h-8 px-2.5 text-xs"
                            disabled={savingId === r.id}
                            onClick={() => saveRow(r.id, { notes: r.notes || "" })}
                            type="button"
                          >
                            {savingId === r.id ? "Saving…" : "Save notes"}
                          </Button>
                        </div>
                      </td>
                      <td className="py-3 pr-3">
                        {r.targetUrl ? (
                          <Link
                            className="inline-flex items-center gap-1 text-accent hover:underline"
                            href={r.targetUrl}
                            target="_blank"
                          >
                            Open <ExternalLink className="w-3 h-3" />
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-3 pr-3">{r.buyer || "—"}</td>
                      <td className="py-3 pr-3">{r.qty}</td>
                      <td className="py-3 pr-3">{money(r.paidAmount)}</td>
                      <td className="py-3 pr-3">
                        {r.sourceUrl ? (
                          <Link
                            className="inline-flex items-center gap-1 text-accent hover:underline"
                            href={r.sourceUrl}
                            target="_blank"
                          >
                            Amazon <ExternalLink className="w-3 h-3" />
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-3 pr-3">
                        <div className="text-text-primary">{money(r.price)}</div>
                        <div className="text-xs text-text-muted">
                          Amazon: {money(r.amazonPrice)}
                        </div>
                      </td>
                      <td className="py-3 pr-3 font-mono">
                        {money(r.profit)}
                      </td>
                      <td className="py-3 pr-3">
                        <div className="space-y-2">
                          <Input
                            value={r.sourceOrderUrl || ""}
                            placeholder="Amazon order link…"
                            onChange={(e) =>
                              setRows((prev) =>
                                prev.map((x) =>
                                  x.id === r.id ? { ...x, sourceOrderUrl: e.target.value } : x
                                )
                              )
                            }
                          />
                          <div className="flex gap-2">
                            <Button
                              variant="secondary"
                              className="h-8 px-2.5 text-xs"
                              disabled={savingId === r.id}
                              onClick={() => saveRow(r.id, { sourceOrderUrl: r.sourceOrderUrl || "" })}
                              type="button"
                            >
                              {savingId === r.id ? "Saving…" : "Save"}
                            </Button>
                            {r.sourceOrderUrl ? (
                              <Link
                                className="inline-flex items-center gap-1 text-accent hover:underline text-xs"
                                href={r.sourceOrderUrl}
                                target="_blank"
                              >
                                Open <ExternalLink className="w-3 h-3" />
                              </Link>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="space-y-2">
                          <Input
                            value={r.carrier || ""}
                            placeholder="Carrier…"
                            onChange={(e) =>
                              setRows((prev) =>
                                prev.map((x) =>
                                  x.id === r.id ? { ...x, carrier: e.target.value } : x
                                )
                              )
                            }
                          />
                          <Button
                            variant="secondary"
                            className="h-8 px-2.5 text-xs"
                            disabled={savingId === r.id}
                            onClick={() => saveRow(r.id, { carrier: r.carrier || "" })}
                            type="button"
                          >
                            {savingId === r.id ? "Saving…" : "Save"}
                          </Button>
                        </div>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="space-y-2">
                          <Input
                            value={r.tracking || ""}
                            placeholder="Tracking…"
                            onChange={(e) =>
                              setRows((prev) =>
                                prev.map((x) =>
                                  x.id === r.id ? { ...x, tracking: e.target.value } : x
                                )
                              )
                            }
                          />
                          <Button
                            variant="secondary"
                            className="h-8 px-2.5 text-xs"
                            disabled={savingId === r.id}
                            onClick={() => saveRow(r.id, { tracking: r.tracking || "" })}
                            type="button"
                          >
                            {savingId === r.id ? "Saving…" : "Save"}
                          </Button>
                        </div>
                      </td>
                      <td className="py-3 pr-3">{activeStore?.ebayUsername || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </Layout>
  );
}

