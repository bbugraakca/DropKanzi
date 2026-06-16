/** Minimum match confidence to treat a listing as a valid Amazon match. */
export const MIN_MATCH_CONFIDENCE = 0.8;

/** 0–1 scale; older rows may store 0–100. */
export function effectiveMatchConfidence(
  conf: number | null | undefined
): number {
  if (conf == null) return 0;
  const n = Number(conf);
  if (!Number.isFinite(n)) return 0;
  if (n > 1 && n <= 100) return n / 100;
  return n;
}

export function isAcceptedMatch(listing: {
  amazon_asin?: string | null;
  match_confidence?: number | null;
  match_method?: string | null;
}): boolean {
  if (!listing.amazon_asin) return false;
  if (listing.match_method === "description") return true;
  return effectiveMatchConfidence(listing.match_confidence) >= MIN_MATCH_CONFIDENCE;
}

export function countAcceptedMatches<
  T extends {
    amazon_asin?: string | null;
    match_confidence?: number | null;
    match_method?: string | null;
  },
>(listings: T[]): number {
  return filterAcceptedMatches(listings).length;
}

export function countAcceptedPricesLoaded<
  T extends {
    amazon_asin?: string | null;
    match_confidence?: number | null;
    match_method?: string | null;
    amazon_price?: number | null;
  },
>(listings: T[]): number {
  return filterAcceptedMatches(listings).filter((l) => l.amazon_price != null).length;
}

export function filterAcceptedMatches<T extends { amazon_asin?: string | null; match_confidence?: number | null; match_method?: string | null }>(
  listings: T[]
): T[] {
  return listings.filter(isAcceptedMatch);
}
