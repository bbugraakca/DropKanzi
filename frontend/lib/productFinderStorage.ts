import type { ProductFinderListing } from "./api";
import { parseEbaySellerInput } from "./parseEbaySellerInput";

export const FOUND_KEY = "pf_found_products";
export const SAVED_KEY = "pf_saved_products";
export const RESERVED_KEY = "pf_reserved_products";
export const DELETED_FOUND_KEYS = "pf_deleted_found_keys";
export const QUEUE_KEY = "pf_queue";
export const SELLER_HISTORY_KEY = "pf_seller_history";
/** Max unique sellers in watchlist (weekly refresh list). */
export const SELLER_HISTORY_MAX = 250;
export const WEEKLY_REFRESH_DAYS = 7;

/** Stable id for dedup — one row per sold line (same item can sell many times). */
export function listingKey(l: ProductFinderListing): string {
  const sold = `${String(l.sold_date ?? "").slice(0, 10)}|${l.sold_price != null ? Number(l.sold_price).toFixed(2) : ""}|${l.quantity_sold ?? 1}`;
  if (l.listing_id) return `lid:${l.listing_id}|${sold}`;
  if (l.url) return `url:${l.url.split("?")[0]}|${sold}`;
  if (l.amazon_asin) return `asin:${l.amazon_asin}|${sold}`;
  return `title:${l.title}|${sold}`;
}

/** All stable keys for a row — delete/dedup works even when id fields differ between cache layers. */
export function allListingKeys(l: ProductFinderListing): string[] {
  const keys: string[] = [];
  if (l.found_key) keys.push(l.found_key);
  if (l.listing_id) keys.push(`lid:${l.listing_id}`);
  if (l.url) keys.push(`url:${l.url.split("?")[0]}`);
  if (l.amazon_asin) keys.push(`asin:${l.amazon_asin}`);
  keys.push(listingKey(l));
  return Array.from(new Set(keys));
}

/** Keys to send when removing a row from server Found cache. */
export function foundRemoveKeys(l: ProductFinderListing): string[] {
  return allListingKeys(l);
}

/** Stable key for live eBay listings (one row per listing). */
export function activeListingKey(l: ProductFinderListing): string {
  const listingId = l.listing_id;
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

/** Keys to send when removing a row from server Live cache. */
export function activeRemoveKeys(l: ProductFinderListing): string[] {
  const keys = new Set<string>();
  keys.add(activeListingKey(l));
  if (l.listing_id) keys.add(`lid:${l.listing_id}`);
  if (l.url) keys.add(`url:${String(l.url).split("?")[0].trim().toLowerCase()}`);
  if (l.amazon_asin) keys.add(`asin:${String(l.amazon_asin).trim().toUpperCase()}`);
  return Array.from(keys);
}

export function readDeletedFoundKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(DELETED_FOUND_KEYS);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === "string" && k.length > 0));
  } catch {
    return new Set();
  }
}

export function writeDeletedFoundKeys(keys: Set<string>): void {
  try {
    localStorage.setItem(DELETED_FOUND_KEYS, JSON.stringify(Array.from(keys).slice(-8000)));
  } catch {
    /* ignore */
  }
}

export function excludeDeletedFoundKeys(
  listings: ProductFinderListing[],
  deleted: ReadonlySet<string>
): ProductFinderListing[] {
  if (deleted.size === 0) return listings;
  return listings.filter((l) => !allListingKeys(l).some((k) => deleted.has(k)));
}

export function mergeListing(
  existing: ProductFinderListing | undefined,
  incoming: ProductFinderListing
): ProductFinderListing {
  if (!existing) return { ...incoming };
  return {
    ...existing,
    ...incoming,
    amazon_price: incoming.amazon_price ?? existing.amazon_price ?? null,
    amazon_stock: incoming.amazon_stock ?? existing.amazon_stock,
    net_profit: incoming.net_profit ?? existing.net_profit ?? null,
    margin_percent: incoming.margin_percent ?? existing.margin_percent ?? null,
    is_profitable: incoming.is_profitable ?? existing.is_profitable ?? false,
    match_confidence: Math.max(
      incoming.match_confidence ?? 0,
      existing.match_confidence ?? 0
    ) || incoming.match_confidence,
    source_seller: incoming.source_seller ?? existing.source_seller,
    source_days_back: Math.max(
      incoming.source_days_back ?? 0,
      existing.source_days_back ?? 0
    ) || incoming.source_days_back,
  };
}

