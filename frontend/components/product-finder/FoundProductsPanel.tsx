"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ResultsTable, PAGE_SIZE_OPTIONS, type PageSizeOption } from "./ResultsTable";
import type { ProductFinderListing, ProductFinderSummary } from "@/lib/api";
import {
  fetchFoundPage,
  fetchFoundSellers,
  fetchAllFoundPages,
  fetchFinderPrices,
  fetchMissingPriceAsins,
  dedupeFoundProducts,
  sanitizeFoundParams,
  type FoundPageParams,
} from "@/lib/api";
import { enrichListingsProfit, profitQueryFromSettings } from "@/lib/productFinderProfit";
import { MIN_MATCH_CONFIDENCE } from "@/lib/productFinderMatch";
import { formatBytes } from "@/lib/formatBytes";

const FILTER_DEBOUNCE_MS = 400;
const PAGE_SIZE_STORAGE_KEY = "dropkanzi.pfPageSize";

function readPageSize(): PageSizeOption {
  if (typeof window === "undefined") return 500;
  const n = parseInt(window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY) || "", 10);
  return PAGE_SIZE_OPTIONS.includes(n as PageSizeOption) ? (n as PageSizeOption) : 500;
}

function buildSummary(stats: {
  total: number;
  profitable: number;
  total_profit?: number;
  avg_margin?: number;
  total_revenue?: number;
}): ProductFinderSummary {
  const avgMargin = Math.round((stats.avg_margin ?? 0) * 10) / 10;
  return {
    total_listings: stats.total,
    matched_to_amazon: stats.total,
    profitable: stats.profitable,
    match_rate: stats.total > 0 ? 100 : 0,
    avg_margin: avgMargin,
    total_revenue: stats.total_revenue ?? 0,
    total_profit: stats.total_profit ?? 0,
    truncated: false,
  };
}

