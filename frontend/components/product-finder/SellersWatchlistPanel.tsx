"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  RefreshCw,
  Plus,
  Search,
  Trash2,
  Upload,
  Users,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { toast } from "sonner";
import {
  clearSellerHistory,
  importSellersToWatchlist,
  removeSellerFromHistory,
  SELLER_HISTORY_MAX,
  uniqueSellerHistory,
  WEEKLY_REFRESH_DAYS,
  type StoredSellerSearch,
} from "@/lib/productFinderStorage";
import { fmtCostUsd, formatProxyStageLines, fmtProxyCostDetail } from "@/lib/formatProxyCost";
import { formatBytes } from "@/lib/formatBytes";
import { fetchFoundSellerCounts, fetchActiveSellerCounts } from "@/lib/api";

const STAGE_LABELS: Record<string, string> = {
  ebay_search: "eBay",
  ebay_detail: "eBay details",
  amazon_search: "Amazon searches",
  amazon_price: "Amazon price",
  other: "Other",
};

function stageTooltip(entry: StoredSellerSearch): string | undefined {
  if (entry.cached) {
    return "Server cache — no new proxy traffic this run";
  }
  const lines = formatProxyStageLines(entry.costStages);
  const header =
    "Residential proxy bandwidth only (DataImpulse — direct/no-proxy SERP is free). " +
    "Amazon SERP = search page fetches; unique titles = eBay title groups matched.";
  if (lines.length === 0) {
    if ((entry.costBytes ?? 0) > 0) {
      return `${header}\n${formatBytes(entry.costBytes)} total · ${fmtCostUsd(entry.costUsd ?? 0)} @ ~$1/GB`;
    }
    return undefined;
  }
  return [header, ...lines].join("\n");
}