export function mergeListingLists(
  base: ProductFinderListing[],
  additions: ProductFinderListing[]
): ProductFinderListing[] {
  const map = new Map(base.map((p) => [listingKey(p), p]));
  for (const l of additions) {
    const k = listingKey(l);
    map.set(k, mergeListing(map.get(k), l));
  }
  return Array.from(map.values());
}

export function readFoundLocal(): ProductFinderListing[] {
  try {
    const raw = localStorage.getItem(FOUND_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Browser localStorage cap — large scans stay on server Found DB. */
export const FOUND_LOCAL_MAX = 1500;

export function writeFoundLocal(listings: ProductFinderListing[]): boolean {
  try {
    const toStore =
      listings.length > FOUND_LOCAL_MAX ? listings.slice(0, FOUND_LOCAL_MAX) : listings;
    localStorage.setItem(FOUND_KEY, JSON.stringify(toStore));
    return true;
  } catch {
    return false;
  }
}

let _foundWriteTimer: ReturnType<typeof setTimeout> | null = null;
let _foundPending: ProductFinderListing[] | null = null;

/** Debounce large Found writes so the UI stays responsive during queue scans. */
export function scheduleWriteFoundLocal(listings: ProductFinderListing[]): void {
  _foundPending = listings;
  if (_foundWriteTimer) clearTimeout(_foundWriteTimer);
  _foundWriteTimer = setTimeout(() => {
    if (_foundPending) writeFoundLocal(_foundPending);
    _foundPending = null;
    _foundWriteTimer = null;
  }, 700);
}

export function flushWriteFoundLocal(): void {
  if (_foundWriteTimer) {
    clearTimeout(_foundWriteTimer);
    _foundWriteTimer = null;
  }
  if (_foundPending) {
    writeFoundLocal(_foundPending);
    _foundPending = null;
  }
}

export type StoredQueueItem = {
  id: string;
  seller: string;
  daysBack: number;
  status: "queued" | "running" | "done" | "failed";
  matched?: number;
  total?: number;
  pricesLoaded?: number;
  pricesTotal?: number;
  error?: string;
  costUsd?: number;
  costBytes?: number;
  costRequests?: number;
  cached?: boolean;
  costStages?: Record<string, { bytes: number; requests: number; cost_usd: number }>;
  matchAttempted?: number;
  matchSkipped?: number;
  matchTitlesAttempted?: number;
  matchTitlesSkipped?: number;
  serpLookups?: number;
  serpProxy?: number;
  serpDirect?: number;
};

export function readQueueLocal(): StoredQueueItem[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeQueueLocal(items: StoredQueueItem[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

export function normalizeAsin(asin: string | null | undefined): string | null {
  if (!asin) return null;
  const t = asin.trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(t) ? t : asin.trim() || null;
}

/** Drop listings whose ASIN is already in Saved products. */
export function excludeSavedAsins(
  listings: ProductFinderListing[],
  savedAsins: ReadonlySet<string>
): ProductFinderListing[] {
  if (savedAsins.size === 0) return listings;
  return listings.filter((l) => {
    const asin = normalizeAsin(l.amazon_asin);
    return !asin || !savedAsins.has(asin);
  });
}

export function savedAsinsFromListings(listings: ProductFinderListing[]): Set<string> {
  return new Set(
    listings
      .map((l) => normalizeAsin(l.amazon_asin))
      .filter((a): a is string => Boolean(a))
  );
}

/** One row per eBay listing in Saved (merge only exact same listing key). */
export function dedupeSavedByListingKey(listings: ProductFinderListing[]): ProductFinderListing[] {
  const map = new Map<string, ProductFinderListing>();
  for (const l of listings) {
    const k = listingKey(l);
    map.set(k, mergeListing(map.get(k), l));
  }
  return Array.from(map.values());
}

/** @deprecated use dedupeSavedByListingKey — ASIN dedupe dropped distinct eBay rows. */
export function dedupeSavedByAsin(listings: ProductFinderListing[]): ProductFinderListing[] {
  return dedupeSavedByListingKey(listings);
}

let _savedWriteTimer: ReturnType<typeof setTimeout> | null = null;
let _savedPending: ProductFinderListing[] | null = null;

export function writeSavedLocal(listings: ProductFinderListing[]): boolean {
  if (_savedWriteTimer) {
    clearTimeout(_savedWriteTimer);
    _savedWriteTimer = null;
  }
  _savedPending = null;
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(listings));
    return true;
  } catch {
    return false;
  }
}

/** Debounce Saved writes so profit recalc on large lists does not freeze the UI. */
export function scheduleWriteSavedLocal(listings: ProductFinderListing[]): boolean {
  _savedPending = listings;
  if (_savedWriteTimer) clearTimeout(_savedWriteTimer);
  _savedWriteTimer = setTimeout(() => {
    if (_savedPending) writeSavedLocal(_savedPending);
    _savedPending = null;
    _savedWriteTimer = null;
  }, 400);
  return true;
}

export function flushWriteSavedLocal(): boolean {
  if (_savedWriteTimer) {
    clearTimeout(_savedWriteTimer);
    _savedWriteTimer = null;
  }
  if (_savedPending) {
    const ok = writeSavedLocal(_savedPending);
    _savedPending = null;
    return ok;
  }
  return true;
}

export function readReservedLocal(): ProductFinderListing[] {
  try {
    const raw = localStorage.getItem(RESERVED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let _reservedWriteTimer: ReturnType<typeof setTimeout> | null = null;
let _reservedPending: ProductFinderListing[] | null = null;

export function writeReservedLocal(listings: ProductFinderListing[]): boolean {
  try {
    localStorage.setItem(RESERVED_KEY, JSON.stringify(listings));
    return true;
  } catch {
    return false;
  }
}

export function scheduleWriteReservedLocal(listings: ProductFinderListing[]): boolean {
  _reservedPending = listings;
  if (_reservedWriteTimer) clearTimeout(_reservedWriteTimer);
  _reservedWriteTimer = setTimeout(() => {
    if (_reservedPending) writeReservedLocal(_reservedPending);
    _reservedPending = null;
    _reservedWriteTimer = null;
  }, 400);
  return true;
}

export function flushWriteReservedLocal(): boolean {
  if (_reservedWriteTimer) {
    clearTimeout(_reservedWriteTimer);
    _reservedWriteTimer = null;
  }
  if (_reservedPending) {
    const ok = writeReservedLocal(_reservedPending);
    _reservedPending = null;
    return ok;
  }
  return true;
}

export type StoredSellerSearch = {
  seller: string;
  daysBack: number;
  lastUsed: number;
  /** Raw analyze input (eBay URL) when queued from a link. */
  sellerInput?: string;
  matched?: number;
  total?: number;
  ebaySellerId?: string;
  status?: "done" | "failed";
  error?: string;
  costUsd?: number;
  costBytes?: number;
  costRequests?: number;
  cached?: boolean;
  costStages?: Record<string, { bytes: number; requests: number; cost_usd: number }>;
  /** Unique eBay titles sent through Amazon matching (not match count). */
  matchTitlesAttempted?: number;
  matchTitlesSkipped?: number;
  serpLookups?: number;
  serpProxy?: number;
  serpDirect?: number;
};

export type ArchiveSellerScanInput = {
  seller: string;
  daysBack: number;
  sellerInput?: string;
  matched?: number;
  total?: number;
  ebaySellerId?: string;
  status?: "done" | "failed";
  error?: string;
  costUsd?: number;
  costBytes?: number;
  costRequests?: number;
  cached?: boolean;
  costStages?: Record<string, { bytes: number; requests: number; cost_usd: number }>;
  /** Unique eBay titles sent through Amazon matching (not match count). */
  matchTitlesAttempted?: number;
  matchTitlesSkipped?: number;
  serpLookups?: number;
  serpProxy?: number;
  serpDirect?: number;
};

export function readSellerHistory(): StoredSellerSearch[] {
  try {
    const raw = localStorage.getItem(SELLER_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is StoredSellerSearch =>
          typeof e === "object" &&
          e != null &&
          typeof e.seller === "string" &&
          typeof e.daysBack === "number"
      )
      .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
  } catch {
    return [];
  }
}

export function writeSellerHistory(items: StoredSellerSearch[]): void {
  try {
    localStorage.setItem(SELLER_HISTORY_KEY, JSON.stringify(items.slice(0, SELLER_HISTORY_MAX)));
  } catch {
    /* ignore */
  }
}

/** Remember sellers queued for analysis (most recent first, deduped by username). */
export function rememberSellerSearches(
  entries: ArchiveSellerScanInput[]
): StoredSellerSearch[] {
  if (entries.length === 0) return readSellerHistory();
  const now = Date.now();
  const map = new Map<string, StoredSellerSearch>();
  for (const prev of readSellerHistory()) {
    map.set(prev.seller.toLowerCase(), prev);
  }
  entries.forEach((e, i) => {
    const seller = e.seller.trim().replace(/^@/, "");
    if (!seller) return;
    const key = seller.toLowerCase();
    const prev = map.get(key);
    map.set(key, {
      seller,
      daysBack: e.daysBack,
      lastUsed: now - i,
      sellerInput: e.sellerInput ?? prev?.sellerInput,
      matched: e.matched ?? prev?.matched,
      total: e.total ?? prev?.total,
      ebaySellerId: e.ebaySellerId ?? prev?.ebaySellerId,
      status: e.status ?? prev?.status,
      error: e.error ?? prev?.error,
      costUsd: e.costUsd ?? prev?.costUsd,
      costBytes: e.costBytes ?? prev?.costBytes,
      costRequests: e.costRequests ?? prev?.costRequests,
      cached: e.cached ?? prev?.cached,
      costStages: e.costStages ?? prev?.costStages,
      matchTitlesAttempted: e.matchTitlesAttempted ?? prev?.matchTitlesAttempted,
      matchTitlesSkipped: e.matchTitlesSkipped ?? prev?.matchTitlesSkipped,
      serpLookups: e.serpLookups ?? prev?.serpLookups,
      serpProxy: e.serpProxy ?? prev?.serpProxy,
      serpDirect: e.serpDirect ?? prev?.serpDirect,
    });
  });
  const all = Array.from(map.values()).sort((a, b) => b.lastUsed - a.lastUsed);
  const next = all.slice(0, SELLER_HISTORY_MAX);
  writeSellerHistory(next);
  return next;
}

/** Add seller names/URLs to watchlist without queuing a scan. */
export function importSellersToWatchlist(
  rawNames: string[],
  daysBack = WEEKLY_REFRESH_DAYS
): { added: number; total: number; truncated: boolean } {
  const seen = new Set<string>();
  const entries: ArchiveSellerScanInput[] = [];
  for (const raw of rawNames) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const parsed = parseEbaySellerInput(trimmed);
    if (!parsed.seller) continue;
    const key = parsed.seller.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      seller: parsed.seller,
      daysBack,
      sellerInput: parsed.apiInput,
    });
  }
  if (entries.length === 0) {
    return { added: 0, total: uniqueSellerHistory().length, truncated: false };
  }
  const before = new Set(readSellerHistory().map((e) => e.seller.toLowerCase()));
  const next = rememberSellerSearches(entries);
  const added = entries.filter((e) => !before.has(e.seller.toLowerCase())).length;
  return {
    added,
    total: next.length,
    truncated: next.length >= SELLER_HISTORY_MAX,
  };
}

/** Move a finished queue run into seller history (not shown in the live queue). */
export function archiveSellerScan(entry: ArchiveSellerScanInput): StoredSellerSearch[] {
  return rememberSellerSearches([entry]);
}

export function removeSellerFromHistory(seller: string): StoredSellerSearch[] {
  const key = seller.trim().toLowerCase();
  const next = readSellerHistory().filter((e) => e.seller.toLowerCase() !== key);
  writeSellerHistory(next);
  return next;
}

export function clearSellerHistory(): void {
  try {
    localStorage.removeItem(SELLER_HISTORY_KEY);
  } catch {
    /* ignore */
  }
}

/** One row per seller username — keeps the most recent scan stats. */
export function uniqueSellerHistory(): StoredSellerSearch[] {
  const map = new Map<string, StoredSellerSearch>();
  for (const e of readSellerHistory()) {
    const key = e.seller.toLowerCase();
    const prev = map.get(key);
    if (!prev || e.lastUsed > prev.lastUsed) map.set(key, e);
  }
  return Array.from(map.values()).sort((a, b) => b.lastUsed - a.lastUsed);
}