export function FoundProductsPanel({
  active = true,
  refreshKey = 0,
  globalFoundTotal = 0,
  focusSeller = null,
  onFocusSellerApplied,
  storeSettings,
  onSave,
  onSaveMany,
  onDeleteMany,
  onClearAll,
}: {
  /** When false, skip network refresh until user opens the Found tab. */
  active?: boolean;
  refreshKey?: number;
  /** Global Found count (tab badge) — not mixed into filtered stat cards. */
  globalFoundTotal?: number;
  /** Jump to Found filtered by this seller (from Sellers tab). */
  focusSeller?: string | null;
  /** Called once after focusSeller is applied so parent can clear sticky focus state. */
  onFocusSellerApplied?: () => void;
  storeSettings: Record<string, unknown> | null;
  onSave: (listing: ProductFinderListing) => void;
  onSaveMany: (listings: ProductFinderListing[]) => void;
  onDeleteMany?: (listings: ProductFinderListing[]) => void;
  onClearAll?: () => void;
}) {
  const [listings, setListings] = useState<ProductFinderListing[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(() => readPageSize());
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    total: 0,
    profitable: 0,
    missing_prices: 0,
    total_profit: 0,
    avg_margin: 0,
    total_revenue: 0,
  });
  const [sellers, setSellers] = useState<string[]>([]);
  /** One-shot seed for ResultsTable seller dropdown (from Sellers tab navigation). */
  const [sellerFilterSeed, setSellerFilterSeed] = useState<string | undefined>(
    undefined
  );
  const [tableResetKey, setTableResetKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeSellerFilter, setActiveSellerFilter] = useState<string | undefined>(
    undefined
  );
  const lastRefreshKeyRef = useRef(refreshKey);
  const loadSeqRef = useRef(0);
  const loadedOnceRef = useRef(false);
  const [fetchingPrices, setFetchingPrices] = useState(false);
  const [deduping, setDeduping] = useState(false);
  const [lastPriceFetchCost, setLastPriceFetchCost] = useState<{
    bytes?: number;
    usd?: number;
  } | null>(null);

  const queryRef = useRef<FoundPageParams>({
    page: 1,
    limit: readPageSize(),
    sort: "profit",
    ...profitQueryFromSettings(storeSettings),
  });
  const filterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sellersLoadedRef = useRef(false);
  const listingCountRef = useRef(0);

  const applyStats = useCallback(
    (s: {
      total: number;
      profitable: number;
      missing_prices: number;
      total_profit?: number;
      avg_margin?: number;
      total_revenue?: number;
    }) => {
      setStats((prev) => {
        const next = {
          total: s.total,
          profitable: s.profitable,
          missing_prices: s.missing_prices,
          total_profit: s.total_profit ?? 0,
          avg_margin: s.avg_margin ?? 0,
          total_revenue: s.total_revenue ?? 0,
        };
        if (
          prev.total === next.total &&
          prev.profitable === next.profitable &&
          prev.missing_prices === next.missing_prices &&
          prev.total_profit === next.total_profit &&
          prev.avg_margin === next.avg_margin &&
          prev.total_revenue === next.total_revenue
        ) {
          return prev;
        }
        return next;
      });
    },
    []
  );

  const loadPage = useCallback(
    async (params: FoundPageParams, opts?: { silent?: boolean; withStats?: boolean }) => {
      const seq = ++loadSeqRef.current;
      if (!opts?.silent) setLoading(listingCountRef.current === 0);
      try {
        const withProfit = sanitizeFoundParams({
          ...profitQueryFromSettings(storeSettings),
          ...params,
          includeStats: opts?.withStats !== false,
        });
        const res = await fetchFoundPage(withProfit);
        if (seq !== loadSeqRef.current) return;

        const enriched = enrichListingsProfit(
          res.listings as ProductFinderListing[],
          storeSettings
        );
        setListings(enriched);
        listingCountRef.current = enriched.length;
        setTotal(res.count);
        setPage(res.page);
        setLoadError(null);
        setActiveSellerFilter(withProfit.seller);
        if (res.stats) {
          applyStats({
            total: res.count,
            profitable: res.stats.profitable,
            missing_prices: res.stats.missing_prices,
            total_profit: res.stats.total_profit,
            avg_margin: res.stats.avg_margin,
            total_revenue: res.stats.total_revenue,
          });
        }
        queryRef.current = withProfit;
      } catch (err) {
        if (seq !== loadSeqRef.current) return;
        const msg = err instanceof Error ? err.message : "Failed to load Found";
        setLoadError(msg);
        if (!opts?.silent) toast.error(msg);
      } finally {
        if (seq === loadSeqRef.current && !opts?.silent) setLoading(false);
      }
    },
    [storeSettings, applyStats]
  );

  const reload = useCallback(() => {
    void loadPage({ ...queryRef.current, page: queryRef.current.page ?? 1 }, {
      silent: true,
      withStats: true,
    });
  }, [loadPage]);

  const loadSellers = useCallback(() => {
    void fetchFoundSellers()
      .then((r) => setSellers(r.sellers))
      .catch(() => undefined);
  }, []);

  const defaultQuery = useCallback(
    (): FoundPageParams => ({
      page: 1,
      limit: pageSize,
      sort: "sold_date",
      ...profitQueryFromSettings(storeSettings),
    }),
    [pageSize, storeSettings]
  );

  const clearAllFilters = useCallback(() => {
    setSellerFilterSeed(undefined);
    setActiveSellerFilter(undefined);
    setTableResetKey((k) => k + 1);
    const next = defaultQuery();
    queryRef.current = next;
    void loadPage(next, { withStats: true });
  }, [defaultQuery, loadPage]);

  const loadPageRef = useRef(loadPage);
  const defaultQueryRef = useRef(defaultQuery);
  loadPageRef.current = loadPage;
  defaultQueryRef.current = defaultQuery;

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    const bumped = refreshKey !== lastRefreshKeyRef.current;
    lastRefreshKeyRef.current = refreshKey;

    if (bumped && refreshKey > 0) {
      void loadPageRef.current(
        { ...queryRef.current, page: 1, limit: pageSize },
        { withStats: true, silent: loadedOnceRef.current }
      );
    } else if (!loadedOnceRef.current) {
      sellersLoadedRef.current = false;
      const next = defaultQueryRef.current();
      queryRef.current = next;
      void loadPageRef.current(next, { withStats: true }).then(() => {
        if (cancelled || sellersLoadedRef.current) return;
        sellersLoadedRef.current = true;
        loadSellers();
      });
    }
    loadedOnceRef.current = true;

    return () => {
      cancelled = true;
    };
    // Only re-run on tab activation or explicit refresh — not when loadPage identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, refreshKey, pageSize]);

  useEffect(() => {
    if (!focusSeller) return;
    setSellerFilterSeed(focusSeller);
    queryRef.current = {
      ...queryRef.current,
      seller: focusSeller,
      page: 1,
      limit: pageSize,
      sort: queryRef.current.sort ?? "sold_date",
      ...profitQueryFromSettings(storeSettings),
    };
    void loadPage(queryRef.current, { withStats: true });
    onFocusSellerApplied?.();
    // Only react to explicit seller navigation — not storeSettings/pageSize churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSeller]);

  const handlePageSizeChange = useCallback(
    (next: PageSizeOption) => {
      setPageSize(next);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(next));
      }
      setPage(1);
      void loadPage({ ...queryRef.current, page: 1, limit: next }, { withStats: true });
    },
    [loadPage]
  );

  const storeSettingsLoadedRef = useRef(false);
  useEffect(() => {
    if (!storeSettings || !loadedOnceRef.current) return;
    setListings((prev) => {
      if (prev.length === 0) return prev;
      return enrichListingsProfit(prev, storeSettings);
    });
    if (!storeSettingsLoadedRef.current) {
      storeSettingsLoadedRef.current = true;
      return;
    }
    queryRef.current = {
      ...queryRef.current,
      ...profitQueryFromSettings(storeSettings),
    };
    void loadPage(queryRef.current, { silent: true, withStats: true });
  }, [storeSettings, loadPage]);

  const summary = useMemo(() => buildSummary(stats), [stats]);

  const handleServerQueryChange = useCallback(
    (patch: Partial<FoundPageParams>) => {
      if (filterTimerRef.current) clearTimeout(filterTimerRef.current);
      filterTimerRef.current = setTimeout(() => {
        const merged: FoundPageParams = {
          ...queryRef.current,
          ...patch,
          page: 1,
          limit: pageSize,
        };
        if ("seller" in patch && !patch.seller?.trim()) {
          delete merged.seller;
        }
        const next = sanitizeFoundParams(merged);
        void loadPage(next, { withStats: true });
      }, FILTER_DEBOUNCE_MS);
    },
    [loadPage, pageSize]
  );

  const handleServerPageChange = useCallback(
    (nextPage: number) => {
      void loadPage({ ...queryRef.current, page: nextPage, limit: pageSize }, { withStats: true });
    },
    [loadPage, pageSize]
  );

  const refreshFoundPrices = useCallback(async (asinsOverride?: string[]) => {
    setFetchingPrices(true);
    try {
      let asins = asinsOverride ?? [];
      if (asins.length === 0) {
        const { asins: missing } = await fetchMissingPriceAsins(1000);
        asins = missing;
      }
      if (asins.length === 0) {
        toast.message("No products need Amazon prices.");
        return;
      }
      const prices: Record<
        string,
        { price: number | null; stock?: string; amazon_url: string }
      > = {};
      let costUsd = 0;
      let costBytes = 0;
      let rowsUpdated = 0;
      toast.message(`Fetching Amazon prices for ${asins.length} ASINs…`);
      const priceRes = await fetchFinderPrices(asins);
      Object.assign(prices, priceRes.prices);
      costUsd += priceRes.proxy_cost_usd ?? 0;
      costBytes += priceRes.proxy_bytes ?? 0;
      rowsUpdated += priceRes.rows_updated ?? 0;
      const got = Object.values(prices).filter((p) => p.price != null).length;
      const failed = asins.length - got;
      if (got === 0) {
        throw new Error(
          `No Amazon prices returned (0/${asins.length}). Likely bad ASIN match or out of stock — re-scan seller for better matches, or retry in 1–2 min.`
        );
      }
      setLastPriceFetchCost({ bytes: costBytes, usd: costUsd });
      reload();
      const proxyNote =
        costBytes > 0
          ? ` · ${formatBytes(costBytes)} · $${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)}`
          : "";
      const failNote = failed > 0 ? ` · ${failed} failed (retry)` : "";
      toast.success(
        `Prices: ${got}/${asins.length} loaded · ${rowsUpdated} rows updated${failNote}${proxyNote}`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Price fetch failed");
    } finally {
      setFetchingPrices(false);
    }
  }, [reload]);

  const wrapDelete = useCallback(
    (items: ProductFinderListing[]) => {
      onDeleteMany?.(items);
      setTimeout(reload, 400);
    },
    [onDeleteMany, reload]
  );

  const wrapClear = useCallback(() => {
    onClearAll?.();
    setTimeout(reload, 400);
  }, [onClearAll, reload]);

  const dedupeDuplicates = useCallback(async () => {
    setDeduping(true);
    try {
      const res = await dedupeFoundProducts();
      if (res.removed === 0) {
        toast.message("No duplicate products found.");
      } else {
        toast.success(
          `Removed ${res.removed.toLocaleString()} duplicates · ${res.total.toLocaleString()} left in Found`
        );
      }
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Dedupe failed");
    } finally {
      setDeduping(false);
    }
  }, [reload]);

  const filteredEmpty = !loading && total === 0 && stats.total > 0;
  const emptyContent = useMemo(() => {
    if (loading && listings.length === 0) {
      return (
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading products…
        </span>
      );
    }
    if (loadError) {
      return <p className="text-destructive">{loadError}</p>;
    }
    if (filteredEmpty) {
      return (
        <div className="space-y-3">
          <p>
            {stats.total.toLocaleString()} products in Found, but none match the current filters
            {activeSellerFilter ? ` (seller: ${activeSellerFilter})` : ""}.
          </p>
          <p className="text-xs">
            Try <span className="font-medium text-foreground">All sellers</span> or clear filters.
          </p>
          <Button type="button" size="sm" variant="secondary" onClick={clearAllFilters}>
            Clear filters — show all Found
          </Button>
        </div>
      );
    }
    if (total === 0) {
      return <p>No matched products in Found yet. Queue a seller to scan.</p>;
    }
    return null;
  }, [
    loading,
    listings.length,
    loadError,
    filteredEmpty,
    stats.total,
    activeSellerFilter,
    total,
    clearAllFilters,
  ]);

  const statsScopeLabel = activeSellerFilter
    ? `Seller: ${activeSellerFilter} · ${stats.total.toLocaleString()} of ${globalFoundTotal.toLocaleString()} in Found`
    : null;

  const fetchAllFiltered = useCallback(async () => {
    const rows = await fetchAllFoundPages({
      ...queryRef.current,
      ...profitQueryFromSettings(storeSettings),
    });
    return enrichListingsProfit(rows, storeSettings);
  }, [storeSettings]);

  return (
    <ResultsTable
      key={tableResetKey}
      seller="found-products"
      listings={listings}
      summary={summary}
      statsScopeLabel={statsScopeLabel}
      statsFiltered={Boolean(activeSellerFilter)}
      onSave={onSave}
      onSaveMany={onSaveMany}
      onDeleteMany={wrapDelete}
      onClearAll={wrapClear}
      onDedupeDuplicates={dedupeDuplicates}
      dedupingDuplicates={deduping}
      onFetchPrices={refreshFoundPrices}
      fetchingPrices={fetchingPrices}
      lastPriceFetchCost={lastPriceFetchCost}
      serverMode
      serverTotal={total}
      serverPage={page}
      serverPageSize={pageSize}
      serverLoading={loading}
      serverMissingPrices={stats.missing_prices}
      serverSellers={sellers}
      onServerPageChange={handleServerPageChange}
      onServerPageSizeChange={handlePageSizeChange}
      onServerQueryChange={handleServerQueryChange}
      initialSellerFilter={sellerFilterSeed}
      emptyContent={emptyContent}
      tableMinHeight
      fetchAllFiltered={fetchAllFiltered}
    />
  );
}
