"use client";

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  ExternalLink,
  Package,
  Plus,
  Search,
  TrendingUp,
  Target,
  DollarSign,
  Copy,
  Loader2,
  RefreshCw,
  Trash2,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import type { ProductFinderListing, ProductFinderSummary, FoundPageParams } from "@/lib/api";
import { isAcceptedMatch, MIN_MATCH_CONFIDENCE } from "@/lib/productFinderMatch";
import { listingKey } from "@/lib/productFinderStorage";
import { formatBytes } from "@/lib/formatBytes";
import { ProfitBadge } from "./ProfitBadge";
import { AmazonMatchBadge } from "./AmazonMatchBadge";
import { ExportButton } from "./ExportButton";

type SortKey = "profit" | "margin" | "sold_date" | "sold_price" | "quantity" | "match";

export const PAGE_SIZE_OPTIONS = [50, 100, 250, 500, 1000] as const;
export type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];

const PAGE_SIZE_STORAGE_KEY = "dropkanzi.pfPageSize";
const DEFAULT_PAGE_SIZE: PageSizeOption = 500;

function readStoredPageSize(): PageSizeOption {
  if (typeof window === "undefined") return DEFAULT_PAGE_SIZE;
  const n = parseInt(window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY) || "", 10);
  return PAGE_SIZE_OPTIONS.includes(n as PageSizeOption)
    ? (n as PageSizeOption)
    : DEFAULT_PAGE_SIZE;
}

function rowKey(l: ProductFinderListing): string {
  return l.found_key ?? listingKey(l);
}

function isLosingListing(l: ProductFinderListing): boolean {
  return l.net_profit != null && l.net_profit < 0;
}

