"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ResultsTable, PAGE_SIZE_OPTIONS, type PageSizeOption } from "./ResultsTable";
import type { ProductFinderListing, ProductFinderSummary } from "@/lib/api";
import {
  fetchActivePage,
  fetchActiveSellers,
  fetchAllActivePages,
  fetchFinderPrices,
  sanitizeActiveParams,
  type ActivePageParams,
} from "@/lib/api";
import { enrichListingsProfit, profitQueryFromSettings } from "@/lib/productFinderProfit";
import { MIN_MATCH_CONFIDENCE } from "@/lib/productFinderMatch";
import { formatBytes } from "@/lib/formatBytes";

const FILTER_DEBOUNCE_MS = 400;
const PAGE_SIZE_STORAGE_KEY = "dropkanzi.pfActivePageSize";

function readPageSize(): PageSizeOption {
  if (typeof window === "undefined") return 500;
  const n = parseInt(window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY) || "", 10);
  return PAGE_SIZE_OPTIONS.includes(n as PageSizeOption) ? (n as PageSizeOption) : 500;
}

function buildSummary(stats: {
  total: number;
  matched: number;
  with_price: number;
  profitable: number;
  missing_prices: number;
  total_profit?: number;
  avg_margin?: number;
  total_revenue?: number;
}): ProductFinderSummary {
  const avgMargin = Math.round((stats.avg_margin ?? 0) * 10) / 10;
  const matchRate =
    stats.total > 0 ? Math.round((stats.matched / stats.total) * 1000) / 10 : 0;
  return {
    total_listings: stats.total,
    matched_to_amazon: stats.matched,
    profitable: stats.profitable,
    match_rate: matchRate,
    avg_margin: avgMargin,
    total_revenue: stats.total_revenue ?? 0,
    total_profit: stats.total_profit ?? 0,
    truncated: false,
    with_price: stats.with_price,
    missing_prices: stats.missing_prices,
  };
}

