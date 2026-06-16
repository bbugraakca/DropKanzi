/** Parse optional numeric query/body filter; rejects NaN and non-finite values. */
export function parseNumericFilter(
  raw: unknown,
  opts?: { min?: number; exclusiveMin?: boolean }
): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw).trim());
  if (!Number.isFinite(n)) return undefined;
  const min = opts?.min ?? 0;
  if (opts?.exclusiveMin ? n <= min : n < min) return undefined;
  return n;
}

/** Restrict ORDER BY / sort keys to an allowlist. */
export function parseSortColumn<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  const key = String(raw ?? "").trim() as T;
  return allowed.includes(key) ? key : fallback;
}