function ProxyCostCell({ entry }: { entry: StoredSellerSearch }) {
  if (entry.cached) {
    return (
      <span className="text-[12px] font-medium text-green">$0 · cached</span>
    );
  }
  const detail = fmtProxyCostDetail(
    entry.costBytes,
    entry.costUsd,
    entry.cached,
    entry.costRequests,
    entry.costStages,
    { matched: entry.matched, titlesSearched: entry.matchTitlesAttempted,
      serpLookups: entry.serpLookups,
      serpProxy: entry.serpProxy,
      serpDirect: entry.serpDirect,
    }
  );
  const stages = formatProxyStageLines(entry.costStages);

  return (
    <div className="max-w-[12rem]" title={stageTooltip(entry)}>
      <div className="font-mono text-[12px] font-medium tabular-nums text-text-1">
        {detail.primary}
        <span className="ml-1 font-sans font-normal text-text-3">proxy</span>
      </div>
      {detail.secondary ? (
        <div className="text-[11px] leading-snug text-text-3">{detail.secondary}</div>
      ) : null}
      {stages.length > 0 ? (
        <details className="mt-0.5 text-[10px] text-text-3">
          <summary className="cursor-pointer hover:text-text-2">Stage breakdown</summary>
          <ul className="mt-1 space-y-0.5 pl-2">
            {stages.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function fmtLastScan(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const now = Date.now();
  const diffMs = now - ts;
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function queueKey(seller: string, daysBack: number): string {
  return `${seller.toLowerCase()}::${daysBack}`;
}

export function SellersWatchlistPanel({
  refreshKey = 0,
  activeQueueKeys,
  onRefreshOne,
  onRefreshMany,
  onRefreshAll,
  onChanged,
  onSellerRemoved,
  onViewInFound,
  onViewInActive,
  onScanActive,
  onImportToFound,
  onImportManyToFound,
  importingSeller,
  importingBulk,
}: {
  refreshKey?: number;
  /** sellerLower::daysBack for queued/running items */
  activeQueueKeys: Set<string>;
  onRefreshOne: (entry: StoredSellerSearch) => void;
  onRefreshMany: (entries: StoredSellerSearch[]) => void;
  onRefreshAll: () => void;
  onChanged?: () => void;
  /** Drop seller from in-memory queue when removed from watchlist. */
  onSellerRemoved?: (seller: string) => void;
  onViewInFound: (seller: string) => void;
  onViewInActive: (seller: string) => void;
  onScanActive: (seller: string) => void;
  onImportToFound: (entry: StoredSellerSearch) => void;
  onImportManyToFound: (entries: StoredSellerSearch[]) => void;
  importingSeller?: string | null;
  importingBulk?: boolean;
}) {
  const [history, setHistory] = useState<StoredSellerSearch[]>([]);
  const [foundCounts, setFoundCounts] = useState<Record<string, number>>({});
  const [activeCounts, setActiveCounts] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  useEffect(() => {
    setHistory(uniqueSellerHistory());
    setSelected(new Set());
    void fetchFoundSellerCounts()
      .then((r) => setFoundCounts(r.counts))
      .catch(() => setFoundCounts({}));
    void fetchActiveSellerCounts()
      .then((r) => setActiveCounts(r.counts))
      .catch(() => setActiveCounts({}));
  }, [refreshKey]);

  const handleImport = () => {
    const names = importText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 0) {
      toast.message("Paste seller names or URLs (one per line).");
      return;
    }
    const result = importSellersToWatchlist(names);
    setHistory(uniqueSellerHistory());
    setImportText("");
    setImportOpen(false);
    onChanged?.();
    if (result.added > 0) {
      toast.success(
        `Added ${result.added} seller(s) · ${result.total} in watchlist (max ${SELLER_HISTORY_MAX})`
      );
    } else {
      toast.message(`All ${names.length} already in watchlist (${result.total} total).`);
    }
    if (result.truncated) {
      toast.warning(
        `Watchlist capped at ${SELLER_HISTORY_MAX} — remove sellers or clear list to add more.`
      );
    }
  };

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return history;
    return history.filter(
      (e) =>
        e.seller.toLowerCase().includes(q) ||
        (e.ebaySellerId?.toLowerCase().includes(q) ?? false)
    );
  }, [history, deferredQuery]);

  const allSelected =
    filtered.length > 0 && filtered.every((e) => selected.has(e.seller.toLowerCase()));

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((e) => e.seller.toLowerCase())));
    }
  };

  const toggleOne = (seller: string) => {
    const key = seller.toLowerCase();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedEntries = filtered.filter((e) => selected.has(e.seller.toLowerCase()));
  const entriesNeedingImport = useMemo(() => {
    return history.filter((entry) => {
      const key = entry.seller.toLowerCase();
      const inFound = foundCounts[key] ?? 0;
      const scanned = entry.matched ?? 0;
      return scanned > 0 && inFound < scanned;
    });
  }, [history, foundCounts]);
  const selectedImportable = selectedEntries.filter((e) => (e.matched ?? 0) > 0);
  const importBusy = importingBulk || Boolean(importingSeller);
  const queuedCount = filtered.filter((e) =>
    activeQueueKeys.has(queueKey(e.seller, WEEKLY_REFRESH_DAYS))
  ).length;

  if (history.length === 0) {
    return (
      <div className="pf-panel pf-empty">
        <Users className="mb-3 h-7 w-7 text-text-3" aria-hidden />
        <p className="text-[14px] font-medium text-text-1">No sellers yet</p>
        <p className="mt-1 max-w-md text-[13px] text-text-3">
          Analyze sellers above, or import your watchlist below.
        </p>
      </div>
    );
  }

  return (
    <div className="pf-panel">
      <div className="border-b border-border p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-[14px] font-semibold text-text-1">
              <Users className="h-4 w-4 text-text-3" />
              Seller watchlist
              <span className="font-normal text-text-3">
                ({history.length}
                {history.length >= SELLER_HISTORY_MAX ? " · full" : ` / ${SELLER_HISTORY_MAX}`})
              </span>
            </h2>
            <p className="mt-1 max-w-2xl text-[12px] text-text-3">
              Refresh all runs a {WEEKLY_REFRESH_DAYS}-day scan per seller. Cached scans skip proxy.
              Use View in Found to filter results per seller.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={entriesNeedingImport.length === 0 || importBusy}
              onClick={() => onImportManyToFound(entriesNeedingImport)}
            >
              {importBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              Import all pending ({entriesNeedingImport.length})
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={selectedImportable.length === 0 || importBusy}
              onClick={() => onImportManyToFound(selectedImportable)}
            >
              <Upload className="h-4 w-4" />
              Import selected ({selectedImportable.length})
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => setImportOpen((v) => !v)}
            >
              <Plus className="h-4 w-4" />
              Import sellers
            </Button>
            <Button
              size="sm"
              type="button"
              onClick={onRefreshAll}
              disabled={history.length === 0}
            >
              <Zap className="h-4 w-4" />
              Refresh all — {WEEKLY_REFRESH_DAYS} days ({history.length})
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={selectedEntries.length === 0}
              onClick={() => onRefreshMany(selectedEntries)}
            >
              <RefreshCw className="h-4 w-4" />
              Refresh selected ({selectedEntries.length})
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                for (const e of history) {
                  onSellerRemoved?.(e.seller);
                }
                clearSellerHistory();
                setHistory([]);
                setSelected(new Set());
                onChanged?.();
              }}
            >
              <Trash2 className="h-4 w-4" />
              Clear list
            </Button>
          </div>
        </div>

        {queuedCount > 0 ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-xs text-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
            {queuedCount} of {history.length} in queue for {WEEKLY_REFRESH_DAYS}-day refresh — check
            Queue tab for progress.
          </div>
        ) : null}
      </div>

      {importOpen ? (
        <div className="space-y-2 border-b border-border/60 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Paste seller usernames or eBay URLs — one per line (or comma-separated). Up to{" "}
            {SELLER_HISTORY_MAX} unique sellers.
          </p>
          <textarea
            className="min-h-[120px] w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
            placeholder={"seller-one\nseller-two\nhttps://www.ebay.com/usr/..."}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="button" onClick={handleImport}>
              Add to watchlist
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                setImportOpen(false);
                setImportText("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div className="border-b border-border/60 px-4 py-3">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 pl-9 text-sm"
            placeholder="Filter sellers…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
              <th className="w-10 px-3 py-2.5 font-medium">
                <Checkbox
                  aria-label="Select all sellers"
                  checked={allSelected}
                  onChange={toggleAll}
                />
              </th>
              <th className="px-3 py-2.5 font-medium">Seller</th>
              <th className="px-3 py-2.5 font-medium">Last scan</th>
              <th className="px-3 py-2.5 font-medium">In Found</th>
              <th className="px-3 py-2.5 font-medium">Live</th>
              <th className="px-3 py-2.5 font-medium">Scan stats</th>
              <th
                className="px-3 py-2.5 font-medium"
                title="Estimated residential proxy cost from last scan — billed by your proxy provider, not us"
              >
                Proxy est.
              </th>
              <th className="px-3 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-sm text-muted-foreground">
                  No sellers match &quot;{query}&quot;.
                </td>
              </tr>
            ) : (
              filtered.map((entry) => {
                const key = entry.seller.toLowerCase();
                const inFound = foundCounts[key] ?? 0;
                const inLive = activeCounts[key] ?? 0;
                const scanned = entry.matched ?? 0;
                const needsImport = scanned > 0 && inFound < scanned;
                const importing = importingSeller?.toLowerCase() === key;
                const inQueue = activeQueueKeys.has(
                  queueKey(entry.seller, WEEKLY_REFRESH_DAYS)
                );
                const inLiveQueue = activeQueueKeys.has(`${key}::live`);
                const failed = entry.status === "failed";
                return (
                  <tr
                    key={`${key}-${entry.lastUsed}`}
                    className="border-b border-border/40 last:border-0 hover:bg-surface-hover/50"
                  >
                    <td className="px-3 py-3">
                      <Checkbox
                        aria-label={`Select ${entry.seller}`}
                        checked={selected.has(key)}
                        onChange={() => toggleOne(entry.seller)}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-medium text-foreground">{entry.seller}</p>
                      {entry.ebaySellerId && entry.ebaySellerId !== entry.seller ? (
                        <p className="text-xs text-muted-foreground">store → {entry.ebaySellerId}</p>
                      ) : null}
                      {failed && entry.error ? (
                        <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{entry.error}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {fmtLastScan(entry.lastUsed)}
                      </span>
                      <div className="mt-0.5 tabular-nums">{entry.daysBack}d window</div>
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {inFound > 0 ? (
                        <button
                          type="button"
                          className="font-semibold tabular-nums text-accent hover:underline"
                          onClick={() => onViewInFound(entry.seller)}
                        >
                          {inFound.toLocaleString()} in Found
                        </button>
                      ) : scanned > 0 ? (
                        <span className="font-medium text-amber-700 dark:text-amber-400">
                          0 in Found
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {needsImport ? (
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          scan saved — click Import to load matched rows into Found
                        </div>
                      ) : inFound > 0 && scanned > 0 && inFound >= scanned * 0.95 ? (
                        <div className="mt-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">
                          all matched rows in Found
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {inLive > 0 ? (
                        <button
                          type="button"
                          className="font-semibold tabular-nums text-accent hover:underline"
                          onClick={() => onViewInActive(entry.seller)}
                        >
                          {inLive.toLocaleString()} live
                        </button>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {entry.matched != null && entry.total != null ? (
                        <div className="space-y-0.5">
                          <span className="inline-flex items-center gap-1 text-foreground">
                            {failed ? (
                              <X className="h-3 w-3 text-red-500" />
                            ) : (
                              <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                            )}
                            {entry.matched.toLocaleString()} matched · {entry.total.toLocaleString()}{" "}
                            sold
                          </span>
                          {entry.matchTitlesAttempted != null && entry.matchTitlesAttempted > 0 ? (
                            <p className="text-[10px] leading-snug text-text-3">
                              {entry.matchTitlesAttempted.toLocaleString()} unique titles searched on Amazon
                              {entry.matched === 0 && (entry.costBytes ?? 0) > 0
                                ? " — none reached 80% match"
                                : ""}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <ProxyCostCell entry={entry} />
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        {inFound > 0 ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            type="button"
                            className="h-8 px-2 text-xs"
                            onClick={() => onViewInFound(entry.seller)}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Found
                          </Button>
                        ) : null}
                        {inLive > 0 ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            type="button"
                            className="h-8 px-2 text-xs"
                            onClick={() => onViewInActive(entry.seller)}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Live
                          </Button>
                        ) : null}
                        {inLiveQueue ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Live…
                          </span>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            type="button"
                            className="h-8 px-2 text-xs"
                            onClick={() => onScanActive(entry.seller)}
                          >
                            <Zap className="h-3.5 w-3.5" />
                            Scan Live
                          </Button>
                        )}
                        {needsImport ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            type="button"
                            className="h-8 px-2 text-xs"
                            disabled={importing || importBusy}
                            onClick={() => onImportToFound(entry)}
                          >
                            {importing ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Upload className="h-3.5 w-3.5" />
                            )}
                            Import
                          </Button>
                        ) : null}
                        {inQueue ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Queued
                          </span>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            type="button"
                            className="h-8 px-2 text-xs"
                            onClick={() => onRefreshOne(entry)}
                          >
                            <CalendarClock className="h-3.5 w-3.5" />
                            {WEEKLY_REFRESH_DAYS}d
                          </Button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setHistory(removeSellerFromHistory(entry.seller));
                            onSellerRemoved?.(entry.seller);
                            onChanged?.();
                          }}
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-surface-muted hover:text-foreground"
                          aria-label={`Remove ${entry.seller}`}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