export function ActiveListingsPanel({
  active = true,
  refreshKey = 0,
  globalActiveTotal = 0,
  focusSeller = null,
  onFocusSellerApplied,
  storeSettings,
  onSave,
  onSaveMany,
  onDeleteMany,
  onScanSeller,
  scanningSeller = null,
}: {
  active?: boolean;
  refreshKey?: number;
  globalActiveTotal?: number;
  focusSeller?: string | null;
  onFocusSellerApplied?: () => void;
  storeSettings: Record<string, unknown> | null;
  onSave: (listing: ProductFinderListing) => void;
  onSaveMany: (listings: ProductFinderListing[]) => void;
  onDeleteMany?: (listings: ProductFinderListing[]) => void;
  onScanSeller?: (seller: string) => void;
  scanningSeller?: string | null;
}) {
  const [listings, setListings] = useState<ProductFinderListing[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState<PageSizeOption>(() => readPageSize());
  const [pageNum, setPageNum] = useState(1);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    total: 0,
    matched: 0,
    with_price: 0,
    profitable: 0,
    missing_prices: 0,
    total_profit: 0,
    avg_margin: 0,
    total_revenue: 0,
  });
  const [sellers, setSellers] = useState<string[]>([]);
  const [sellerFilterSeed, setSellerFilterSeed] = useState<string | undefined>(undefined);
  const [tableResetKey, setTableResetKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeSellerFilter, setActiveSellerFilter] = useState<string | undefined>(undefined);
  const lastRefreshKeyRef = useRef(refreshKey);
  const loadSeqRef = useRef(0);
  const loadedOnceRef = useRef(false);
  const [fetchingPrices, setFetchingPrices] = useState(false);
  const [lastPriceFetchCost, setLastPriceFetchCost] = useState<{
    bytes?: number;
    usd?: number;
  } | null>(null);

  const queryRef = useRef<ActivePageParams>({
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
      matched: number;
      with_price: number;
      profitable: number;
      missing_prices: number;
      total_profit?: number;
      avg_margin?: number;
      total_revenue?: number;
    }) => {
      setStats({
        total: s.total,
        matched: s.matched,
        with_price: s.with_price,
        profitable: s.profitable,
        missing_prices: s.missing_prices,
        total_profit: s.total_profit ?? 0,
        avg_margin: s.avg_margin ?? 0,
        total_revenue: s.total_revenue ?? 0,
      });
    },
    []
  );

  const loadPage = useCallback(
    async (params: ActivePageParams, opts?: { silent?: boolean; withStats?: boolean }) => {
      const seq = ++loadSeqRef.current;
      if (!opts?.silent) setLoading(listingCountRef.current === 0);
      try {
        const withProfit = sanitizeActiveParams({
          ...profitQueryFromSettings(storeSettings),
          ...params,
          includeStats: opts?.withStats !== false,
        });
        const res = await fetchActivePage(withProfit);
        if (seq !== loadSeqRef.current) return;

        const enriched = enrichListingsProfit(
          res.listings as ProductFinderListing[],
          storeSettings
        );
        setListings(enriched);
        listingCountRef.current = enriched.length;
        setTotal(res.count ?? 0);
        setPageNum(res.page);
        setLoadError(null);
        setActiveSellerFilter(withProfit.seller);
        if (res.stats) {
          const st = res.stats;
          applyStats({
            total: res.count ?? st.total ?? 0,
            matched: st.matched ?? st.total ?? res.count ?? 0,
            with_price:
              st.with_price ??
              Math.max(0, (st.total ?? res.count ?? 0) - (st.missing_prices ?? 0)),
            profitable: st.profitable,
            missing_prices: st.missing_prices,
            total_profit: st.total_profit,
            avg_margin: st.avg_margin,
            total_revenue: st.total_revenue,
          });
        }
        queryRef.current = withProfit;
      } catch (err) {
        if (seq !== loadSeqRef.current) return;
        const msg = err instanceof Error ? err.message : "Failed to load live listings";
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
    void fetchActiveSellers()
      .then((r) => setSellers(r.sellers))
      .catch(() => undefined);
  }, []);

  const defaultQuery = useCallback(
    (): ActivePageParams => ({
      page: 1,
      limit: pageSize,
      sort: "profit",
      minMatchConfidence: MIN_MATCH_CONFIDENCE,
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
      sort: queryRef.current.sort ?? "profit",
      minMatchConfidence: MIN_MATCH_CONFIDENCE,
      ...profitQueryFromSettings(storeSettings),
    };
    void loadPage(queryRef.current, { withStats: true });
    onFocusSellerApplied?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSeller]);

  const handlePageSizeChange = useCallback(
    (next: PageSizeOption) => {
      setPageSize(next);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(next));
      }
      setPageNum(1);
      void loadPage({ ...queryRef.current, page: 1, limit: next }, { withStats: true });
    },
    [loadPage]
  );

  useEffect(() => {
    if (!storeSettings || !loadedOnceRef.current) return;
    setListings((prev) => {
      if (prev.length === 0) return prev;
      return enrichListingsProfit(prev, storeSettings);
    });
    queryRef.current = {
      ...queryRef.current,
      ...profitQueryFromSettings(storeSettings),
    };
    void loadPage(queryRef.current, { silent: true, withStats: true });
  }, [storeSettings, loadPage]);

  const summary = useMemo(() => buildSummary(stats), [stats]);

  const fetchAllFiltered = useCallback(async () => {
    const rows = await fetchAllActivePages({
      ...queryRef.current,
      ...profitQueryFromSettings(storeSettings),
    });
    return enrichListingsProfit(rows as ProductFinderListing[], storeSettings);
  }, [storeSettings]);

  const wrapDelete = useCallback(
    (items: ProductFinderListing[]) => {
      onDeleteMany?.(items);
      setTimeout(reload, 400);
    },
    [onDeleteMany, reload]
  );

  const handleServerQueryChange = useCallback(
    (patch: Partial<ActivePageParams>) => {
      if (filterTimerRef.current) clearTimeout(filterTimerRef.current);
      filterTimerRef.current = setTimeout(() => {
        const merged: ActivePageParams = {
          ...queryRef.current,
          ...patch,
          page: 1,
          limit: pageSize,
        };
        if ("seller" in patch && !patch.seller?.trim()) {
          delete merged.seller;
        }
        void loadPage(sanitizeActiveParams(merged), { withStats: true });
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

  const refreshPrices = useCallback(async () => {
    setFetchingPrices(true);
    try {
      const asins = Array.from(
        new Set(
          listings
            .filter((l) => l.amazon_asin && l.amazon_price == null)
            .map((l) => l.amazon_asin!.toUpperCase())
        )
      ).slice(0, 1000);
      if (asins.length === 0) {
        toast.message("No products need Amazon prices on this page.");
        return;
      }
      toast.message(`Fetching Amazon prices for ${asins.length} ASINs…`);
      const priceRes = await fetchFinderPrices(asins);
      const got = Object.values(priceRes.prices).filter((p) => p.price != null).length;
      setLastPriceFetchCost({
        bytes: priceRes.proxy_bytes,
        usd: priceRes.proxy_cost_usd,
      });
      reload();
      toast.success(`Prices: ${got}/${asins.length} loaded`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Price fetch failed");
    } finally {
      setFetchingPrices(false);
    }
  }, [listings, reload]);

  const filteredEmpty = !loading && total === 0 && stats.total > 0;
  const emptyContent = useMemo(() => {
    if (loading && listings.length === 0) {
      return (
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading live listings…
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
            {stats.total.toLocaleString()} live matches, but none match the current filters
            {activeSellerFilter ? ` (seller: ${activeSellerFilter})` : ""}.
          </p>
          <Button type="button" size="sm" variant="secondary" onClick={clearAllFilters}>
            Clear filters
          </Button>
        </div>
      );
    }
    if (total === 0) {
      return (
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>No live listings scanned yet.</p>
          <p>
            Go to <span className="font-medium text-foreground">Sellers</span> and click{" "}
            <span className="font-medium text-foreground">Scan Live</span>, or pick a seller below
            and scan their active store inventory.
          </p>
        </div>
      );
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
    ? `Seller: ${activeSellerFilter} · ${stats.total.toLocaleString()} of ${globalActiveTotal.toLocaleString()} live matches`
    : null;

  const scanTarget = activeSellerFilter ?? focusSeller ?? sellers[0];

  return (
    <div className="space-y-3">
      {onScanSeller && scanTarget ? (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          <Button
            size="sm"
            type="button"
            disabled={Boolean(scanningSeller)}
            onClick={() => onScanSeller(scanTarget)}
          >
            {scanningSeller?.toLowerCase() === scanTarget.toLowerCase() ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ScanSearch className="h-4 w-4" />
            )}
            Scan live listings — {scanTarget}
          </Button>
          <span className="text-xs text-muted-foreground">
            Scrapes all active eBay listings for this seller and matches to Amazon.
          </span>
        </div>
      ) : null}
      <ResultsTable
        key={tableResetKey}
        seller="active-listings"
        listings={listings}
        summary={summary}
        statsScopeLabel={statsScopeLabel}
        statsFiltered={Boolean(activeSellerFilter)}
        onSave={onSave}
        onSaveMany={onSaveMany}
        onDeleteMany={onDeleteMany ? wrapDelete : undefined}
        onFetchPrices={refreshPrices}
        fetchingPrices={fetchingPrices}
        lastPriceFetchCost={lastPriceFetchCost}
        serverMode
        serverTotal={total}
        serverPage={pageNum}
        serverPageSize={pageSize}
        serverLoading={loading}
        serverMissingPrices={stats.missing_prices}
        serverSellers={sellers}
        onServerPageChange={handleServerPageChange}
        onServerPageSizeChange={handlePageSizeChange}
        onServerQueryChange={(patch) =>
          handleServerQueryChange(patch as Partial<ActivePageParams>)
        }
        initialSellerFilter={sellerFilterSeed}
        emptyContent={emptyContent}
        tableMinHeight
        fetchAllFiltered={fetchAllFiltered}
      />
    </div>
  );
}
