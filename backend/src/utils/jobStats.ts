export type ItemScrapeStat = {
  bytesDownloaded: number;
  fetchType?: string;
};

export function parseItemStats(raw: unknown): Record<string, ItemScrapeStat> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ItemScrapeStat> = {};
  for (const [asin, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== "object") continue;
    const row = val as Record<string, unknown>;
    const bytes =
      typeof row.bytesDownloaded === "number"
        ? row.bytesDownloaded
        : typeof row.bytes_downloaded === "number"
          ? row.bytes_downloaded
          : 0;
    out[asin] = {
      bytesDownloaded: bytes,
      fetchType:
        typeof row.fetchType === "string"
          ? row.fetchType
          : typeof row.fetch_type === "string"
            ? row.fetch_type
            : undefined,
    };
  }
  return out;
}

export function sumItemStatsBytes(stats: Record<string, ItemScrapeStat>): number {
  return Object.values(stats).reduce((sum, s) => sum + (s.bytesDownloaded || 0), 0);
}
