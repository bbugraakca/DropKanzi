"use client";

import { memo, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  Copy,
  Package,
  Plus,
  Trash2,
  Undo2,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
  Loader2,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { copyToClipboard } from "@/lib/clipboard";
import type { ProductFinderListing } from "@/lib/api";
import { enrichListingProfit } from "@/lib/productFinderProfit";
import { MIN_MATCH_CONFIDENCE } from "@/lib/productFinderMatch";
import { listingKey } from "@/lib/productFinderStorage";
import { ProfitBadge } from "./ProfitBadge";

const PAGE_SIZE = 100;

type SortKey = "profit" | "margin" | "sold_price" | "amazon_price" | "sold_date" | "match";

function rowKey(l: ProductFinderListing): string {
  return listingKey(l);
}

function inRange(value: number | null | undefined, min: number, max: number): boolean {
  if (value == null || !Number.isFinite(value)) return false;
  if (min > 0 && value < min) return false;
  if (max > 0 && value > max) return false;
  return true;
}

const SavedRow = memo(function SavedRow({
  listing,
  profit,
  selected,
  onToggle,
  onUnsave,
  onCopyListing,
  unsaveLabel = "Unsave",
  unsaveAriaLabel = "Unsave — move back to Found",
}: {
  listing: ProductFinderListing;
  profit: ProductFinderListing;
  selected: boolean;
  onToggle: () => void;
  onUnsave: () => void;
  onCopyListing: () => void;
  unsaveLabel?: string;
  unsaveAriaLabel?: string;
}) {
  return (
    <tr className="border-b border-border/40 last:border-0 hover:bg-surface-hover/50">
      <td className="px-3 py-3">
        <Checkbox aria-label="Select row" checked={selected} onChange={onToggle} />
      </td>
      <td className="px-3 py-3">
        <div className="flex items-start gap-3">
          {listing.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={listing.image}
              alt=""
              className="h-10 w-10 shrink-0 rounded object-cover ring-1 ring-black/[0.05]"
              loading="lazy"
            />
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-surface-muted text-muted-foreground ring-1 ring-black/[0.05]">
              <Package className="h-4 w-4" />
            </div>
          )}
          <a
            href={listing.url}
            target="_blank"
            rel="noreferrer"
            className="line-clamp-2 max-w-md text-[13px] font-medium text-foreground hover:text-accent"
          >
            {listing.title}
          </a>
        </div>
      </td>
      <td className="px-3 py-3">
        {listing.amazon_asin ? (
          <div className="flex flex-col gap-1">
            <a
              href={listing.amazon_url ?? `https://www.amazon.com/dp/${listing.amazon_asin}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
            >
              Amazon
              <ExternalLink className="h-3 w-3" />
            </a>
            <button
              type="button"
              onClick={onCopyListing}
              className="inline-flex items-center gap-1 rounded font-mono text-xs text-foreground/80 hover:text-accent"
              title="Copy ASIN"
            >
              {listing.amazon_asin}
              <Copy className="h-3 w-3 opacity-60" />
            </button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-3 text-right tabular-nums">
        {listing.sold_price != null ? `$${listing.sold_price.toFixed(2)}` : "—"}
      </td>
      <td className="px-3 py-3 text-right tabular-nums">
        {listing.amazon_price != null ? (
          listing.amazon_url ? (
            <a
              href={listing.amazon_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-foreground hover:text-accent"
            >
              ${listing.amazon_price.toFixed(2)}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            `$${listing.amazon_price.toFixed(2)}`
          )
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-3 text-right">
        <ProfitBadge profit={profit.net_profit} margin={profit.margin_percent} />
      </td>
      <td className="px-3 py-3 text-right">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          aria-label={unsaveAriaLabel}
          onClick={onUnsave}
          className="h-8 px-2 text-xs"
        >
          <Undo2 className="h-3.5 w-3.5" />
          {unsaveLabel}
        </Button>
      </td>
    </tr>
  );
});

export function SavedProductsPanel({
  saved,
  totalCount,
  loading = false,
  panelMode = "saved",
  onUnsave,
  onUnsaveMany,
  onClear,
  onAddAllToStore,
  onReserve,
  onDedupe,
  deduping,
  storeSettings,
}: {
  saved: ProductFinderListing[];
  /** Server/tab total — may differ from loaded rows until lazy load completes. */
  totalCount?: number;
  loading?: boolean;
  panelMode?: "saved" | "reserved";
  onUnsave: (listing: ProductFinderListing) => void;
  onUnsaveMany?: (listings: ProductFinderListing[]) => void;
  onClear: () => void;
  onAddAllToStore: (asins: string[]) => void;
  /** Saved tab: copy moves listings into Reserved. */
  onReserve?: (listings: ProductFinderListing[]) => void;
  onDedupe?: () => void;
  deduping?: boolean;
  storeSettings?: Record<string, unknown> | null;
}) {
  const isReserved = panelMode === "reserved";
  const itemLabel = isReserved ? "reserved" : "saved";
  const displayTotal = totalCount ?? saved.length;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [profitableOnly, setProfitableOnly] = useState(false);
  const [hasAmazonPrice, setHasAmazonPrice] = useState(false);
  const [missingAmazonPrice, setMissingAmazonPrice] = useState(false);
  const [minSoldPrice, setMinSoldPrice] = useState(0);
  const [maxSoldPrice, setMaxSoldPrice] = useState(0);
  const [minAmazonPrice, setMinAmazonPrice] = useState(0);
  const [maxAmazonPrice, setMaxAmazonPrice] = useState(0);
  const [minMargin, setMinMargin] = useState(0);
  const [minMatchConfidence, setMinMatchConfidence] = useState(0);
  const [sellerFilter, setSellerFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("profit");

  const enriched = useMemo(
    () => saved.map((l) => enrichListingProfit(l, storeSettings)),
    [saved, storeSettings]
  );

  const sellers = useMemo(() => {
    const set = new Set(
      saved.map((l) => l.source_seller).filter((s): s is string => !!s)
    );
    return Array.from(set).sort();
  }, [saved]);

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    let rows = enriched.filter((l) => {
      if (q) {
        const hay = `${l.title} ${l.amazon_asin ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (sellerFilter && l.source_seller !== sellerFilter) return false;
      if (profitableOnly && !l.is_profitable) return false;
      if (hasAmazonPrice && l.amazon_price == null) return false;
      if (missingAmazonPrice && l.amazon_price != null) return false;
      if (minMatchConfidence > 0 && (l.match_confidence ?? 0) < minMatchConfidence) {
        return false;
      }
      if (minMargin > 0 && (l.margin_percent ?? -Infinity) < minMargin) return false;
      if (minSoldPrice > 0 || maxSoldPrice > 0) {
        if (!inRange(l.sold_price, minSoldPrice, maxSoldPrice)) return false;
      }
      if (minAmazonPrice > 0 || maxAmazonPrice > 0) {
        if (!inRange(l.amazon_price, minAmazonPrice, maxAmazonPrice)) return false;
      }
      return true;
    });

    rows = [...rows].sort((a, b) => {
      switch (sortKey) {
        case "margin":
          return (b.margin_percent ?? -Infinity) - (a.margin_percent ?? -Infinity);
        case "sold_price":
          return (b.sold_price ?? 0) - (a.sold_price ?? 0);
        case "amazon_price":
          return (b.amazon_price ?? 0) - (a.amazon_price ?? 0);
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
    enriched,
    deferredQuery,
    sellerFilter,
    profitableOnly,
    hasAmazonPrice,
    missingAmazonPrice,
    minMatchConfidence,
    minMargin,
    minSoldPrice,
    maxSoldPrice,
    minAmazonPrice,
    maxAmazonPrice,
    sortKey,
  ]);

  const filtersActive =
    deferredQuery.trim() !== "" ||
    sellerFilter !== "" ||
    profitableOnly ||
    hasAmazonPrice ||
    missingAmazonPrice ||
    minMatchConfidence > 0 ||
    minMargin > 0 ||
    minSoldPrice > 0 ||
    maxSoldPrice > 0 ||
    minAmazonPrice > 0 ||
    maxAmazonPrice > 0;

  const clearFilters = () => {
    setQuery("");
    setProfitableOnly(false);
    setHasAmazonPrice(false);
    setMissingAmazonPrice(false);
    setMinSoldPrice(0);
    setMaxSoldPrice(0);
    setMinAmazonPrice(0);
    setMaxAmazonPrice(0);
    setMinMargin(0);
    setMinMatchConfidence(0);
    setSellerFilter("");
    setSortKey("profit");
  };

  useEffect(() => {
    setPage(0);
  }, [
    saved.length,
    deferredQuery,
    sellerFilter,
    profitableOnly,
    hasAmazonPrice,
    missingAmazonPrice,
    minMatchConfidence,
    minMargin,
    minSoldPrice,
    maxSoldPrice,
    minAmazonPrice,
    maxAmazonPrice,
    sortKey,
  ]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * PAGE_SIZE;
  const visible = useMemo(
    () => filtered.slice(pageStart, pageStart + PAGE_SIZE),
    [filtered, pageStart]
  );

  const filteredAsins = useMemo(
    () =>
      Array.from(
        new Set(filtered.map((s) => s.amazon_asin).filter((a): a is string => !!a))
      ),
    [filtered]
  );

  const filteredKeys = useMemo(() => filtered.map(rowKey), [filtered]);
  const allFilteredSelected =
    filteredKeys.length > 0 && filteredKeys.every((k) => selected.has(k));

  const selectedListings = filtered.filter((l) => selected.has(rowKey(l)));

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

  const toggleRow = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const unsaveSelected = () => {
    if (selectedListings.length === 0) return;
    if (onUnsaveMany) onUnsaveMany(selectedListings);
    else selectedListings.forEach((l) => onUnsave(l));
    setSelected(new Set());
  };

  const copyListings = (listings: ProductFinderListing[]) => {
    const withAsin = listings.filter((l) => l.amazon_asin);
    if (withAsin.length === 0) return;
    const asins = Array.from(
      new Set(withAsin.map((l) => l.amazon_asin).filter((a): a is string => !!a))
    );
    copyToClipboard(asins.join("\n"), `Copied ${asins.length} ASINs (one per line)`, {
      silent: !isReserved && !!onReserve,
    });
    if (!isReserved && onReserve) {
      onReserve(withAsin);
      setSelected(new Set());
    }
  };

  const copyAsinsFromListings = (listings: ProductFinderListing[]) => {
    copyListings(listings);
  };

  if (loading) {
    return (
      <div className="pf-panel pf-empty">
        <Loader2 className="mb-3 h-7 w-7 animate-spin text-text-3" aria-hidden />
        <p className="text-[14px] font-medium text-text-1">
          Loading {displayTotal > 0 ? `${displayTotal.toLocaleString()} ` : ""}
          {itemLabel} products…
        </p>
      </div>
    );
  }

  if (saved.length === 0) {
    return (
      <div className="pf-panel pf-empty">
        <Package className="mb-3 h-7 w-7 text-text-3" aria-hidden />
        <p className="text-[14px] font-medium text-text-1">
          {isReserved ? "No reserved products yet" : "No saved products yet"}
        </p>
        <p className="mt-1 max-w-sm text-[13px] text-text-3">
          {displayTotal > 0
            ? `${displayTotal.toLocaleString()} on server — open tab again or refresh if this persists.`
            : isReserved
              ? "Copy from Saved — items move here and stay on the server."
              : "Add from Found — saved to the database, not just this browser."}
        </p>
      </div>
    );
  }

  return (
    <div className="pf-panel">
      <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="text-[13px] font-medium text-text-1">
          {filtersActive ? (
            <>
              {filtered.length} of {displayTotal} {itemLabel}
            </>
          ) : (
            <>
              {displayTotal} {itemLabel} {displayTotal === 1 ? "product" : "products"}
            </>
          )}
          {filtered.length > PAGE_SIZE ? (
            <span className="ml-2 font-normal text-muted-foreground">
              · page {safePage + 1}/{pageCount}
            </span>
          ) : null}
          {selected.size > 0 ? (
            <span className="ml-2 font-normal text-muted-foreground">
              · {selected.size} selected
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={unsaveSelected}
            disabled={selected.size === 0}
            type="button"
          >
            <Undo2 className="h-4 w-4" />
            {isReserved ? "Back to Saved" : "Unsave selected"} ({selected.size})
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => copyAsinsFromListings(selectedListings)}
            disabled={selected.size === 0}
            type="button"
          >
            <Copy className="h-4 w-4" />
            Copy selected ({selected.size})
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => copyAsinsFromListings(filtered.filter((l) => l.amazon_asin))}
            disabled={filteredAsins.length === 0}
            type="button"
          >
            <Copy className="h-4 w-4" />
            {filtersActive
              ? `Copy filtered ASINs (${filteredAsins.length})`
              : `Copy all ASINs (${filteredAsins.length})`}
          </Button>
          <Button
            size="sm"
            onClick={() => onAddAllToStore(filteredAsins)}
            disabled={filteredAsins.length === 0}
            type="button"
          >
            <Plus className="h-4 w-4" />
            {filtersActive ? `Add filtered (${filteredAsins.length})` : "Add all to store"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onUnsaveMany?.(filtered) ?? filtered.forEach((l) => onUnsave(l))}
            type="button"
          >
            <Undo2 className="h-4 w-4" />
            {isReserved ? "Move filtered back" : "Return to Found"}{" "}
            {filtersActive ? "filtered" : "all"}
          </Button>
          {onDedupe ? (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={saved.length === 0 || deduping}
              onClick={onDedupe}
            >
              {deduping ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Layers className="h-4 w-4" />
              )}
              Remove duplicates
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            type="button"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            Clear {itemLabel}…
          </Button>
        </div>
      </div>

      <div className="space-y-3 border-b border-border/60 px-4 py-3">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 pl-9 text-sm"
            placeholder="Search title or ASIN…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
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
            label="Has Amazon price"
            checked={hasAmazonPrice}
            onChange={(e) => {
              setHasAmazonPrice(e.target.checked);
              if (e.target.checked) setMissingAmazonPrice(false);
            }}
          />
          <Checkbox
            className="text-xs"
            label="Missing price"
            checked={missingAmazonPrice}
            onChange={(e) => {
              setMissingAmazonPrice(e.target.checked);
              if (e.target.checked) setHasAmazonPrice(false);
            }}
          />

          {sellers.length > 0 ? (
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
          ) : null}

          <Select
            className="h-8 w-auto text-xs"
            value={String(minMatchConfidence || MIN_MATCH_CONFIDENCE)}
            onChange={(e) => {
              const v = Number(e.target.value);
              setMinMatchConfidence(v <= MIN_MATCH_CONFIDENCE ? 0 : v);
            }}
          >
            <option value={MIN_MATCH_CONFIDENCE}>Match: any 80%+</option>
            <option value={0.9}>Match: 90%+</option>
            <option value={0.95}>Match: 95%+</option>
          </Select>

          <div className="flex items-center gap-1.5 text-xs text-foreground/80">
            <span>Sold $</span>
            <Input
              type="number"
              className="h-8 w-16"
              value={minSoldPrice || ""}
              min={0}
              step={1}
              placeholder="min"
              onChange={(e) => setMinSoldPrice(Number(e.target.value) || 0)}
            />
            <span>–</span>
            <Input
              type="number"
              className="h-8 w-16"
              value={maxSoldPrice || ""}
              min={0}
              step={1}
              placeholder="max"
              onChange={(e) => setMaxSoldPrice(Number(e.target.value) || 0)}
            />
          </div>

          <div className="flex items-center gap-1.5 text-xs text-foreground/80">
            <span>Amazon $</span>
            <Input
              type="number"
              className="h-8 w-16"
              value={minAmazonPrice || ""}
              min={0}
              step={1}
              placeholder="min"
              onChange={(e) => setMinAmazonPrice(Number(e.target.value) || 0)}
            />
            <span>–</span>
            <Input
              type="number"
              className="h-8 w-16"
              value={maxAmazonPrice || ""}
              min={0}
              step={1}
              placeholder="max"
              onChange={(e) => setMaxAmazonPrice(Number(e.target.value) || 0)}
            />
          </div>

          <div className="flex items-center gap-1.5 text-xs text-foreground/80">
            <span>Min margin</span>
            <Input
              type="number"
              className="h-8 w-14"
              value={minMargin || ""}
              min={0}
              placeholder="0"
              onChange={(e) => setMinMargin(Number(e.target.value) || 0)}
            />
            <span>%</span>
          </div>

          <Select
            className="h-8 w-auto text-xs"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
          >
            <option value="profit">Sort: Profit</option>
            <option value="margin">Sort: Margin</option>
            <option value="sold_price">Sort: Sold price</option>
            <option value="amazon_price">Sort: Amazon price</option>
            <option value="match">Sort: Match %</option>
            <option value="sold_date">Sort: Recent sold</option>
          </Select>

          {filtersActive ? (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={filteredAsins.length === 0}
              onClick={() =>
                copyAsinsFromListings(filtered.filter((l) => l.amazon_asin))
              }
            >
              <Copy className="h-4 w-4" />
              Copy {filteredAsins.length} filtered ASINs
            </Button>
          ) : null}

          {filtersActive ? (
            <Button variant="ghost" size="sm" type="button" onClick={clearFilters}>
              <X className="h-4 w-4" />
              Clear filters
            </Button>
          ) : null}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
              <th className="w-10 px-3 py-2.5 font-medium">
                <Checkbox
                  aria-label="Select all filtered"
                  checked={allFilteredSelected}
                  onChange={toggleAllFiltered}
                  title={
                    filtered.length > PAGE_SIZE
                      ? `Select all ${filtered.length} filtered (all pages)`
                      : "Select all filtered"
                  }
                />
              </th>
              <th className="px-3 py-2.5 font-medium">Product</th>
              <th className="px-3 py-2.5 font-medium">ASIN</th>
              <th className="px-3 py-2.5 text-right font-medium">Sold</th>
              <th className="px-3 py-2.5 text-right font-medium">Amazon</th>
              <th className="px-3 py-2.5 text-right font-medium">Profit</th>
              <th className="px-3 py-2.5 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-muted-foreground">
                  No {itemLabel} products match these filters.
                  {filtersActive ? (
                    <button
                      type="button"
                      className="ml-2 text-accent hover:underline"
                      onClick={clearFilters}
                    >
                      Clear filters
                    </button>
                  ) : null}
                </td>
              </tr>
            ) : (
              visible.map((row) => {
                const key = rowKey(row);
                return (
                  <SavedRow
                    key={key}
                    listing={row}
                    profit={row}
                    selected={selected.has(key)}
                    onToggle={() => toggleRow(key)}
                    onUnsave={() => onUnsave(row)}
                    onCopyListing={() => copyListings([row])}
                    unsaveLabel={isReserved ? "Back to Saved" : "Unsave"}
                    unsaveAriaLabel={
                      isReserved ? "Move back to Saved" : "Unsave — move back to Found"
                    }
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 ? (
        <div className="flex items-center justify-between border-t border-border/60 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Showing {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filtered.length)} of{" "}
            {filtered.length}
            {filtersActive ? ` (${saved.length} total)` : ""}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={safePage <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
              Prev
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground">
              {safePage + 1} / {pageCount}
            </span>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
