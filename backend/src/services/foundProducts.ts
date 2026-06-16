/** Helpers for accumulated Found products (DB + merge logic). */

import { isPlausibleAsin } from "../utils/asin";

export type FinderListing = Record<string, unknown>;

/** Sold date + price + qty — same eBay item can sell many times in one window. */
function soldEventPart(l: FinderListing): string {
  const d = String(l.sold_date ?? "").slice(0, 10);
  const p =
    l.sold_price != null && Number.isFinite(Number(l.sold_price))
      ? Number(l.sold_price).toFixed(2)
      : "";
  const q = Number(l.quantity_sold ?? 1) || 1;
  return `${d}|${p}|${q}`;
}

export function listingKey(l: FinderListing): string {
  const listingId = l.listing_id as string | null | undefined;
  const url = l.url as string | undefined;
  const asin = l.amazon_asin as string | null | undefined;
  const title = l.title as string | undefined;
  const sold = soldEventPart(l);
  if (listingId) return `lid:${listingId}|${sold}`;
  if (url) return `url:${url.split("?")[0]}|${sold}`;
  if (asin) return `asin:${asin}|${sold}`;
  return `title:${title ?? "unknown"}|${sold}`;
}

/** Stable key for live eBay listings (one row per listing, no sold-event suffix). */
export function activeListingKey(l: FinderListing): string {
  const listingId = l.listing_id as string | null | undefined;
  if (listingId && /^\d{8,}$/.test(String(listingId))) return `lid:${String(listingId)}`;
  const url = String(l.url ?? "")
    .split("?")[0]
    .trim()
    .toLowerCase();
  if (url.includes("ebay.com/itm/")) return `url:${url}`;
  const asin = String(l.amazon_asin ?? "")
    .trim()
    .toUpperCase();
  if (asin) return `asin:${asin}`;
  return `title:${String(l.title ?? "unknown").slice(0, 120)}`;
}

/** Keys to try when deleting — includes DB row id and legacy keys without sold suffix. */
export function allRemoveKeys(l: FinderListing, explicitKey?: string): string[] {
  const keys = new Set<string>();
  if (explicitKey?.trim()) keys.add(explicitKey.trim());
  const foundKey = l.found_key as string | undefined;
  if (foundKey?.trim()) keys.add(foundKey.trim());
  keys.add(listingKey(l));
  const listingId = l.listing_id as string | null | undefined;
  const url = l.url as string | undefined;
  const asin = l.amazon_asin as string | null | undefined;
  if (listingId) keys.add(`lid:${listingId}`);
  if (url) keys.add(`url:${String(url).split("?")[0]}`);
  if (asin) keys.add(`asin:${String(asin)}`);
  return Array.from(keys);
}

/** Keys to try when deleting live/active rows. */
export function activeRemoveKeys(l: FinderListing, explicitKey?: string): string[] {
  const keys = new Set<string>();
  if (explicitKey?.trim()) keys.add(explicitKey.trim());
  keys.add(activeListingKey(l));
  const listingId = l.listing_id as string | null | undefined;
  const url = l.url as string | undefined;
  const asin = l.amazon_asin as string | null | undefined;
  if (listingId && /^\d{8,}$/.test(String(listingId))) keys.add(`lid:${String(listingId)}`);
  if (url) keys.add(`url:${String(url).split("?")[0].trim().toLowerCase()}`);
  if (asin) keys.add(`asin:${String(asin).trim().toUpperCase()}`);
  return Array.from(keys);
}

export function mergeListing(
  existing: FinderListing | undefined,
  incoming: FinderListing
): FinderListing {
  if (!existing) return { ...incoming };
  const exConf = Number(existing.match_confidence ?? 0);
  const inConf = Number(incoming.match_confidence ?? 0);
  const exDays = Number(existing.source_days_back ?? 0);
  const inDays = Number(incoming.source_days_back ?? 0);
  return {
    ...existing,
    ...incoming,
    amazon_price: incoming.amazon_price ?? existing.amazon_price ?? null,
    amazon_stock: incoming.amazon_stock ?? existing.amazon_stock,
    net_profit: incoming.net_profit ?? existing.net_profit ?? null,
    margin_percent: incoming.margin_percent ?? existing.margin_percent ?? null,
    is_profitable: incoming.is_profitable ?? existing.is_profitable ?? false,
    match_confidence: Math.max(exConf, inConf) || incoming.match_confidence,
    source_seller: incoming.source_seller ?? existing.source_seller,
    source_days_back: Math.max(exDays, inDays) || incoming.source_days_back,
  };
}

export function withSource(
  l: FinderListing,
  seller?: string,
  daysBack?: number
): FinderListing {
  return {
    ...l,
    ...(seller ? { source_seller: seller } : {}),
    ...(daysBack != null ? { source_days_back: daysBack } : {}),
  };
}

