"use client";

import { Loader2, Clock, CheckCircle2, XCircle, Trash2, X, RefreshCw, Search, Octagon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { formatBytes } from "@/lib/formatBytes";
import { fmtCostUsd, fmtProxyCost } from "@/lib/formatProxyCost";
import { cn } from "@/lib/utils";

export type QueueStatus = "queued" | "running" | "done" | "failed";

export type QueueItem = {
  id: string;
  seller: string;
  /** Raw input sent to analyze API (full eBay URL when pasted). */
  sellerInput?: string;
  daysBack: number;
  /** When true, bypasses 7-day DB cache and re-scrapes (proxy cost). */
  forceRefresh?: boolean;
  /** When false, analyze skips Amazon price fetch (match only). */
  fetchPrices?: boolean;
  /** sold = sold history scan; active = live store inventory. */
  scanMode?: "sold" | "active";
  status: QueueStatus;
  matched?: number;
  /** Rows actually merged into Found on this run (may differ from queue label on old cache). */
  foundAdded?: number;
  total?: number;
  pricesLoaded?: number;
  pricesTotal?: number;
  error?: string;
  costUsd?: number;
  costBytes?: number;
  costRequests?: number;
  cached?: boolean;
  matchSkipped?: number;
  matchAttempted?: number;
  captchaAborted?: boolean;
  ebayStatus?: string;
  ebayMessage?: string;
  ebaySellerId?: string;
  ebayStoreResolved?: boolean;
  costStages?: Record<string, { bytes: number; requests: number; cost_usd: number }>;
  serpLookups?: number;
  serpProxy?: number;
  serpDirect?: number;
};

const STAGE_LABELS: Record<string, string> = {
  ebay_search: "eBay search",
  ebay_detail: "eBay details",
  amazon_search: "Amazon search",
  amazon_price: "Amazon price",
  other: "Other",
};

function fmtPricesLoaded(loaded?: number, total?: number): string | null {
  if (loaded == null || total == null || total <= 0) return null;
  return `${loaded}/${total} prices`;
}

function fmtQueueMeta(item: QueueItem): string {
  const parts: string[] =
    item.scanMode === "active"
      ? ["Live inventory scan"]
      : [`Last ${item.daysBack} days`];
  if (item.status === "done") {
    if (item.total != null) {
      const matched = item.matched ?? 0;
      parts.push(`${matched} match (80%+) · ${item.total} eBay ${item.scanMode === "active" ? "live" : "sold"}`);
      if (item.ebayStoreResolved && item.ebaySellerId && item.ebaySellerId !== item.seller) {
        parts.push(`store → ${item.ebaySellerId}`);
      }
      if (
        item.foundAdded != null &&
        item.foundAdded > 0 &&
        item.foundAdded !== matched
      ) {
        parts.push(`${item.foundAdded} in Found`);
      } else if (matched > 0 && item.foundAdded === 0) {
        parts.push("0 in Found — tap Import on Sellers tab");
      }
      if (matched === 0 && (item.total ?? 0) === 0 && item.ebayMessage) {
        parts.push(item.ebayMessage);
      } else if (matched === 0 && item.total != null && item.total > 400) {
        parts.push("large seller");
      }
    }
    if (item.matchAttempted != null && item.matchSkipped != null && item.matchSkipped > 0) {
      parts.push(`searched ${item.matchAttempted} unique titles`);
    }
    if (item.matchSkipped != null && item.matchSkipped > 0) {
      parts.push(`${item.matchSkipped} titles skipped (cap)`);
    }
    if (item.captchaAborted) {
      parts.push("Amazon captcha (SERP)");
    }
    const prices = fmtPricesLoaded(item.pricesLoaded, item.pricesTotal);
    if (prices) {
      parts.push(prices);
      if (item.pricesLoaded === 0 && (item.pricesTotal ?? 0) > 0) {
        parts.push("use Fetch prices on Found");
      }
    }
    if (item.cached) parts.push("cached");
    else if (item.forceRefresh) parts.push("fresh scan");
  }
  if (item.status === "failed" && item.error) {
    parts.push(item.error);
  } else if (item.status === "failed") {
    /* keep days only */
  }
  return parts.join(" · ");
}

function stageTooltip(item: QueueItem): string {
  if (!item.costStages || Object.keys(item.costStages).length === 0) {
    if (item.cached) return "Loaded from cache — no proxy traffic";
    return "Proxy cost for this search";
  }
  const lines = Object.entries(item.costStages).map(([name, s]) => {
    const mb = s.bytes > 0 ? formatBytes(s.bytes) : "—";
    return `${STAGE_LABELS[name] ?? name}: ${mb} · ${fmtCostUsd(s.cost_usd)} (${s.requests} req)`;
  });
  return `Proxy cost by stage\n${lines.join("\n")}`;
}

const STATUS_META: Record<
  QueueStatus,
  { label: string; icon: typeof Clock; className: string }
> = {
  queued: { label: "Queued", icon: Clock, className: "text-text-3" },
  running: { label: "Analyzing", icon: Loader2, className: "text-accent" },
  done: { label: "Done", icon: CheckCircle2, className: "text-green" },
  failed: { label: "Failed", icon: XCircle, className: "text-red" },
};

export function QueuePanel({
  items,
  onRemove,
  onClearFinished,
  onRetry,
  onRetryAllFailed,
  onStopAll,
}: {
  items: QueueItem[];
  onRemove: (id: string) => void;
  onClearFinished: () => void;
  onRetry?: (id: string) => void;
  onRetryAllFailed?: () => void;
  onStopAll?: () => void;
}) {
  if (items.length === 0) {
    return (
      <div className="pf-panel pf-empty">
        <Search className="mb-3 h-7 w-7 text-text-3" aria-hidden />
        <p className="text-[14px] font-medium text-text-1">Queue is empty</p>
        <p className="mt-1 max-w-sm text-[13px] text-text-3">
          Enter an eBay seller above and click Analyze. Finished scans appear in the
          Sellers tab.
        </p>
      </div>
    );
  }

  const totalRequests = items.reduce(
    (sum, i) => sum + (i.cached ? 0 : i.costRequests ?? 0),
    0
  );
  const finished = items.filter((i) => i.status === "done" || i.status === "failed").length;
  const failedCount = items.filter((i) => i.status === "failed").length;
  const waitingCount = items.filter((i) => i.status === "queued").length;
  const runningCount = items.filter((i) => i.status === "running").length;
  const totalBytes = items.reduce(
    (sum, i) => sum + (i.cached ? 0 : i.costBytes ?? 0),
    0
  );
  const totalCost = items.reduce((sum, i) => sum + (i.cached ? 0 : i.costUsd ?? 0), 0);

  return (
    <div className="pf-panel">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-[13px] font-semibold text-text-1">
          Active queue
          <span className="ml-2 text-[12px] font-normal text-text-3">
            {items.length} seller{items.length === 1 ? "" : "s"}
          </span>
        </p>
        <div className="flex items-center gap-3">
          <span
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-text-2"
            title="Total proxy traffic this session ($1 per GB)"
          >
            <span className="text-text-3">Proxy</span>
            <span className="font-mono tabular-nums">
              {fmtProxyCost(totalBytes, totalCost, false, totalRequests)}
            </span>
          </span>
          {waitingCount > 0 && onStopAll ? (
            <Button variant="secondary" className="h-8 px-2 text-xs" onClick={onStopAll}>
              <Octagon className="h-3.5 w-3.5" />
              Stop queue ({waitingCount} waiting)
            </Button>
          ) : null}
          {failedCount > 0 && onRetryAllFailed ? (
            <Button variant="secondary" className="h-8 px-2 text-xs" onClick={onRetryAllFailed}>
              <RefreshCw className="h-3.5 w-3.5" />
              Retry failed ({failedCount})
            </Button>
          ) : null}
          {finished > 0 ? (
            <Button variant="ghost" className="h-8 px-2 text-xs" onClick={onClearFinished}>
              <Trash2 className="h-3.5 w-3.5" />
              Clear finished
            </Button>
          ) : null}
        </div>
      </div>
      {runningCount > 0 && waitingCount > 0 ? (
        <p className="border-b border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
          {runningCount} scan running · {waitingCount} waiting — Stop queue clears waiting only.
        </p>
      ) : null}

      <ul className="divide-y divide-border">
        {items.map((item, idx) => {
          const meta = STATUS_META[item.status];
          const Icon = meta.icon;
          return (
            <li key={item.id} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/60">
              <span className="w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-text-3">
                {idx + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-text-1">
                  {item.seller}
                </p>
                <p
                  className="text-[12px] text-text-3"
                  title={item.status === "done" ? stageTooltip(item) : undefined}
                >
                  {fmtQueueMeta(item)}
                </p>
              </div>
              {item.status === "done" ? (
                <span
                  className="shrink-0 cursor-help text-xs tabular-nums font-medium text-text-body"
                  title={stageTooltip(item)}
                >
                  {fmtProxyCost(item.costBytes, item.costUsd, item.cached, item.costRequests)}
                </span>
              ) : item.status === "failed" && (item.costBytes ?? 0) > 0 ? (
                <span
                  className="shrink-0 text-xs tabular-nums text-muted-foreground"
                  title={stageTooltip(item)}
                >
                  {fmtProxyCost(item.costBytes, item.costUsd, item.cached, item.costRequests)}
                </span>
              ) : null}
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 text-xs font-medium",
                  meta.className
                )}
              >
                <Icon
                  className={cn("h-4 w-4", item.status === "running" && "animate-spin")}
                />
                {meta.label}
              </span>
              {item.status !== "running" ? (
                <div className="flex items-center gap-0.5">
                  {item.status === "failed" && onRetry ? (
                    <button
                      type="button"
                      onClick={() => onRetry(item.id)}
                      className="rounded-md p-1 text-text-muted hover:bg-surface-muted hover:text-accent"
                      aria-label="Retry seller"
                      title="Retry"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onRemove(item.id)}
                    className="rounded-md p-1 text-text-muted hover:bg-surface-muted hover:text-text-body"
                    aria-label="Remove from queue"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <span className="w-6" />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
