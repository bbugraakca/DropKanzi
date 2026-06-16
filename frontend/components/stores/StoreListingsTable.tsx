"use client";

import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Package,
  RefreshCw,
  Search,
  ShoppingBag,
  TrendingUp,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Layout } from "@/components/layout/Layout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import {
  applyRepricingToAllListings,
  getAllListings,
  getListings,
  getOrders,
  getStoreSettings,
  priceCheckProduct,
} from "@/lib/api";
import { formatBytes } from "@/lib/formatBytes";
import { useAppStore } from "@/lib/store/appStore";
import type { Listing, OrderRow, Product } from "@/lib/types";
import { cn } from "@/lib/utils";

type RowState = {
  checking: boolean;
  error: string | null;
};

type UnifiedRow = {
  asin: string;
  product: Product | null;
  listing: Listing | null;
  soldCount: number;
  lastSaleAt: string | null;
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

function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function buildOrderStats(orders: OrderRow[]) {
  const byAsin = new Map<string, { sold: number; lastSaleAt: string | null }>();
  for (const o of orders) {
    const asin = o.asin?.trim();
    if (!asin) continue;
    const cur = byAsin.get(asin) ?? { sold: 0, lastSaleAt: null };
    cur.sold += o.qty || 1;
    if (!cur.lastSaleAt || new Date(o.createdAt) > new Date(cur.lastSaleAt)) {
      cur.lastSaleAt = o.createdAt;
    }
    byAsin.set(asin, cur);
  }
  return byAsin;
}

const PAGE_SIZE_KEY = "dropkanzi.listingsPageSize";
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

function readPageSize(): number {
  if (typeof window === "undefined") return 50;
  try {
    const n = parseInt(window.localStorage.getItem(PAGE_SIZE_KEY) || "50", 10);
    return PAGE_SIZE_OPTIONS.includes(n as (typeof PAGE_SIZE_OPTIONS)[number])
      ? n
      : 50;
  } catch {
    return 50;
  }
}

function ListingStatusPill({ listing }: { listing: Listing | null }) {
  const live = !!listing?.ebayListingId || listing?.status === "active";
  const status = listing?.status || "draft";

  if (live) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium bg-emerald-50 text-emerald-800 ring-1 ring-emerald-600/15">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        Live
      </span>
    );
  }
  if (status === "draft") {
    return (
      <span className="inline-flex items-center text-[11px] px-2 py-0.5 rounded-full font-medium bg-surface-muted text-text-muted ring-1 ring-border">
        Draft
      </span>
    );
  }
  return (
    <span className="inline-flex items-center capitalize text-[11px] px-2 py-0.5 rounded-full font-medium bg-amber-50 text-amber-900 ring-1 ring-amber-600/15">
      {status}
    </span>
  );
}

function RepricingPill({
  enableRepricing,
  listing,
}: {
  enableRepricing: boolean;
  listing: Listing | null;
}) {
  if (!listing) return <span className="text-text-muted">—</span>;
  if (!enableRepricing) {
    return (
      <span className="text-[11px] text-text-muted px-2 py-0.5 rounded-full bg-surface-muted ring-1 ring-border">
        Off
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium bg-accent-light text-accent ring-1 ring-accent/20">
      <Zap className="w-3 h-3" />
      Active
    </span>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="surface-card px-5 py-4 flex items-start gap-4 min-h-[88px]">
      <div className="h-10 w-10 rounded-lg bg-accent-light flex items-center justify-center shrink-0">
        <Icon className="w-5 h-5 text-accent" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          {label}
        </p>
        <p className="text-2xl font-semibold tracking-tight text-foreground tabular-nums mt-0.5">
          {value}
        </p>
        {hint ? (
          <p className="text-xs text-muted-foreground mt-1 truncate">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="divide-y divide-border/80">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4 animate-pulse">
          <div className="w-14 h-14 rounded-lg bg-surface-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-2/5 rounded bg-surface-muted" />
            <div className="h-3 w-24 rounded bg-surface-muted" />
          </div>
          <div className="h-4 w-16 rounded bg-surface-muted hidden sm:block" />
          <div className="h-4 w-16 rounded bg-surface-muted hidden md:block" />
        </div>
      ))}
    </div>
  );
}

