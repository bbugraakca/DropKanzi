"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink, RefreshCw, Tag } from "lucide-react";
import { toast } from "sonner";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Select";
import {
  calculateListing,
  createDemoStore,
  createListing,
  getAllListings,
  getProductsByAsins,
  getStores,
  priceCheckProduct,
} from "@/lib/api";
import { DEMO_PRODUCT_ASINS } from "@/lib/demoProducts";
import { formatBytes } from "@/lib/formatBytes";
import { MOCK_EBAY_POLICY_IDS } from "@/lib/ebayPolicies";
import { useAppStore } from "@/lib/store/appStore";
import type { Listing, Product, Store } from "@/lib/types";
import { cn } from "@/lib/utils";

type RowState = {
  checking: boolean;
  listing: boolean;
  lastKb: number | null;
  fetchType: string | null;
  error: string | null;
  listError: string | null;
};

function StockBadge({ product }: { product: Product | undefined }) {
  if (!product) return <span className="text-text-muted">—</span>;
  if (product.isInStock) {
    return (
      <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-800">
        In stock
      </span>
    );
  }
  const s = (product.stock || "").toLowerCase();
  if (s.includes("out of stock") || s.includes("unavailable")) {
    return (
      <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium bg-dangerLight text-danger">
        Out of stock
      </span>
    );
  }
  return (
    <span className="text-xs text-text-muted" title={product.stock || undefined}>
      {product.stock || "Unknown"}
    </span>
  );
}

function amazonUrl(asin: string) {
  return `https://www.amazon.com/dp/${asin}`;
}

function isDemoStore(store: Store) {
  return (store.settings as Record<string, unknown> | null)?.isDemo === true;
}