/** Same threshold as frontend `productFinderMatch.ts` (≥80% or description ASIN). */
export const MIN_MATCH_CONFIDENCE = 0.8;

export function isAcceptedMatch(l: FinderListing): boolean {
  const asin = l.amazon_asin as string | null | undefined;
  if (!asin) return false;
  if (l.match_method === "description") return true;
  return Number(l.match_confidence ?? 0) >= MIN_MATCH_CONFIDENCE;
}

export function countAcceptedMatches(listings: FinderListing[]): number {
  return listings.filter(isAcceptedMatch).length;
}

/** Drop internal/heavy fields before DB or HTTP (keeps responses under proxy limits). */
export function slimFinderListing(l: FinderListing): FinderListing {
  const out: FinderListing = {
    listing_id: (l.listing_id as string | null) ?? null,
    title: String(l.title ?? ""),
    sold_price: (l.sold_price as number | null) ?? null,
    quantity_sold: Number(l.quantity_sold ?? 1),
    sold_date: (l.sold_date as string | null) ?? null,
    url: String(l.url ?? ""),
    image: String(l.image ?? ""),
    amazon_asin: (l.amazon_asin as string | null) ?? null,
    amazon_price: (l.amazon_price as number | null) ?? null,
    match_confidence: (l.match_confidence as number | null) ?? null,
    net_profit: (l.net_profit as number | null) ?? null,
    margin_percent: (l.margin_percent as number | null) ?? null,
    is_profitable: Boolean(l.is_profitable),
  };
  if (l.amazon_url) out.amazon_url = String(l.amazon_url);
  if (l.amazon_stock) out.amazon_stock = String(l.amazon_stock);
  if (l.match_method) out.match_method = String(l.match_method);
  if (l.match_title_score != null) out.match_title_score = Number(l.match_title_score);
  if (l.match_image_score != null) out.match_image_score = Number(l.match_image_score);
  if (l.roi_percent != null) out.roi_percent = Number(l.roi_percent);
  if (l.revenue != null) out.revenue = Number(l.revenue);
  if (l.ebay_fee != null) out.ebay_fee = Number(l.ebay_fee);
  if (l.payment_fee != null) out.payment_fee = Number(l.payment_fee);
  if (l.amazon_cost != null) out.amazon_cost = Number(l.amazon_cost);
  if (l.source_seller) out.source_seller = String(l.source_seller);
  if (l.source_days_back != null) out.source_days_back = Number(l.source_days_back);
  return out;
}

export function listingsForStorage(listings: FinderListing[]): FinderListing[] {
  return listings.map(slimFinderListing);
}

export function acceptedListingsForClient(listings: FinderListing[]): FinderListing[] {
  return listings.filter(isAcceptedMatch).map(slimFinderListing);
}

/** Recompute `matched_to_amazon` on cached rows (older DB rows may count all ASINs). */
export function summaryWithAcceptedCount(
  listings: FinderListing[],
  summary: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const base =
    summary && typeof summary === "object" ? { ...summary } : ({} as Record<string, unknown>);
  const total = Number(base.total_listings ?? listings.length) || listings.length;
  return {
    ...base,
    total_listings: total,
    matched_to_amazon: countAcceptedMatches(listings),
  };
}

/** Group key for duplicate removal — one row per ASIN, eBay listing, or title. */
export function dedupeGroupKey(l: FinderListing): string | null {
  const asin = String(l.amazon_asin ?? "")
    .trim()
    .toUpperCase();
  if (isPlausibleAsin(asin)) return `asin:${asin}`;

  const lid = String(l.listing_id ?? "").trim();
  if (/^\d{8,}$/.test(lid)) return `lid:${lid}`;

  const url = String(l.url ?? "")
    .split("?")[0]
    .trim()
    .toLowerCase();
  if (url.includes("ebay.com/itm/")) return `url:${url}`;

  const title = String(l.title ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (title.length >= 12) return `title:${title.slice(0, 160)}`;

  return null;
}

/** Prefer higher profit, then match confidence, then newer sold date. */
export function isBetterListing(a: FinderListing, b: FinderListing): boolean {
  const pa = Number(a.net_profit ?? -Infinity);
  const pb = Number(b.net_profit ?? -Infinity);
  if (pa !== pb) return pa > pb;

  const ca = Number(a.match_confidence ?? 0);
  const cb = Number(b.match_confidence ?? 0);
  if (ca !== cb) return ca > cb;

  const da = String(a.sold_date ?? "");
  const db = String(b.sold_date ?? "");
  if (da !== db) return da > db;

  const spa = Number(a.sold_price ?? 0);
  const spb = Number(b.sold_price ?? 0);
  return spa >= spb;
}