export function StoreListingsTable({ storeId }: { storeId: string }) {
  const setActiveStoreId = useAppStore((s) => s.setActiveStoreId);
  const listingsVersion = useAppStore((s) => s.listingsVersion);
  const [rows, setRows] = useState<UnifiedRow[]>([]);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [loading, setLoading] = useState(true);
  const [checkingAll, setCheckingAll] = useState(false);
  const [enableRepricing, setEnableRepricing] = useState(false);
  const [lastCheckTotalBytes, setLastCheckTotalBytes] = useState(0);
  const [applyingRepricing, setApplyingRepricing] = useState(false);
  const [query, setQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const bumpListingsVersion = useAppStore((s) => s.bumpListingsVersion);

  useEffect(() => {
    setPageSize(readPageSize());
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [listingsRes, orders, settingsRes] = await Promise.all([
        getListings(storeId, { page, limit: pageSize, q: query }),
        getOrders(storeId).catch(() => [] as OrderRow[]),
        getStoreSettings(storeId).catch(() => ({ id: storeId, settings: {} })),
      ]);

      const repricing = (settingsRes.settings?.repricingSettings ||
        settingsRes.settings?.salesCount) as { enableRepricing?: boolean } | undefined;
      setEnableRepricing(!!repricing?.enableRepricing);

      setTotal(listingsRes.total);
      setPages(listingsRes.pages);

      const orderStats = buildOrderStats(orders);
      const unified: UnifiedRow[] = listingsRes.listings.map((listing) => {
        const stats = orderStats.get(listing.asin);
        return {
          asin: listing.asin,
          product: listing.product ?? null,
          listing,
          soldCount: stats?.sold ?? 0,
          lastSaleAt: stats?.lastSaleAt ?? null,
        };
      });

      setRows(unified);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load listings");
      setRows([]);
      setTotal(0);
      setPages(1);
    } finally {
      setLoading(false);
    }
  }, [storeId, page, pageSize, query]);

  useEffect(() => {
    setActiveStoreId(storeId);
    void load();
  }, [storeId, setActiveStoreId, load, listingsVersion]);

  useEffect(() => {
    if (page > pages) setPage(Math.max(1, pages));
  }, [page, pages]);

  const patchRow = (asin: string, patch: Partial<RowState>) => {
    setRowState((prev) => {
      const current: RowState = prev[asin] ?? { checking: false, error: null };
      return { ...prev, [asin]: { ...current, ...patch } };
    });
  };

  const updateProduct = (product: Product) => {
    setRows((prev) =>
      prev.map((r) => (r.asin === product.asin ? { ...r, product } : r))
    );
  };

  const runPriceCheck = async (asin: string) => {
    patchRow(asin, { checking: true, error: null });
    try {
      const { product, meta } = await priceCheckProduct(asin);
      updateProduct(product);
      patchRow(asin, { checking: false, error: null });
      return meta.bytes_downloaded;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Price check failed";
      patchRow(asin, { checking: false, error: msg });
      toast.error(`${asin}: ${msg}`);
      return 0;
    }
  };

  const applyRepricing = async () => {
    setApplyingRepricing(true);
    try {
      const result = await applyRepricingToAllListings(storeId);
      bumpListingsVersion();
      void load();
      toast.success(
        `Repricing applied: ${result.updated} updated · ${result.skipped} skipped · ${result.failed} failed`
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Apply repricing failed");
    } finally {
      setApplyingRepricing(false);
    }
  };

  const runPriceCheckAll = async () => {
    setCheckingAll(true);
    try {
      const all = await getAllListings(storeId);
      let totalBytes = 0;
      let ok = 0;
      for (const listing of all) {
        const bytes = await runPriceCheck(listing.asin);
        if (bytes > 0) ok++;
        totalBytes += bytes;
      }
      setLastCheckTotalBytes(totalBytes);
      toast.success(
        `Price check ${ok}/${all.length} · ~${formatBytes(totalBytes)}`
      );
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Price check failed");
    } finally {
      setCheckingAll(false);
    }
  };

  const changePageSize = (next: number) => {
    setPageSize(next);
    setPage(1);
    try {
      window.localStorage.setItem(PAGE_SIZE_KEY, String(next));
    } catch {
      // ignore
    }
  };

  const pageStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const pageEnd = Math.min(page * pageSize, total);

  const listedCount = useMemo(
    () =>
      rows.filter(
        (r) => r.listing?.ebayListingId || r.listing?.status === "active"
      ).length,
    [rows]
  );

  const totalSold = useMemo(
    () => rows.reduce((s, r) => s + r.soldCount, 0),
    [rows]
  );

  return (
    <Layout
      title="Listing"
      breadcrumb="Store"
      description="Manage live eBay listings, source prices, and repricing."
      fullWidth
      flush
    >
      <div className="flex flex-col flex-1 min-h-[calc(100vh-5.5rem)] gap-5">
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 shrink-0">
          <StatCard
            label="Total listings"
            value={loading ? "—" : total}
            hint={
              total > 0
                ? `Page ${page} of ${pages} · ${pageSize} per page`
                : "All items in this store"
            }
            icon={Package}
          />
          <StatCard
            label="Live on eBay"
            value={loading ? "—" : listedCount}
            hint={
              total > 0
                ? `${Math.round((listedCount / rows.length) * 100) || 0}% on this page`
                : undefined
            }
            icon={ShoppingBag}
          />
          <StatCard
            label="Repricing"
            value={enableRepricing ? "On" : "Off"}
            hint="Store-wide setting"
            icon={Zap}
          />
          <StatCard
            label="Units sold"
            value={loading ? "—" : totalSold}
            hint={lastCheckTotalBytes > 0 ? `Last check ${formatBytes(lastCheckTotalBytes)}` : "From orders"}
            icon={TrendingUp}
          />
        </div>

        <div className="surface-card px-4 py-3 flex flex-wrap items-center gap-3 shrink-0">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search title or ASIN…"
              className="pl-9 h-10 bg-background/50"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground whitespace-nowrap">Per page</span>
            <Select
              className="w-[88px] h-9 text-xs"
              value={pageSize}
              onChange={(e) => changePageSize(Number(e.target.value))}
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-muted-foreground hidden sm:inline tabular-nums">
              {total > 0 ? `${pageStart}–${pageEnd} of ${total}` : "0 items"}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void load()}
              disabled={loading || checkingAll}
            >
              Reload
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void applyRepricing()}
              disabled={loading || checkingAll || applyingRepricing || rows.length === 0}
            >
              <RefreshCw
                className={cn("w-4 h-4", applyingRepricing && "animate-spin")}
              />
              {applyingRepricing ? "Applying…" : "Apply repricing"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void runPriceCheckAll()}
              disabled={loading || checkingAll || applyingRepricing || rows.length === 0}
            >
              <RefreshCw
                className={cn("w-4 h-4", checkingAll && "animate-spin")}
              />
              {checkingAll ? "Checking…" : "Price check all"}
            </Button>
          </div>
        </div>

        <div className="surface-card flex-1 min-h-[320px] flex flex-col overflow-hidden shadow-glow">
          {loading ? (
            <TableSkeleton />
          ) : total === 0 && !query ? (
            <div className="flex-1 flex flex-col items-center justify-center px-6 py-20 text-center">
              <div className="h-16 w-16 rounded-2xl bg-accent-light flex items-center justify-center mb-5">
                <Package className="w-8 h-8 text-accent" />
              </div>
              <h2 className="text-lg font-medium text-foreground">No listings yet</h2>
              <p className="text-sm text-muted-foreground mt-2 max-w-md leading-relaxed">
                Use <span className="font-medium text-foreground">Add product</span> in the
                sidebar to import ASINs, run checks, and publish — everything in one flow.
              </p>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-16 text-sm text-muted-foreground">
              No listings match &ldquo;{query}&rdquo;
            </div>
          ) : (
            <>
            <div className="flex-1 overflow-auto min-h-0">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 z-20 bg-card/95 backdrop-blur-sm border-b border-border shadow-[0_1px_0_0_hsl(var(--border))]">
                  <tr className="text-[11px] font-medium uppercase tracking-[0.05em] text-muted-foreground">
                    <th className="text-left py-3.5 pl-5 pr-3 min-w-[280px]">Product</th>
                    <th className="text-left py-3.5 px-3 w-[90px]">Source</th>
                    <th className="text-left py-3.5 px-3 w-[100px]">Listing</th>
                    <th className="text-right py-3.5 px-3 w-[100px]">Amazon</th>
                    <th className="text-right py-3.5 px-3 w-[100px]">eBay</th>
                    <th className="text-center py-3.5 px-3 w-[72px]">Qty</th>
                    <th className="text-left py-3.5 px-3 w-[110px]">Repricing</th>
                    <th className="text-left py-3.5 px-3 w-[100px]">Added</th>
                    <th className="text-left py-3.5 px-3 w-[100px]">Last sale</th>
                    <th className="text-center py-3.5 px-3 w-[64px]">Sold</th>
                    <th className="text-right py-3.5 pr-5 pl-3 w-[100px]">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {rows.map((row) => {
                    const { asin, product, listing } = row;
                    const st = rowState[asin];
                    const title = listing?.title || product?.title || asin;
                    const img = product?.images?.[0];
                    const ebay = ebayUrl(listing);
                    const margin =
                      product?.price != null &&
                      listing?.price != null &&
                      product.price > 0
                        ? ((listing.price - product.price) / product.price) * 100
                        : null;

                    return (
                      <tr
                        key={asin}
                        className="group align-middle hover:bg-surface-muted/60 transition-colors"
                      >
                        <td className="py-3.5 pl-5 pr-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="shrink-0 w-14 h-14 rounded-lg border border-border/80 bg-surface-muted overflow-hidden flex items-center justify-center">
                              {img ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={img}
                                  alt=""
                                  className="w-full h-full object-contain p-1"
                                />
                              ) : (
                                <Package className="w-6 h-6 text-muted-foreground/40" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium text-foreground line-clamp-2 leading-snug pr-2">
                                {title}
                              </p>
                              <p className="font-mono text-[11px] text-muted-foreground mt-1">
                                {asin}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="py-3.5 px-3">
                          <a
                            href={amazonUrl(asin)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:text-accent-hover transition-colors"
                          >
                            Amazon
                            <ExternalLink className="w-3 h-3 opacity-70" />
                          </a>
                        </td>
                        <td className="py-3.5 px-3">
                          <div className="flex flex-col gap-1.5 items-start">
                            <ListingStatusPill listing={listing} />
                            {ebay ? (
                              <a
                                href={ebay}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] text-muted-foreground hover:text-accent inline-flex items-center gap-0.5"
                              >
                                View on eBay
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            ) : null}
                          </div>
                        </td>
                        <td className="py-3.5 px-3 text-right font-mono text-[13px] tabular-nums text-text-body">
                          {money(product?.price)}
                        </td>
                        <td className="py-3.5 px-3 text-right">
                          <span className="font-mono text-[13px] font-medium tabular-nums text-foreground">
                            {money(listing?.price)}
                          </span>
                          {margin != null ? (
                            <span
                              className={cn(
                                "block text-[10px] tabular-nums mt-0.5",
                                margin >= 0 ? "text-emerald-600" : "text-danger"
                              )}
                            >
                              {margin >= 0 ? "+" : ""}
                              {margin.toFixed(0)}%
                            </span>
                          ) : null}
                        </td>
                        <td className="py-3.5 px-3 text-center tabular-nums text-text-body">
                          {listing?.quantity ?? "—"}
                        </td>
                        <td className="py-3.5 px-3">
                          <RepricingPill
                            enableRepricing={enableRepricing}
                            listing={listing}
                          />
                        </td>
                        <td className="py-3.5 px-3 text-xs text-muted-foreground whitespace-nowrap">
                          {formatDate(listing?.createdAt)}
                        </td>
                        <td className="py-3.5 px-3 text-xs text-muted-foreground whitespace-nowrap">
                          {formatDate(row.lastSaleAt)}
                        </td>
                        <td className="py-3.5 px-3 text-center">
                          {row.soldCount > 0 ? (
                            <span className="inline-flex min-w-[28px] justify-center text-xs font-medium tabular-nums px-2 py-0.5 rounded-full bg-surface-muted ring-1 ring-border">
                              {row.soldCount}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-3.5 pr-5 pl-3 text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="h-8 text-xs opacity-80 group-hover:opacity-100"
                            disabled={st?.checking || checkingAll}
                            onClick={() => void runPriceCheck(asin)}
                          >
                            <RefreshCw
                              className={cn(
                                "w-3.5 h-3.5",
                                st?.checking && "animate-spin"
                              )}
                            />
                            Check
                          </Button>
                          {st?.error ? (
                            <p className="text-[10px] text-danger mt-1 max-w-[90px] ml-auto line-clamp-2">
                              {st.error}
                            </p>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="shrink-0 border-t border-border px-4 py-3 flex flex-wrap items-center justify-between gap-3 bg-surface-muted/40">
              <span className="text-xs text-muted-foreground tabular-nums">
                Showing {pageStart}–{pageEnd} of {total}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-8 w-8 p-0"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-xs font-medium px-3 tabular-nums min-w-[88px] text-center">
                  Page {page} / {pages}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-8 w-8 p-0"
                  disabled={page >= pages || loading}
                  onClick={() => setPage((p) => Math.min(pages, p + 1))}
                  aria-label="Next page"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
            </>
          )}
        </div>
      </div>
    </Layout>
  );
}
