export type ProxyStageStats = {
  bytes: number;
  requests: number;
  cost_usd: number;
};

export type ProxySummary = {
  proxy_bytes?: number;
  proxy_cost_usd?: number;
  proxy_requests?: number;
  proxy_stages?: Record<string, ProxyStageStats>;
};

export function mergeProxyStages(
  a?: Record<string, ProxyStageStats> | null,
  b?: Record<string, ProxyStageStats> | null
): Record<string, ProxyStageStats> | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, ProxyStageStats> = { ...(a ?? {}) };
  for (const [name, stage] of Object.entries(b ?? {})) {
    const prev = out[name] ?? { bytes: 0, requests: 0, cost_usd: 0 };
    out[name] = {
      bytes: prev.bytes + stage.bytes,
      requests: prev.requests + stage.requests,
      cost_usd: Math.round((prev.cost_usd + stage.cost_usd) * 10000) / 10000,
    };
  }
  return out;
}

export function addProxyTotals(
  base: ProxySummary,
  extra: ProxySummary
): {
  costUsd: number;
  costBytes: number;
  costRequests: number;
  costStages?: Record<string, ProxyStageStats>;
} {
  const costUsd = (base.proxy_cost_usd ?? 0) + (extra.proxy_cost_usd ?? 0);
  const costBytes = (base.proxy_bytes ?? 0) + (extra.proxy_bytes ?? 0);
  const costRequests = (base.proxy_requests ?? 0) + (extra.proxy_requests ?? 0);
  const costStages = mergeProxyStages(base.proxy_stages, extra.proxy_stages);
  return { costUsd, costBytes, costRequests, costStages };
}