export function DemoProductListing() {
  const { activeStoreId, setActiveStoreId } = useAppStore();
  const [stores, setStores] = useState<Store[]>([]);
  const [listingsByAsin, setListingsByAsin] = useState<Map<string, Listing>>(new Map());
  const [products, setProducts] = useState<Map<string, Product>>(new Map());
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [loading, setLoading] = useState(true);
  const [checkingAll, setCheckingAll] = useState(false);
  const [listingAll, setListingAll] = useState(false);
  const [creatingStore, setCreatingStore] = useState(false);

  const asins = useMemo(() => [...DEMO_PRODUCT_ASINS], []);
  const asinSet = useMemo(() => new Set<string>(asins), [asins]);
  const activeStore = stores.find((s) => s.id === activeStoreId);

  const loadStores = useCallback(async () => {
    const data = await getStores();
    setStores(data);
    if (data.length > 0 && !activeStoreId) {
      setActiveStoreId(data[0].id);
    }
  }, [activeStoreId, setActiveStoreId]);

  const loadListings = useCallback(async (storeId: string) => {
    const list = await getAllListings(storeId);
    const map = new Map<string, Listing>();
    for (const l of list) {
      if (asinSet.has(l.asin)) map.set(l.asin, l);
    }
    setListingsByAsin(map);
  }, [asinSet]);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const { products: list } = await getProductsByAsins(asins);
      const map = new Map<string, Product>();
      for (const p of list) map.set(p.asin, p);
      setProducts(map);
      if (activeStoreId) await loadListings(activeStoreId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load products");
    } finally {
      setLoading(false);
    }
  }, [asins, activeStoreId, loadListings]);

  useEffect(() => {
    void loadStores().catch(() => undefined);
  }, [loadStores]);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  useEffect(() => {
    if (activeStoreId) void loadListings(activeStoreId).catch(() => undefined);
  }, [activeStoreId, loadListings]);

  const patchRow = (asin: string, patch: Partial<RowState>) => {
    setRowState((prev) => {
      const current: RowState = prev[asin] ?? {
        checking: false,
        listing: false,
        lastKb: null,
        fetchType: null,
        error: null,
        listError: null,
      };
      return { ...prev, [asin]: { ...current, ...patch } };
    });
  };

  const runPriceCheck = async (asin: string) => {
    patchRow(asin, { checking: true, error: null });
    try {
      const { product, meta } = await priceCheckProduct(asin);
      setProducts((prev) => new Map(prev).set(asin, product));
      patchRow(asin, {
        checking: false,
        lastKb: meta.bytes_downloaded,
        fetchType: meta.fetch_type,
        error: null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Price check failed";
      patchRow(asin, { checking: false, error: msg });
      toast.error(`${asin}: ${msg}`);
    }
  };

  const runPriceCheckAll = async () => {
    setCheckingAll(true);
    let totalBytes = 0;
    let ok = 0;
    for (const asin of asins) {
      patchRow(asin, { checking: true, error: null });
      try {
        const { product, meta } = await priceCheckProduct(asin);
        setProducts((prev) => new Map(prev).set(asin, product));
        totalBytes += meta.bytes_downloaded;
        ok++;
        patchRow(asin, {
          checking: false,
          lastKb: meta.bytes_downloaded,
          fetchType: meta.fetch_type,
          error: null,
        });
      } catch (e) {
        patchRow(asin, {
          checking: false,
          error: e instanceof Error ? e.message : "Failed",
        });
      }
    }
    setCheckingAll(false);
    toast.success(
      `Updated ${ok}/${asins.length} · total download ~${formatBytes(totalBytes)}`
    );
  };

  const listProduct = async (asin: string) => {
    if (!activeStoreId) {
      toast.error("Select a store first");
      return;
    }
    const p = products.get(asin);
    if (!p?.price) {
      toast.error("Run Price check first — need Amazon price");
      return;
    }

    patchRow(asin, { listing: true, listError: null });
    try {
      const draft = await calculateListing(activeStoreId, asin);
      const result = await createListing(activeStoreId, {
        asin,
        title: draft.title,
        price: draft.price,
        quantity: draft.quantity,
        condition: draft.condition,
        ...MOCK_EBAY_POLICY_IDS,
        publish: true,
      });

      if (result.publishError) {
        patchRow(asin, { listing: false, listError: result.publishError });
        toast.error(result.publishError);
        return;
      }

      setListingsByAsin((prev) => new Map(prev).set(asin, result.listing));
      patchRow(asin, { listing: false, listError: null });
      toast.success(`${asin} listed (mock eBay)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "List failed";
      patchRow(asin, { listing: false, listError: msg });
      toast.error(msg);
    }
  };

  const listAll = async () => {
    if (!activeStoreId) return toast.error("Select a store first");
    setListingAll(true);
    let ok = 0;
    for (const asin of asins) {
      const p = products.get(asin);
      if (!p?.price || listingsByAsin.has(asin)) continue;
      try {
        await listProduct(asin);
        ok++;
      } catch {
        // listProduct toasts
      }
    }
    setListingAll(false);
    if (ok > 0) toast.success(`Listed ${ok} product(s) — see Listing page`);
  };

  const createStore = async () => {
    setCreatingStore(true);
    try {
      const store = await createDemoStore("Demo Store");
      setActiveStoreId(store.id);
      await loadStores();
      toast.success("Demo store created — mock eBay policies ready");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create store");
    } finally {
      setCreatingStore(false);
    }
  };

  const totalLastKb = asins.reduce((sum, a) => sum + (rowState[a]?.lastKb ?? 0), 0);
  const listingsHref = activeStoreId ? `/stores/${activeStoreId}/listings` : null;

  return (
    <Layout title="Product listing (trial)" breadcrumb="Home / Products">
      <Card className="p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2 min-w-0 flex-1">
            <div className="text-sm font-semibold text-text-primary">
              {asins.length} demo products
            </div>
            <p className="text-sm text-text-muted max-w-xl">
              Price check = low-bandwidth AOD. <strong>List product</strong> uses mock eBay
              policies and saves to your store&apos;s Listing page (no real eBay API).
            </p>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs text-text-muted">Store</span>
              {stores.length > 0 ? (
                <Select
                  className="max-w-[220px] h-8 text-xs"
                  value={activeStoreId || ""}
                  onChange={(e) => setActiveStoreId(e.target.value)}
                >
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {(s.settings as { storeDisplayName?: string })?.storeDisplayName ||
                        s.ebayUsername}
                      {isDemoStore(s) ? " (demo)" : ""}
                    </option>
                  ))}
                </Select>
              ) : (
                <Button type="button" size="sm" onClick={() => void createStore()} disabled={creatingStore}>
                  {creatingStore ? "Creating…" : "Create demo store"}
                </Button>
              )}
              {listingsHref ? (
                <Link
                  href={listingsHref}
                  className="text-xs text-accent hover:underline font-medium"
                >
                  Open Listing page →
                </Link>
              ) : null}
            </div>

            {activeStore && isDemoStore(activeStore) ? (
              <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 max-w-xl">
                Mock policies: Payment, 30-day returns, free shipping — listings appear as
                active with a demo eBay item id.
              </p>
            ) : null}

            {totalLastKb > 0 ? (
              <p className="text-xs text-text-muted">
                Last price checks combined: ~{formatBytes(totalLastKb)}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2 shrink-0">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void loadProducts()}
              disabled={loading}
            >
              Reload
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void runPriceCheckAll()}
              disabled={checkingAll || loading || listingAll}
            >
              {checkingAll ? "Checking…" : "Price check all"}
            </Button>
            <Button
              type="button"
              onClick={() => void listAll()}
              disabled={listingAll || !activeStoreId || checkingAll}
            >
              {listingAll ? "Listing…" : "List all"}
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="py-10 text-sm text-text-muted text-center">Loading…</div>
        ) : (
          <div className="overflow-auto rounded-xl border border-border-subtle">
            <table className="min-w-[1100px] w-full text-sm">
              <thead className="text-xs text-text-muted bg-surface-muted border-b border-border-subtle">
                <tr>
                  <th className="text-left py-3 px-3 w-10">#</th>
                  <th className="text-left py-3 px-3 w-14">Photo</th>
                  <th className="text-left py-3 px-3 min-w-[200px]">Title</th>
                  <th className="text-left py-3 px-3 w-[96px]">ASIN</th>
                  <th className="text-left py-3 px-3 w-[72px]">Price</th>
                  <th className="text-left py-3 px-3 w-[88px]">Stock</th>
                  <th className="text-left py-3 px-3 w-[80px]">KB</th>
                  <th className="text-left py-3 px-3 w-[100px]">eBay</th>
                  <th className="text-left py-3 px-3 w-[200px]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle bg-surface">
                {asins.map((asin, idx) => {
                  const p = products.get(asin);
                  const st = rowState[asin];
                  const listing = listingsByAsin.get(asin);
                  const img = p?.images?.[0];
                  const busy = st?.checking || st?.listing;

                  return (
                    <tr key={asin} className="align-middle">
                      <td className="py-3 px-3 text-text-muted text-xs">{idx + 1}</td>
                      <td className="py-3 px-3">
                        {img ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={img}
                            alt=""
                            className="w-12 h-12 object-contain rounded border border-border-subtle"
                          />
                        ) : (
                          <div className="w-12 h-12 rounded border border-dashed border-border-subtle bg-surface-muted" />
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <div className="font-medium text-text-primary line-clamp-2">
                          {p?.title || listing?.title || (
                            <span className="text-text-muted font-normal text-xs">
                              Price check → List product
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-3">
                        <a
                          href={amazonUrl(asin)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-[10px] text-accent hover:underline"
                        >
                          {asin}
                        </a>
                      </td>
                      <td className="py-3 px-3 font-mono text-xs whitespace-nowrap">
                        {p?.price != null
                          ? `$${p.price.toFixed(2)}`
                          : listing?.price != null
                            ? `$${listing.price.toFixed(2)}`
                            : "—"}
                      </td>
                      <td className="py-3 px-3">
                        <StockBadge product={p} />
                      </td>
                      <td className="py-3 px-3 text-[10px] text-text-muted">
                        {st?.lastKb != null ? formatBytes(st.lastKb) : "—"}
                      </td>
                      <td className="py-3 px-3">
                        {listing ? (
                          <span
                            className={cn(
                              "inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium capitalize",
                              listing.status === "active"
                                ? "bg-emerald-50 text-emerald-800"
                                : "bg-surface-muted text-text-muted"
                            )}
                          >
                            {listing.status}
                          </span>
                        ) : (
                          <span className="text-xs text-text-muted">—</span>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <div className="flex flex-wrap gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="h-8 text-xs gap-1"
                            disabled={busy || checkingAll || listingAll}
                            onClick={() => void runPriceCheck(asin)}
                          >
                            <RefreshCw
                              className={cn("w-3 h-3", st?.checking && "animate-spin")}
                            />
                            Price
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="h-8 text-xs gap-1"
                            disabled={
                              busy ||
                              !activeStoreId ||
                              !!listing ||
                              p?.price == null
                            }
                            onClick={() => void listProduct(asin)}
                          >
                            <Tag className="w-3 h-3" />
                            {st?.listing ? "…" : listing ? "Listed" : "List"}
                          </Button>
                        </div>
                        {st?.error || st?.listError ? (
                          <p className="text-[10px] text-danger mt-1 line-clamp-2">
                            {st.error || st.listError}
                          </p>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Layout>
  );
}