function amazonDpUrl(asin: string): string {
  return `https://www.amazon.com/dp/${asin}`;
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
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="pf-stat flex items-start gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-bg">
        <Icon className="h-4 w-4 text-accent" />
      </div>
      <div className="min-w-0">
        <p className="label-caps">{label}</p>
        <p className="mt-0.5 font-mono text-[22px] font-medium tabular-nums leading-none text-text-1">
          {value}
        </p>
        {hint ? (
          <p className="mt-1 truncate text-[11px] text-text-3">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}

export function ResultsTable({
  seller,
  listings,
  summary,
  cached,
  onSave,
  onSaveMany,
  onDeleteMany,
  onClearAll,
  onDedupeDuplicates,
  dedupingDuplicates,
  onFetchPrices,
  fetchingPrices,
  lastPriceFetchCost,
  serverMode,
  serverTotal,
  serverPage = 1,
  serverPageSize = DEFAULT_PAGE_SIZE,
  serverLoading,
  serverMissingPrices,
  serverSellers,
  onServerPageChange,
  onServerQueryChange,
  onServerPageSizeChange,
  initialSellerFilter,
  emptyContent,
  tableMinHeight,
  statsScopeLabel,
  statsFiltered = false,
  fetchAllFiltered,
}: {
  seller: string;
  listings: ProductFinderListing[];
  summary: ProductFinderSummary;
  statsScopeLabel?: string | null;
  statsFiltered?: boolean;
  cached?: boolean;
  onSave: (listing: ProductFinderListing) => void;
  onSaveMany: (listings: ProductFinderListing[]) => void;
  onDeleteMany?: (listings: ProductFinderListing[]) => void;
  onClearAll?: () => void;
  onDedupeDuplicates?: () => void;
  dedupingDuplicates?: boolean;
  onFetchPrices?: (asins?: string[]) => void;
  fetchingPrices?: boolean;
  lastPriceFetchCost?: { bytes?: number; usd?: number } | null;
  serverMode?: boolean;
  serverTotal?: number;
  serverPage?: number;
  serverPageSize?: number;
  serverLoading?: boolean;
  serverMissingPrices?: number;
  serverSellers?: string[];
  onServerPageChange?: (page: number) => void;
  onServerQueryChange?: (patch: Partial<FoundPageParams>) => void;
  onServerPageSizeChange?: (size: PageSizeOption) => void;
  /** Pre-select seller filter (e.g. from Sellers tab). */
  initialSellerFilter?: string;
  /** Custom empty state (Found panel). */
  emptyContent?: React.ReactNode;
  /** Reserve table body height to avoid page jump on load. */
  tableMinHeight?: boolean;
  /** Server mode: load all filtered rows (export / save-all). */
  fetchAllFiltered?: () => Promise<ProductFinderListing[]>;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sortKey, setSortKey] = useState<SortKey>("profit");
  const [profitableOnly, setProfitableOnly] = useState(false);
  const [highConfidenceOnly, setHighConfidenceOnly] = useState(false);
  const [minMargin, setMinMargin] = useState(0);
  const [minConfidence, setMinConfidence] = useState(MIN_MATCH_CONFIDENCE);
  const [minSoldPrice, setMinSoldPrice] = useState(0);
  const [pricedOnly, setPricedOnly] = useState(false);
  const [missingPriceOnly, setMissingPriceOnly] = useState(false);
  const [sellerFilter, setSellerFilter] = useState(initialSellerFilter ?? "");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [clientPageSize, setClientPageSize] = useState<PageSizeOption>(() => readStoredPageSize());
  const lastClickIndexRef = useRef<number | null>(null);
  const lastInitialSellerRef = useRef<string | undefined>(undefined);
  const pageSize = serverMode ? (serverPageSize as PageSizeOption) : clientPageSize;

  useEffect(() => {
    if (!initialSellerFilter || initialSellerFilter === lastInitialSellerRef.current) {
      return;
    }
    lastInitialSellerRef.current = initialSellerFilter;
    setSellerFilter(initialSellerFilter);
  }, [initialSellerFilter]);

  const sellers = useMemo(() => {
    if (serverMode && serverSellers) return serverSellers;
    const set = new Set(
      listings.map((l) => l.source_seller).filter((s): s is string => !!s)
    );
    return Array.from(set).sort();
  }, [listings, serverMode, serverSellers]);

  const pushServerQuery = useCallback(
    (patch: Partial<FoundPageParams>) => {
      onServerQueryChange?.(patch);
    },
    [onServerQueryChange]
  );

  const filtered = useMemo(() => {
    if (serverMode) {
      // All filters are applied server-side — do not re-filter client-side (avoids stat/card drift).
      return listings;
    }
    const q = deferredQuery.trim().toLowerCase();
    let rows = listings.filter((l) => {
      if (sellerFilter && l.source_seller !== sellerFilter) return false;
      if (q) {
        const hay = `${l.title} ${l.amazon_asin ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (profitableOnly && !l.is_profitable) return false;
      if (l.amazon_asin && !isAcceptedMatch(l)) return false;
      if (highConfidenceOnly && (l.match_confidence ?? 0) < 0.9) return false;
      if (minConfidence > 0 && (l.match_confidence ?? 0) < minConfidence) return false;
      if (minMargin > 0 && (l.margin_percent ?? -Infinity) < minMargin) return false;
      if (minSoldPrice > 0 && (l.sold_price ?? 0) < minSoldPrice) return false;
      if (pricedOnly && l.amazon_price == null) return false;
      if (missingPriceOnly && l.amazon_price != null) return false;
      return true;
    });

    rows = [...rows].sort((a, b) => {
      switch (sortKey) {
        case "margin":
          return (b.margin_percent ?? -Infinity) - (a.margin_percent ?? -Infinity);
        case "sold_price":
          return (b.sold_price ?? 0) - (a.sold_price ?? 0);
        case "quantity":
          return (b.quantity_sold ?? 0) - (a.quantity_sold ?? 0);
        case "sold_date":
          return (b.sold_date ?? "").localeCompare(a.sold_date ?? "");
        case "match":
          return (b.match_confidence ?? 0) - (a.match_confidence ?? 0);
        case "profit":
        default:
          return (b.net_profit ?? -Infinity) - (a.net_profit ?? -Infinity);
      }
    });
    return rows;
  }, [
    listings,
    serverMode,
    deferredQuery,
    profitableOnly,
    highConfidenceOnly,
    minConfidence,
    minMargin,
    minSoldPrice,
    pricedOnly,
    missingPriceOnly,
    sellerFilter,
    sortKey,
  ]);

  useEffect(() => {
    if (serverMode) return;
    setPage(0);
  }, [
    serverMode,
    deferredQuery,
    profitableOnly,
    highConfidenceOnly,
    minConfidence,
    minMargin,
    minSoldPrice,
    pricedOnly,
    missingPriceOnly,
    sellerFilter,
    sortKey,
    listings.length,
  ]);

  const serverFilterPatch = useCallback((): Partial<FoundPageParams> => {
    const matchMin = highConfidenceOnly
      ? 0.9
      : minConfidence > 0
        ? minConfidence
        : undefined;
    return {
      q: deferredQuery.trim() || undefined,
      seller: sellerFilter || undefined,
      profitable: profitableOnly || undefined,
      missingPrice: missingPriceOnly || undefined,
      hasPrice: pricedOnly || undefined,
      minMatchConfidence: matchMin,
      minMargin: minMargin > 0 ? minMargin : undefined,
      minSoldPrice: minSoldPrice > 0 ? minSoldPrice : undefined,
      sort: sortKey,
    };
  }, [
    deferredQuery,
    sellerFilter,
    profitableOnly,
    missingPriceOnly,
    pricedOnly,
    highConfidenceOnly,
    minConfidence,
    minMargin,
    minSoldPrice,
    sortKey,
  ]);

  const serverQueryInit = useRef(true);
  useEffect(() => {
    if (!serverMode) return;
    if (serverQueryInit.current) {
      serverQueryInit.current = false;
      return;
    }
    pushServerQuery(serverFilterPatch());
  }, [serverMode, serverFilterPatch, pushServerQuery]);

  const pageCount = serverMode
    ? Math.max(1, Math.ceil((serverTotal ?? 0) / pageSize))
    : Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = serverMode
    ? Math.min(Math.max(0, serverPage - 1), pageCount - 1)
    : Math.min(page, pageCount - 1);
  const pageStart = safePage * pageSize;
  const visible = useMemo(
    () =>
      serverMode
        ? filtered
        : filtered.slice(pageStart, pageStart + pageSize),
    [serverMode, filtered, pageStart, pageSize]
  );
  const visibleKeys = useMemo(() => visible.map(rowKey), [visible]);

  const filteredKeys = useMemo(() => filtered.map(rowKey), [filtered]);
  const allFilteredSelected =
    filteredKeys.length > 0 && filteredKeys.every((k) => selected.has(k));
  const selectedListings = filtered.filter((l) => selected.has(rowKey(l)));

  const handleSaveAllFiltered = useCallback(async () => {
    if (serverMode && fetchAllFiltered) {
      setBulkSaving(true);
      try {
        const total = serverTotal ?? filtered.length;
        toast.message(`Loading ${total.toLocaleString()} rows…`);
        const all = await fetchAllFiltered();
        onSaveMany(all);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load all rows");
      } finally {
        setBulkSaving(false);
      }
      return;
    }
    onSaveMany(filtered);
  }, [serverMode, fetchAllFiltered, serverTotal, filtered, onSaveMany]);

  const missingPriceListings = useMemo(
    () => listings.filter((l) => isAcceptedMatch(l) && l.amazon_price == null),
    [listings]
  );
  const missingPrices = serverMode
    ? (serverMissingPrices ?? 0)
    : missingPriceListings.length;

  const losingListings = useMemo(
    () => listings.filter(isLosingListing),
    [listings]
  );

  useEffect(() => {
    lastClickIndexRef.current = null;
  }, [serverMode, serverPage, page, pageSize, pageStart]);

  const handleRowSelect = (index: number, shiftKey: boolean) => {
    const key = visibleKeys[index];
    if (!key) return;

    setSelected((prev) => {
      if (shiftKey && lastClickIndexRef.current !== null) {
        const start = Math.min(lastClickIndexRef.current, index);
        const end = Math.max(lastClickIndexRef.current, index);
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          const k = visibleKeys[i];
          if (k) next.add(k);
        }
        return next;
      }
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!shiftKey) {
      lastClickIndexRef.current = index;
    }
  };

  const handlePageSizeChange = (nextRaw: string) => {
    const next = Number(nextRaw) as PageSizeOption;
    if (!PAGE_SIZE_OPTIONS.includes(next)) return;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(next));
    }
    lastClickIndexRef.current = null;
    if (serverMode) {
      onServerPageSizeChange?.(next);
    } else {
      setClientPageSize(next);
      setPage(0);
    }
  };

  const selectLosers = () => {
    setSelected(new Set(losingListings.map(rowKey)));
    const firstLoserIdx = visible.findIndex((l) => isLosingListing(l));
    lastClickIndexRef.current = firstLoserIdx >= 0 ? firstLoserIdx : null;
  };

  const deleteAllLosers = () => {
    if (!onDeleteMany || losingListings.length === 0) return;
    onDeleteMany(losingListings);
    setSelected(new Set());
    lastClickIndexRef.current = null;
  };

  const selectedMissingAsins = useMemo(
    () =>
      Array.from(
        new Set(
          selectedListings
            .filter((l) => l.amazon_asin && l.amazon_price == null)
            .map((l) => l.amazon_asin as string)
        )
      ),
    [selectedListings]
  );

  const selectAllMissingPrice = () => {
    setSelected(new Set(missingPriceListings.map(rowKey)));
  };

  const toggleAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filteredKeys.forEach((k) => next.delete(k));
      } else {
        filteredKeys.forEach((k) => next.add(k));
      }
      return next;
    });
  };

  const deleteSelected = () => {
    if (!onDeleteMany || selectedListings.length === 0) return;
    onDeleteMany(selectedListings);
    setSelected(new Set());
    lastClickIndexRef.current = null;
  };

  const deleteOne = (listing: ProductFinderListing) => {
    if (!onDeleteMany) return;
    onDeleteMany([listing]);
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(rowKey(listing));
      return next;
    });
  };

  const listTotal = serverMode ? (serverTotal ?? summary.total_listings) : summary.total_listings;
  const matchedCount = summary.matched_to_amazon;
  const unmappedInFilter = Math.max(0, listTotal - matchedCount);
  const pricedCount =
    summary.with_price ??
    Math.max(0, listTotal - (serverMode ? (serverMissingPrices ?? 0) : (summary.missing_prices ?? 0)));
  const missingPriceCount = serverMode
    ? (serverMissingPrices ?? summary.missing_prices ?? 0)
    : (summary.missing_prices ?? 0);
  /** When every row in the filter already has an ASIN, show priced count instead of duplicating matched. */
  const showPricedAsSecondCard = Boolean(serverMode && unmappedInFilter === 0);

  return (
    <div className="space-y-5">
      {statsScopeLabel ? (
        <p className="text-[12px] text-text-3">{statsScopeLabel}</p>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={statsFiltered ? "Filtered listings" : "Sold listings"}
          value={listTotal.toLocaleString()}
          hint={summary.truncated ? `Capped at ${summary.truncated_at ?? 5000}` : undefined}
          icon={Package}
        />
        <StatCard
          label={
            showPricedAsSecondCard
              ? statsFiltered
                ? "Amazon priced (filter)"
                : "Amazon priced"
              : statsFiltered
                ? "Matched (filter)"
                : "Matched to Amazon"
          }
          value={(showPricedAsSecondCard ? pricedCount : matchedCount).toLocaleString()}
          hint={
            showPricedAsSecondCard
              ? missingPriceCount > 0
                ? `${missingPriceCount.toLocaleString()} without price · use Fetch prices`
                : "All rows have Amazon price"
              : `${summary.match_rate.toFixed(0)}% match rate`
          }
          icon={Target}
        />
        <StatCard
          label={statsFiltered ? "Profitable (filter)" : "Profitable"}
          value={summary.profitable.toLocaleString()}
          hint={
            summary.profitable > 0
              ? `Avg margin ${summary.avg_margin.toFixed(1)}%`
              : "No priced profitable rows"
          }
          icon={TrendingUp}
        />
        <StatCard
          label="Est. profit"
          value={`$${summary.total_profit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          hint={`Revenue $${Math.round(summary.total_revenue).toLocaleString()}`}
          icon={DollarSign}
        />
      </div>

      <div className="pf-panel">
        <div className="flex flex-col gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[14px] font-semibold text-text-1">Results</h3>
            <div className="flex items-center gap-2">
              <ExportButton
                seller={seller}
                listings={filtered}
                totalCount={serverMode ? serverTotal : filtered.length}
                fetchAll={serverMode ? fetchAllFiltered : undefined}
              />
            </div>
          </div>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full lg:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search title or ASIN…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <div className="flex min-h-[2.25rem] flex-wrap items-center gap-2">
              {losingListings.length > 0 ? (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={selectLosers}
                    type="button"
                  >
                    Select losers ({losingListings.length})
                  </Button>
                  {onDeleteMany ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={deleteAllLosers}
                      type="button"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete all losers ({losingListings.length})
                    </Button>
                  ) : null}
                </>
              ) : null}
              {missingPrices > 0 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={selectAllMissingPrice}
                  type="button"
                >
                  Select without price ({missingPrices})
                </Button>
              ) : null}
              {onFetchPrices && (missingPrices > 0 || selectedMissingAsins.length > 0) ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    onFetchPrices(
                      selectedMissingAsins.length > 0 ? selectedMissingAsins : undefined
                    )
                  }
                  disabled={
                    fetchingPrices ||
                    (selectedMissingAsins.length === 0 && missingPrices === 0)
                  }
                  type="button"
                >
                  {fetchingPrices ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {selectedMissingAsins.length > 0
                    ? `Fetch prices (${selectedMissingAsins.length} selected)`
                    : `Fetch all missing (${missingPrices})`}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onSaveMany(selectedListings)}
                disabled={selectedListings.length === 0}
                type="button"
              >
                <Plus className="h-4 w-4" />
                Save selected ({selectedListings.length})
              </Button>
              {onDeleteMany ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={deleteSelected}
                  disabled={selectedListings.length === 0}
                  type="button"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete selected ({selectedListings.length})
                </Button>
              ) : null}
              {onDedupeDuplicates ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={onDedupeDuplicates}
                  disabled={dedupingDuplicates || (serverTotal ?? listings.length) === 0}
                  type="button"
                >
                  {dedupingDuplicates ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Layers className="h-4 w-4" />
                  )}
                  Remove duplicates
                </Button>
              ) : null}
              {onClearAll && listings.length > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onClearAll}
                  type="button"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                  Clear all…
                </Button>
              ) : null}
              <Button
                size="sm"
                onClick={() => void handleSaveAllFiltered()}
                disabled={filtered.length === 0 || bulkSaving}
                type="button"
              >
                {bulkSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Save all filtered ({serverMode ? (serverTotal ?? filtered.length) : filtered.length})
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Checkbox
              className="text-xs"
              label="Profitable only"
              checked={profitableOnly}
              onChange={(e) => setProfitableOnly(e.target.checked)}
            />
            <Checkbox
              className="text-xs"
              label="Match 90%+ only"
              checked={highConfidenceOnly}
              onChange={(e) => setHighConfidenceOnly(e.target.checked)}
            />
            <Checkbox
              className="text-xs"
              label="Has Amazon price"
              checked={pricedOnly}
              onChange={(e) => {
                setPricedOnly(e.target.checked);
                if (e.target.checked) setMissingPriceOnly(false);
              }}
            />
            <Checkbox
              className="text-xs"
              label="Missing price"
              checked={missingPriceOnly}
              onChange={(e) => {
                setMissingPriceOnly(e.target.checked);
                if (e.target.checked) setPricedOnly(false);
              }}
            />
            <Select
              className="h-8 w-auto text-xs"
              value={sellerFilter}
              onChange={(e) => setSellerFilter(e.target.value)}
            >
              <option value="">All sellers</option>
              {sellers.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            <Select
              className="h-8 w-auto text-xs"
              value={String(minConfidence)}
              onChange={(e) => setMinConfidence(Number(e.target.value))}
            >
              <option value={MIN_MATCH_CONFIDENCE}>Match: 80%+</option>
              <option value={0.9}>Match: 90%+</option>
              <option value={0.95}>Match: 95%+</option>
            </Select>
            <div className="flex items-center gap-1.5 text-xs text-foreground/80">
              <span>Min sold</span>
              <Input
                type="number"
                className="h-8 w-16"
                value={minSoldPrice || ""}
                min={0}
                placeholder="0"
                onChange={(e) => setMinSoldPrice(Number(e.target.value) || 0)}
              />
              <span>$</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-foreground/80">
              <span>Min margin</span>
              <Input
                type="number"
                className="h-8 w-16"
                value={minMargin}
                min={0}
                onChange={(e) => setMinMargin(Number(e.target.value) || 0)}
              />
              <span>%</span>
            </div>
            <Select
              className="h-8 w-auto"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
            >
              <option value="profit">Sort: Profit</option>
              <option value="margin">Sort: Margin</option>
              <option value="match">Sort: Match %</option>
              <option value="sold_price">Sort: Sold price</option>
              <option value="quantity">Sort: Qty sold</option>
              <option value="sold_date">Sort: Recent</option>
            </Select>
          </div>
        </div>

        {cached ? (
          <div className="border-b border-border/60 bg-amber-50/60 px-4 py-2 text-xs text-amber-700">
            Showing cached results from earlier today.
          </div>
        ) : null}

        <div className={cn("relative overflow-x-auto", tableMinHeight && "min-h-[420px]")}>
          {serverLoading && listings.length > 0 ? (
            <div
              className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center bg-surface/40 pt-16"
              aria-hidden
            >
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : null}
          <table className="data-table w-full text-sm">
            <thead>
              <tr>
                <th className="w-10">
                  <Checkbox
                    checked={allFilteredSelected}
                    onChange={toggleAllFiltered}
                    aria-label="Select all filtered"
                  />
                </th>
                <th className="w-8 px-1" />
                <th>Product</th>
                <th>Match</th>
                <th className="text-right">Sold</th>
                <th className="text-right">Amazon</th>
                <th className="text-center">Qty</th>
                <th className="text-right">Profit</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="px-4 py-16 text-center text-sm text-muted-foreground"
                  >
                    {emptyContent ?? "No listings match the current filters."}
                  </td>
                </tr>
              ) : (
                visible.map((l, index) => {
                  const key = rowKey(l);
                  const isOpen = expanded === key;
                  const amazonUrl =
                    l.amazon_url ?? (l.amazon_asin ? amazonDpUrl(l.amazon_asin) : null);
                  return (
                    <ListingRow
                      key={key}
                      listing={l}
                      index={index}
                      rowKey={key}
                      isOpen={isOpen}
                      isSelected={selected.has(key)}
                      amazonUrl={amazonUrl}
                      onToggleExpand={() => setExpanded(isOpen ? null : key)}
                      onSelect={handleRowSelect}
                      onSave={onSave}
                      onDelete={onDeleteMany ? deleteOne : undefined}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground min-h-[2.75rem]">
          {serverLoading && listings.length === 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </span>
          ) : (
            <>
              Showing {filtered.length === 0 ? 0 : pageStart + 1}–
              {serverMode
                ? pageStart + visible.length
                : Math.min(pageStart + pageSize, filtered.length)}{" "}
              of {serverMode ? (serverTotal ?? 0) : filtered.length} listings
              {!serverMode && filtered.length !== listings.length
                ? ` (${listings.length} total)`
                : ""}
            </>
          )}
          <span className="ml-2 inline-flex items-center gap-1">
            <Select
              className="h-7 w-auto min-w-[4.5rem] text-xs"
              value={String(pageSize)}
              onChange={(e) => handlePageSizeChange(e.target.value)}
              aria-label="Rows per page"
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}/page
                </option>
              ))}
            </Select>
          </span>
          {pageCount > 1 ? (
            <span className="ml-2 inline-flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={serverMode ? serverPage <= 1 : safePage <= 0}
                onClick={() =>
                  serverMode
                    ? onServerPageChange?.(Math.max(1, serverPage - 1))
                    : setPage((p) => Math.max(0, p - 1))
                }
              >
                Prev
              </Button>
              <span className="tabular-nums">
                {safePage + 1}/{pageCount}
              </span>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={
                  serverMode ? serverPage >= pageCount : safePage >= pageCount - 1
                }
                onClick={() =>
                  serverMode
                    ? onServerPageChange?.(Math.min(pageCount, serverPage + 1))
                    : setPage((p) => Math.min(pageCount - 1, p + 1))
                }
              >
                Next
              </Button>
            </span>
          ) : null}
          {selected.size > 0 ? ` · ${selected.size} selected` : ""}
          {losingListings.length > 0 ? ` · ${losingListings.length} losers` : ""}
          <span className="ml-2 hidden sm:inline">· Shift+click row/checkbox for range select</span>
          {lastPriceFetchCost && (lastPriceFetchCost.bytes ?? 0) > 0 ? (
            <span className="ml-2">
              · Last price fetch: {formatBytes(lastPriceFetchCost.bytes)} · $
              {(lastPriceFetchCost.usd ?? 0) < 0.01
                ? (lastPriceFetchCost.usd ?? 0).toFixed(4)
                : (lastPriceFetchCost.usd ?? 0).toFixed(2)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const ListingRow = memo(function ListingRow({
  listing: l,
  index,
  rowKey: key,
  isOpen,
  isSelected,
  amazonUrl,
  onToggleExpand,
  onSelect,
  onSave,
  onDelete,
}: {
  listing: ProductFinderListing;
  index: number;
  rowKey: string;
  isOpen: boolean;
  isSelected: boolean;
  amazonUrl: string | null;
  onToggleExpand: () => void;
  onSelect: (index: number, shiftKey: boolean) => void;
  onSave: (listing: ProductFinderListing) => void;
  onDelete?: (listing: ProductFinderListing) => void;
}) {
  return (
    <tr
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest("a,button,input,label")) return;
        e.preventDefault();
        onSelect(index, e.shiftKey);
      }}
      className={cn(
        "align-top cursor-pointer select-none",
        isSelected && "bg-accent-bg/50"
      )}
    >
      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={isSelected}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            onSelect(index, e.shiftKey);
          }}
          onChange={() => {}}
          aria-label="Select row"
        />
      </td>
      <td className="px-1 py-3">
        <button
          type="button"
          aria-label="Toggle breakdown"
          onClick={onToggleExpand}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          disabled={l.net_profit == null}
        >
          <ChevronDown
            className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")}
          />
        </button>
      </td>
      <td className="px-3 py-3">
        <div className="flex items-start gap-3">
          {l.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={l.image}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-[34px] w-[34px] shrink-0 rounded-[5px] border border-border object-cover"
            />
          ) : (
            <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[5px] border border-border bg-surface-2 text-text-3">
              <Package className="h-4 w-4" />
            </div>
          )}
          <div className="min-w-0">
            <a
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="line-clamp-2 max-w-[220px] text-[12px] font-medium text-text-1 hover:text-accent"
            >
              {l.title}
            </a>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              {l.amazon_asin ? (
                <>
                  <a
                    href={amazonUrl ?? amazonDpUrl(l.amazon_asin)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                  >
                    Amazon
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(l.amazon_asin as string, "ASIN copied")}
                    className="asin-code inline-flex items-center gap-1 hover:text-accent"
                    title="Copy ASIN"
                  >
                    {l.amazon_asin}
                    <Copy className="h-3 w-3 opacity-60" />
                  </button>
                </>
              ) : null}
              {l.source_seller ? (
                <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {l.source_seller}
                  {l.source_days_back ? ` · ${l.source_days_back}d` : ""}
                </span>
              ) : null}
              {l.sold_date ? (
                <span className="text-muted-foreground">{l.sold_date.slice(0, 10)}</span>
              ) : null}
            </div>
            {isOpen && l.net_profit != null ? <ProfitBreakdown listing={l} /> : null}
          </div>
        </div>
      </td>
      <td className="px-3 py-3">
        <AmazonMatchBadge
          asin={l.amazon_asin}
          confidence={l.match_confidence}
          method={l.match_method}
          imageScore={l.match_image_score}
        />
      </td>
      <td className="text-right col-sold">
        {l.sold_price != null ? `$${l.sold_price.toFixed(2)}` : "—"}
      </td>
      <td className="text-right col-price">
        {l.amazon_price != null ? (
          amazonUrl ? (
            <a
              href={amazonUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-end gap-1 font-medium text-foreground hover:text-accent"
            >
              ${l.amazon_price.toFixed(2)}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            `$${l.amazon_price.toFixed(2)}`
          )
        ) : l.amazon_asin && amazonUrl ? (
          <a
            href={amazonUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-end gap-1 text-xs text-muted-foreground hover:text-accent"
          >
            View
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-3 text-center tabular-nums">{l.quantity_sold}</td>
      <td className="px-3 py-3 text-right">
        <ProfitBadge profit={l.net_profit} margin={l.margin_percent} />
      </td>
      <td className="text-right">
        <div className="row-action inline-flex items-center gap-1">
          {l.amazon_asin ? (
            <button
              type="button"
              onClick={() => onSave(l)}
              className="text-[13px] font-medium text-accent hover:text-accent-hover"
            >
              Add →
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              aria-label="Remove from found"
              onClick={() => onDelete(l)}
              className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
});

function ProfitBreakdown({ listing }: { listing: ProductFinderListing }) {
  const rows: Array<[string, string]> = [
    ["Revenue", `$${(listing.revenue ?? listing.sold_price ?? 0).toFixed(2)}`],
    ["eBay fee", `-$${(listing.ebay_fee ?? 0).toFixed(2)}`],
    ["Payment fee", `-$${(listing.payment_fee ?? 0).toFixed(2)}`],
    ["Amazon cost", `-$${(listing.amazon_cost ?? 0).toFixed(2)}`],
    ["Net profit", `$${(listing.net_profit ?? 0).toFixed(2)}`],
    [
      "ROI",
      listing.roi_percent != null ? `${listing.roi_percent.toFixed(1)}%` : "—",
    ],
  ];
  return (
    <div className="mt-2 grid max-w-sm grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-surface-muted p-3 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-medium tabular-nums text-foreground">{value}</span>
        </div>
      ))}
    </div>
  );
}
