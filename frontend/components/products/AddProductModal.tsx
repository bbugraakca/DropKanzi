"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import {
  bulkScrape,
  calculateListing,
  createListing,
  getFulfillmentPolicies,
  getJob,
  getPaymentPolicies,
  getProductsByAsins,
  getReturnPolicies,
  getStoreSettings,
  saveStoreSettingsKey,
} from "@/lib/api";
import { parseAsinsFromText } from "@/lib/asin";
import type { PolicyOption } from "@/lib/ebayPolicies";
import {
  MOCK_EBAY_POLICY_IDS,
  loadSavedPolicyIds,
  parseFulfillmentPolicies,
  parsePaymentPolicies,
  parseReturnPolicies,
  savePolicyIds,
} from "@/lib/ebayPolicies";
import { runProductCompliance } from "@/lib/productCompliance";
import type { Product } from "@/lib/types";
import { cn } from "@/lib/utils";

type RowStatus = "pending" | "ready" | "publishing" | "published" | "draft" | "error";

type BulkRow = {
  asin: string;
  product: Product | null;
  title: string;
  price: number;
  amazonPrice: number | null;
  selected: boolean;
  status: RowStatus;
  message?: string;
};

type Step = "import" | "review" | "done";

export function AddProductModal({
  open,
  onClose,
  storeId,
  onPublished,
  initialAsins,
}: {
  open: boolean;
  onClose: () => void;
  storeId: string | null;
  onPublished?: () => void;
  initialAsins?: string[];
}) {
  const [bulkText, setBulkText] = useState("");
  const [rows, setRows] = useState<BulkRow[]>([]);
  const [step, setStep] = useState<Step>("import");
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState<{
    percent: number;
    done: number;
    total: number;
    failed: number;
  } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [policiesLoading, setPoliciesLoading] = useState(false);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [paymentPolicies, setPaymentPolicies] = useState<PolicyOption[]>([]);
  const [returnPolicies, setReturnPolicies] = useState<PolicyOption[]>([]);
  const [fulfillmentPolicies, setFulfillmentPolicies] = useState<PolicyOption[]>([]);
  const [paymentPolicyId, setPaymentPolicyId] = useState("");
  const [returnPolicyId, setReturnPolicyId] = useState("");
  const [fulfillmentPolicyId, setFulfillmentPolicyId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState("New");

  const asins = useMemo(() => parseAsinsFromText(bulkText), [bulkText]);
  const readyRows = rows.filter((r) => r.status === "ready");
  const selectedCount = rows.filter((r) => r.selected && r.status === "ready").length;
  const publishedCount = rows.filter((r) => r.status === "published").length;

  const reset = () => {
    setBulkText("");
    setRows([]);
    setStep("import");
    setLoadProgress(null);
    if (pollRef.current) clearTimeout(pollRef.current);
  };

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    setRows([]);
    setStep("import");
    setLoadProgress(null);
    if (initialAsins && initialAsins.length > 0) {
      setBulkText(initialAsins.join(" "));
    }
  }, [open, initialAsins]);

  useEffect(() => {
    if (!open || !storeId) return;

    getStoreSettings(storeId)
      .then((r) => {
        const s = r.settings || {};
        setSettings(s);
        const offer = s.offerSelection as { condition?: string } | undefined;
        if (offer?.condition && offer.condition !== "Any") {
          setCondition(String(offer.condition));
        }
        const repricing = (s.repricingSettings || s.salesCount) as
          | { quantityInStock?: number }
          | undefined;
        const stockQty = Number(repricing?.quantityInStock);
        if (stockQty > 0) setQuantity(stockQty);
        const defaults = s.listingDefaults as Record<string, string> | undefined;
        if (defaults?.paymentPolicyId) setPaymentPolicyId(String(defaults.paymentPolicyId));
        if (defaults?.returnPolicyId) setReturnPolicyId(String(defaults.returnPolicyId));
        if (defaults?.fulfillmentPolicyId) {
          setFulfillmentPolicyId(String(defaults.fulfillmentPolicyId));
        }
      })
      .catch(() => setSettings({}));

    const saved = loadSavedPolicyIds(storeId);
    setPaymentPolicyId((v) => v || saved.paymentPolicyId);
    setReturnPolicyId((v) => v || saved.returnPolicyId);
    setFulfillmentPolicyId((v) => v || saved.fulfillmentPolicyId);

    setPoliciesLoading(true);
    Promise.all([
      getPaymentPolicies(storeId),
      getReturnPolicies(storeId),
      getFulfillmentPolicies(storeId),
    ])
      .then(([pay, ret, ful]) => {
        const payList = parsePaymentPolicies(pay);
        const retList = parseReturnPolicies(ret);
        const fulList = parseFulfillmentPolicies(ful);
        setPaymentPolicies(payList);
        setReturnPolicies(retList);
        setFulfillmentPolicies(fulList);
        setPaymentPolicyId((cur) => cur || payList[0]?.id || MOCK_EBAY_POLICY_IDS.paymentPolicyId);
        setReturnPolicyId((cur) => cur || retList[0]?.id || MOCK_EBAY_POLICY_IDS.returnPolicyId);
        setFulfillmentPolicyId(
          (cur) => cur || fulList[0]?.id || MOCK_EBAY_POLICY_IDS.fulfillmentPolicyId
        );
      })
      .catch(() => {
        setPaymentPolicyId(MOCK_EBAY_POLICY_IDS.paymentPolicyId);
        setReturnPolicyId(MOCK_EBAY_POLICY_IDS.returnPolicyId);
        setFulfillmentPolicyId(MOCK_EBAY_POLICY_IDS.fulfillmentPolicyId);
      })
      .finally(() => setPoliciesLoading(false));
  }, [open, storeId]);

  const productToRow = async (
    p: Product,
    sid: string,
    storeSettingsSnapshot?: Record<string, unknown>
  ): Promise<BulkRow> => {
    const compliance = runProductCompliance(p, storeSettingsSnapshot ?? settings);
    if (compliance.blocked) {
      return {
        asin: p.asin,
        product: p,
        title: p.title || "",
        price: 0,
        amazonPrice: p.price != null ? Number(p.price) : null,
        selected: false,
        status: "error",
        message: compliance.summary,
      };
    }

    const amazon = p.price != null ? Number(p.price) : null;
    if (!amazon || amazon <= 0) {
      return {
        asin: p.asin,
        product: p,
        title: p.title || "",
        price: 0,
        amazonPrice: amazon,
        selected: false,
        status: "error",
        message: "No Amazon price",
      };
    }
    try {
      const draft = await calculateListing(sid, p.asin);
      return {
        asin: p.asin,
        product: p,
        title: draft.title,
        price: draft.price,
        amazonPrice: draft.amazonPrice,
        selected: true,
        status: draft.price > 0 ? "ready" : "error",
        message: draft.price > 0 ? undefined : "Price calculation failed",
      };
    } catch (e) {
      return {
        asin: p.asin,
        product: p,
        title: p.title || "",
        price: 0,
        amazonPrice: amazon,
        selected: false,
        status: "error",
        message: e instanceof Error ? e.message : "Calculate failed",
      };
    }
  };

  const handleLoadProducts = async () => {
    if (!storeId) return toast.error("Select a store first");
    if (asins.length === 0) return toast.error("Paste at least one ASIN");
    if (asins.length > 1000) return toast.error("Maximum 1000 ASINs");

    setLoading(true);
    setStep("import");
    setRows(
      asins.map((a) => ({
        asin: a,
        product: null,
        title: "",
        price: 0,
        amazonPrice: null,
        selected: true,
        status: "pending" as const,
      }))
    );
    setLoadProgress({ percent: 0, done: 0, total: asins.length, failed: 0 });

    try {
      const fresh = await getStoreSettings(storeId).catch(() => ({ settings: {} }));
      setSettings(fresh.settings || {});

      const { jobId } = await bulkScrape(asins);

      await new Promise<void>((resolve, reject) => {
        const poll = async () => {
          try {
            const job = await getJob(jobId);
            const processed = job.done + job.failed;
            setLoadProgress({
              percent: job.percent ?? Math.round((processed / job.total) * 100),
              done: job.done,
              total: job.total,
              failed: job.failed,
            });

            if (job.status === "done" || job.status === "failed") {
              const { products } = await getProductsByAsins(asins);
              const byAsin = new Map(products.map((p) => [p.asin, p]));
              const settingsSnap = fresh.settings || {};
              const built = await Promise.all(
                asins.map(async (a) => {
                  const p = byAsin.get(a);
                  if (!p) {
                    return {
                      asin: a,
                      product: null,
                      title: "",
                      price: 0,
                      amazonPrice: null,
                      selected: false,
                      status: "error" as const,
                      message: "Scrape failed or not in DB",
                    };
                  }
                  return productToRow(p, storeId, settingsSnap);
                })
              );
              setRows(built);
              setStep("review");
              const ready = built.filter((r) => r.status === "ready").length;
              toast.success(
                `${ready} ready to publish · ${built.length - ready} skipped (VeRO / price / scrape)`
              );
              resolve();
              return;
            }
            pollRef.current = setTimeout(poll, 1000);
          } catch (e) {
            reject(e);
          }
        };
        poll();
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Load failed");
      setRows([]);
      setStep("import");
    } finally {
      setLoading(false);
      setLoadProgress(null);
    }
  };

  const updateRow = (asin: string, patch: Partial<BulkRow>) => {
    setRows((prev) => prev.map((r) => (r.asin === asin ? { ...r, ...patch } : r)));
  };

  const toggleAllReady = (selected: boolean) => {
    setRows((prev) =>
      prev.map((r) => (r.status === "ready" ? { ...r, selected } : r))
    );
  };

  const recalcRowPrice = async (asin: string) => {
    if (!storeId) return;
    const row = rows.find((r) => r.asin === asin);
    if (!row?.product) return;
    try {
      const draft = await calculateListing(storeId, asin);
      updateRow(asin, {
        title: draft.title,
        price: draft.price,
        status: draft.price > 0 ? "ready" : "error",
        selected: draft.price > 0,
        message: draft.price > 0 ? undefined : "No price",
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Recalculate failed");
    }
  };

  const resolvePolicyIds = () => ({
    paymentPolicyId: paymentPolicyId || MOCK_EBAY_POLICY_IDS.paymentPolicyId,
    returnPolicyId: returnPolicyId || MOCK_EBAY_POLICY_IDS.returnPolicyId,
    fulfillmentPolicyId:
      fulfillmentPolicyId || MOCK_EBAY_POLICY_IDS.fulfillmentPolicyId,
  });

  const publishRows = async (targets: BulkRow[]) => {
    if (!storeId) return toast.error("Select a store first");
    const policies = resolvePolicyIds();

    setPublishing(true);
    let ok = 0;
    let fail = 0;

    for (const row of targets) {
      updateRow(row.asin, { status: "publishing" });
      try {
        const result = await createListing(storeId, {
          asin: row.asin,
          title: row.title,
          price: row.price,
          quantity,
          condition,
          ...policies,
          manualPrice: true,
          publish: true,
        });
        if (result.publishError) {
          updateRow(row.asin, {
            status: "draft",
            selected: false,
            message: result.publishError,
          });
          fail++;
        } else if (result.listing.status === "active") {
          updateRow(row.asin, {
            status: "published",
            selected: false,
            message: "Live on eBay",
          });
          ok++;
        } else {
          updateRow(row.asin, {
            status: "draft",
            selected: false,
            message: "Saved as draft",
          });
          ok++;
        }
      } catch (e) {
        updateRow(row.asin, {
          status: "error",
          selected: false,
          message: e instanceof Error ? e.message : "Failed",
        });
        fail++;
      }
    }

    savePolicyIds(storeId, policies);
    await saveStoreSettingsKey(storeId, "listingDefaults", policies).catch(
      () => undefined
    );

    setPublishing(false);
    setStep("done");

    if (ok > 0) {
      onPublished?.();
    }

    toast.success(`Published ${ok} · failed ${fail}`);

    if (fail === 0 && ok > 0 && ok === targets.length) {
      setTimeout(() => {
        onClose();
        reset();
      }, 600);
    }
  };

  const handlePublish = () => {
    const targets = rows.filter((r) => r.selected && r.status === "ready");
    if (targets.length === 0) {
      return toast.error("Select at least one ready product");
    }
    void publishRows(targets);
  };

  const allReadySelected =
    readyRows.length > 0 && readyRows.every((r) => r.selected);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add products"
      className="max-w-[min(1100px,96vw)] max-h-[92vh] flex flex-col p-0 overflow-hidden"
    >
      <div className="flex flex-col max-h-[calc(92vh-56px)]">
        <div className="flex-1 overflow-y-auto space-y-4 px-6 pt-4 pb-4">
          {!storeId ? (
            <Card className="p-4 bg-surface shadow-none">
              <div className="text-sm text-text-muted">Select a store first.</div>
            </Card>
          ) : (
            <>
              <p className="text-sm text-text-muted">
                Paste ASINs, load Amazon data, review VeRO and prices, then publish to
                eBay in one step — like Easync.
              </p>

              <Card className="p-4 bg-surface shadow-none space-y-3">
                <div className="text-sm font-medium text-text-primary">
                  eBay policies & defaults
                </div>
                {policiesLoading ? (
                  <div className="text-sm text-text-muted">Loading policies…</div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                    <div>
                      <div className="text-xs text-text-muted mb-1">Payment</div>
                      <Select
                        value={paymentPolicyId}
                        onChange={(e) => setPaymentPolicyId(e.target.value)}
                      >
                        <option value="">Mock / default</option>
                        {paymentPolicies.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <div className="text-xs text-text-muted mb-1">Return</div>
                      <Select
                        value={returnPolicyId}
                        onChange={(e) => setReturnPolicyId(e.target.value)}
                      >
                        <option value="">Mock / default</option>
                        {returnPolicies.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <div className="text-xs text-text-muted mb-1">Fulfillment</div>
                      <Select
                        value={fulfillmentPolicyId}
                        onChange={(e) => setFulfillmentPolicyId(e.target.value)}
                      >
                        <option value="">Mock / default</option>
                        {fulfillmentPolicies.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <div className="text-xs text-text-muted mb-1">Qty</div>
                      <Input
                        type="number"
                        min={1}
                        value={quantity}
                        onChange={(e) => setQuantity(Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <div className="text-xs text-text-muted mb-1">Condition</div>
                      <Select
                        value={condition}
                        onChange={(e) => setCondition(e.target.value)}
                      >
                        {["New", "Used", "Refurbished"].map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                )}
              </Card>

              {step === "import" ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium text-text-primary">
                    1. Import ASINs
                  </div>
                  <textarea
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                    rows={8}
                    disabled={loading}
                    placeholder="Paste up to 1000 ASINs or Amazon links&#10;B0XXXXXXXX&#10;https://amazon.com/dp/B0YYYYYYYY"
                    className="w-full rounded-[6px] border border-border bg-white p-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-[rgba(28,53,87,0.10)] focus:border-accent resize-y"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-text-muted">{asins.length} ASIN(s)</span>
                    <Button
                      type="button"
                      onClick={() => void handleLoadProducts()}
                      disabled={loading || asins.length === 0}
                    >
                      {loading ? "Loading…" : "Load products"}
                    </Button>
                  </div>
                  {loadProgress ? (
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs text-text-muted">
                        <span>
                          Scraping {loadProgress.done}/{loadProgress.total} (
                          {loadProgress.failed} failed)
                        </span>
                        <span>{loadProgress.percent}%</span>
                      </div>
                      <div className="h-2 rounded-full bg-surface border border-border overflow-hidden">
                        <div
                          className="h-full bg-accent transition-all"
                          style={{ width: `${loadProgress.percent}%` }}
                        />
                      </div>
                      <p className="text-xs text-text-muted">
                        VeRO, Prime, range repricing, fees, VAT, and listing template
                        run automatically after scrape.
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {rows.length > 0 && step !== "import" ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-medium text-text-primary">
                      2. Review & select
                    </div>
                    <div className="text-xs text-text-muted">
                      {readyRows.length} ready · {selectedCount} selected
                      {publishedCount > 0 ? ` · ${publishedCount} published` : ""}
                    </div>
                  </div>

                  <div className="overflow-auto border border-border rounded-[6px] max-h-[min(50vh,420px)]">
                    <table className="min-w-[900px] w-full text-sm">
                      <thead className="text-xs text-text-muted bg-surface border-b border-border sticky top-0 z-10">
                        <tr>
                          <th className="p-2 w-8">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-accent"
                              checked={allReadySelected}
                              disabled={readyRows.length === 0 || publishing}
                              onChange={(e) => toggleAllReady(e.target.checked)}
                              aria-label="Select all ready"
                            />
                          </th>
                          <th className="text-left p-2">ASIN</th>
                          <th className="text-left p-2 min-w-[200px]">Title</th>
                          <th className="text-left p-2">Amazon</th>
                          <th className="text-left p-2">eBay price</th>
                          <th className="text-left p-2 min-w-[120px]">VeRO / checks</th>
                          <th className="text-left p-2">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border bg-white">
                        {rows.map((r) => {
                          const compliance = r.product
                            ? runProductCompliance(r.product, settings)
                            : null;
                          const flagged = compliance?.blocked;
                          return (
                            <tr
                              key={r.asin}
                              className={cn(flagged && "bg-amber-50/80")}
                            >
                              <td className="p-2">
                                <input
                                  type="checkbox"
                                  checked={r.selected}
                                  disabled={r.status !== "ready" || publishing}
                                  onChange={(e) =>
                                    updateRow(r.asin, { selected: e.target.checked })
                                  }
                                  className="h-4 w-4 accent-accent"
                                />
                              </td>
                              <td className="p-2 font-mono text-xs">{r.asin}</td>
                              <td className="p-2">
                                <Input
                                  value={r.title}
                                  maxLength={80}
                                  disabled={r.status !== "ready" && r.status !== "draft"}
                                  onChange={(e) =>
                                    updateRow(r.asin, {
                                      title: e.target.value.slice(0, 80),
                                    })
                                  }
                                  className="h-8 text-xs"
                                />
                              </td>
                              <td className="p-2 font-mono text-xs">
                                {r.amazonPrice != null
                                  ? `$${r.amazonPrice.toFixed(2)}`
                                  : "—"}
                              </td>
                              <td className="p-2">
                                <div className="flex gap-1">
                                  <Input
                                    type="number"
                                    step="0.01"
                                    value={r.price}
                                    disabled={r.status !== "ready"}
                                    onChange={(e) =>
                                      updateRow(r.asin, { price: Number(e.target.value) })
                                    }
                                    className="h-8 w-24 text-xs font-mono"
                                  />
                                  {r.status === "ready" ? (
                                    <Button
                                      type="button"
                                      variant="secondary"
                                      className="h-8 px-2 text-xs"
                                      onClick={() => void recalcRowPrice(r.asin)}
                                    >
                                      ↻
                                    </Button>
                                  ) : null}
                                </div>
                              </td>
                              <td className="p-2 text-xs">
                                {compliance?.blocked ? (
                                  <div className="space-y-1">
                                    {compliance.veroHit ? (
                                      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] bg-dangerLight text-danger">
                                        VeRO
                                      </span>
                                    ) : null}
                                    {compliance.primeBlocked ? (
                                      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-900 ml-1">
                                        Prime
                                      </span>
                                    ) : null}
                                  </div>
                                ) : r.status === "ready" || r.status === "published" ? (
                                  <span className="text-emerald-700">OK</span>
                                ) : (
                                  <span className="text-text-muted">—</span>
                                )}
                              </td>
                              <td className="p-2 text-xs capitalize">
                                <span
                                  className={cn(
                                    r.status === "published" && "text-emerald-700 font-medium",
                                    r.status === "error" && "text-danger"
                                  )}
                                >
                                  {r.status}
                                </span>
                                {r.message ? (
                                  <span className="block text-[10px] normal-case text-text-muted line-clamp-2">
                                    {r.message}
                                  </span>
                                ) : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>

        {storeId ? (
          <div className="shrink-0 border-t border-border bg-surface-muted/50 px-6 py-4 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-text-muted">
              {step === "review" || step === "done"
                ? `${selectedCount} selected for publish`
                : "Load products to continue"}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={onClose} disabled={publishing}>
                {step === "done" && publishedCount > 0 ? "Done" : "Cancel"}
              </Button>
              {rows.length > 0 && step !== "import" ? (
                <Button
                  type="button"
                  onClick={handlePublish}
                  disabled={
                    publishing ||
                    selectedCount === 0 ||
                    policiesLoading ||
                    loading
                  }
                >
                  {publishing
                    ? "Publishing…"
                    : `Publish${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
