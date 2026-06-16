import { formatBytes } from "./formatBytes";

export function fmtCostUsd(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

const STAGE_LABELS: Record<string, string> = {
  ebay_search: "eBay",
  ebay_detail: "eBay details",
  amazon_search: "Amazon searches",
  amazon_price: "Amazon price",
  other: "Other",
};

/** Human-readable per-stage proxy cost lines for tooltips / breakdown UI. */
export function formatProxyStageLines(
  stages?: Record<string, { bytes: number; requests: number; cost_usd: number }>
): string[] {
  if (!stages || Object.keys(stages).length === 0) return [];
  return Object.entries(stages)
    .filter(([, s]) => s.bytes > 0 || s.cost_usd > 0)
    .sort((a, b) => b[1].cost_usd - a[1].cost_usd)
    .map(([name, s]) => {
      const label = STAGE_LABELS[name] ?? name;
      const usd =
        s.cost_usd < 0.01 ? `$${s.cost_usd.toFixed(4)}` : `$${s.cost_usd.toFixed(2)}`;
      const mb = formatBytes(s.bytes);
      const req = s.requests > 0 ? `${s.requests} req` : "0 req";
      return `${label}: ${usd} · ${mb} · ${req}`;
    });
}

/** Proxy traffic label for queue / past sellers. */
export function fmtProxyCost(
  bytes?: number,
  usd?: number,
  cached?: boolean,
  requests?: number
): string {
  if (cached) return "$0 · cached";
  const cost = fmtCostUsd(usd ?? 0);
  const parts: string[] = [];
  if (bytes && bytes > 0) parts.push(formatBytes(bytes));
  if (requests && requests > 0) parts.push(`${requests.toLocaleString()} req`);
  if (parts.length > 0) return `~${cost} · ${parts.join(" · ")}`;
  if ((usd ?? 0) > 0) return `~${cost}`;
  return "$0";
}

/** Compact one-line proxy summary for table cells. */
export function fmtProxyCostDetail(
  bytes?: number,
  usd?: number,
  cached?: boolean,
  requests?: number,
  stages?: Record<string, { bytes: number; requests: number; cost_usd: number }>,
  opts?: {
    matched?: number;
    titlesSearched?: number;
    serpLookups?: number;
    serpProxy?: number;
    serpDirect?: number;
  }
): { primary: string; secondary: string | null } {
  if (cached) {
    return { primary: "$0 · cached", secondary: null };
  }
  const primary = fmtCostUsd(usd ?? 0);
  const bits: string[] = [];
  if (bytes && bytes > 0) bits.push(`${formatBytes(bytes)} proxy`);
  const amazonStage = stages?.amazon_search;
  const serpProxy = opts?.serpProxy ?? amazonStage?.requests ?? 0;
  const serpTotal = opts?.serpLookups ?? (serpProxy + (opts?.serpDirect ?? 0));
  if (serpTotal > 0) {
    const hitNote =
      opts?.matched === 0
        ? " · 0 matched"
        : opts?.matched != null && opts.matched > 0
          ? ` · ${opts.matched.toLocaleString()} matched`
          : "";
    const viaProxy =
      serpProxy > 0 && serpProxy < serpTotal
        ? ` (${serpProxy.toLocaleString()} via proxy)`
        : serpProxy > 0 && serpProxy === serpTotal
          ? " (all proxy)"
          : "";
    bits.push(`${serpTotal.toLocaleString()} Amazon SERP${viaProxy}${hitNote}`);
  } else if (requests && requests > 0) {
    bits.push(`${requests.toLocaleString()} proxied requests`);
  }
  if (opts?.titlesSearched != null && opts.titlesSearched > 0) {
    bits.push(`${opts.titlesSearched.toLocaleString()} unique titles`);
  }
  return {
    primary: `~${primary}`,
    secondary: bits.length > 0 ? bits.join(" · ") : null,
  };
}
