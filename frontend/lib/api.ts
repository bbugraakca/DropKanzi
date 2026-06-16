import type {
  Listing,
  ListingCalculateResult,
  ListingCreateResult,
  OrderRow,
  Product,
  ProductsResponse,
  ScrapeJob,
  Store,
} from "./types";
import { browserApiBase, browserDirectBackendBase, browserLibraryApiBase } from "./backendUrl";

function formatRequestError(err: unknown, url: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(msg)) {
    const analyzeHint = /analyze/i.test(url)
      ? " Large scans (60d) can take 15–30 min — keep this tab open. "
      : " ";
    return new Error(
      `API connection failed (${url}).${analyzeHint}Use http://127.0.0.1:3000 · Ctrl+F5 · docker compose up -d backend frontend scraper · Health: http://127.0.0.1:3001/api/health`
    );
  }
  if (/aborted|timeout/i.test(msg)) {
    return new Error("Request timed out — seller may be large; retry or use a shorter window.");
  }
  return err instanceof Error ? err : new Error(`${msg} (${url})`);
}

/** JSON fetch with optional timeout — browser uses /api rewrite to backend. */
async function apiFetch<T>(
  path: string,
  options?: RequestInit & { timeoutMs?: number; baseUrl?: string }
): Promise<T> {
  const url = `${options?.baseUrl ?? browserApiBase()}${path}`;
  const timeoutMs = options?.timeoutMs ?? 600_000;
  const { timeoutMs: _drop, baseUrl: _base, ...fetchOpts } = options ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...fetchOpts,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...fetchOpts.headers,
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (data as { detail?: string }).detail;
      let base = (data as { error?: string }).error || `Request failed (${res.status})`;
      if (
        res.status === 500 &&
        !base &&
        path.includes("/product-finder/analyze")
      ) {
        base =
          "Scan proxy error — rebuild frontend or set NEXT_PUBLIC_API_URL=http://localhost:3001/api";
      }
      throw new Error(detail ? `${base}: ${String(detail).slice(0, 280)}` : base);
    }
    return data as T;
  } catch (err) {
    throw formatRequestError(err, url);
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  return apiFetch<T>(path, { ...options, timeoutMs: 120_000 });
}

export async function searchProduct(asin: string): Promise<Product> {
  return request<Product>("/product/search", {
    method: "POST",
    body: JSON.stringify({ asin }),
  });
}

export async function getProduct(asin: string): Promise<Product> {
  return request<Product>(`/product/${asin}`);
}

export type PriceCheckMeta = {
  fetch_type: string;
  bytes_downloaded: number;
  full_fetch: boolean;
};

export async function priceCheckProduct(
  asin: string
): Promise<{ product: Product; meta: PriceCheckMeta }> {
  return request<{ product: Product; meta: PriceCheckMeta }>(
    `/product/${encodeURIComponent(asin)}/price-check`,
    { method: "POST", body: "{}" }
  );
}

export async function bulkScrape(asins: string[]): Promise<{ jobId: string }> {
  return request<{ jobId: string }>("/bulk", {
    method: "POST",
    body: JSON.stringify({ asins }),
  });
}

export async function getJob(jobId: string): Promise<ScrapeJob> {
  return request<ScrapeJob>(`/jobs/${jobId}`);
}

export async function listBulkJobs(): Promise<ScrapeJob[]> {
  return request<ScrapeJob[]>("/jobs");
}

export async function saveBulkJobNote(jobId: string, asin: string, note: string) {
  return request<ScrapeJob>(`/jobs/${jobId}/notes`, {
    method: "PATCH",
    body: JSON.stringify({ asin, note }),
  });
}

export async function getProducts(
  page: number,
  filter: string,
  sort: string
): Promise<ProductsResponse> {
  const params = new URLSearchParams({
    page: String(page),
    limit: "20",
    filter,
    sort,
  });
  return request<ProductsResponse>(`/products?${params}`);
}

export async function getProductsByAsins(asins: string[]): Promise<ProductsResponse> {
  if (asins.length === 0) {
    return { products: [], total: 0, page: 1, pages: 1 };
  }
  const params = new URLSearchParams({
    asins: asins.join(","),
    limit: String(Math.min(500, asins.length)),
    page: "1",
    filter: "all",
    sort: "updated",
  });
  return request<ProductsResponse>(`/products?${params}`);
}

export async function getStores(): Promise<Store[]> {
  return request<Store[]>("/stores");
}

export async function createDemoStore(name?: string): Promise<Store> {
  return request<Store>("/stores/demo", {
    method: "POST",
    body: JSON.stringify({ name: name || "Demo Store" }),
  });
}

export async function deleteStore(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/stores/${id}`, { method: "DELETE" });
}

export type EbayConfigStatus = {
  ok: boolean;
  sandbox: boolean;
  issues: string[];
  redirectUri: string;
  clientIdPreview: string;
};

export async function getEbayConfigStatus(): Promise<EbayConfigStatus> {
  return request<EbayConfigStatus>("/auth/ebay/config");
}

export async function getEbayOAuthUrl(): Promise<{ url: string }> {
  return request<{ url: string }>("/auth/ebay/url");
}

export async function connectEbayStore(payload: {
  code: string;
  ebayUsername?: string;
  country?: string;
}): Promise<Store> {
  return request<Store>("/stores/connect-ebay", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getStoreSettings(storeId: string): Promise<{ id: string; settings: any }> {
  return request<{ id: string; settings: any }>(`/stores/${storeId}/settings`);
}

export async function saveStoreSettingsKey(storeId: string, key: string, value: any) {
  return request<{ ok: boolean; settings: any }>(`/stores/${storeId}/settings/${key}`, {
    method: "POST",
    body: JSON.stringify(value),
  });
}

export async function saveAllStoresSettingsKey(key: string, value: any) {
  return request<{ ok: boolean }>(`/stores/settings/${key}`, {
    method: "POST",
    body: JSON.stringify(value),
  });
}

export type ListingsResponse = {
  listings: Listing[];
  total: number;
  page: number;
  pages: number;
  limit: number;
};

export async function getListings(
  storeId: string,
  opts?: { page?: number; limit?: number; q?: string }
): Promise<ListingsResponse> {
  const params = new URLSearchParams();
  if (opts?.page != null) params.set("page", String(opts.page));
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.q?.trim()) params.set("q", opts.q.trim());
  const qs = params.toString();
  return request<ListingsResponse>(
    `/stores/${storeId}/listings${qs ? `?${qs}` : ""}`
  );
}

/** Fetch every listing for a store (paged API, up to 200 per request). */
export async function getAllListings(storeId: string): Promise<Listing[]> {
  const first = await getListings(storeId, { page: 1, limit: 200 });
  const all = [...first.listings];
  for (let p = 2; p <= first.pages; p++) {
    const next = await getListings(storeId, { page: p, limit: 200 });
    all.push(...next.listings);
  }
  return all;
}

export async function getPaymentPolicies(storeId: string) {
  return request<unknown>(`/stores/${storeId}/ebay-policies/payment`);
}

export async function getReturnPolicies(storeId: string) {
  return request<unknown>(`/stores/${storeId}/ebay-policies/return`);
}

export async function getFulfillmentPolicies(storeId: string) {
  return request<unknown>(`/stores/${storeId}/ebay-policies/fulfillment`);
}

/** Server applies all store settings (range, fees, VAT, round, template, offer, qty). */
export async function calculateListing(
  storeId: string,
  asin: string
): Promise<ListingCalculateResult> {
  return request<ListingCalculateResult>(`/stores/${storeId}/listings/calculate`, {
    method: "POST",
    body: JSON.stringify({ asin }),
  });
}

export type ApplyRepricingResult = {
  total: number;
  updated: number;
  skipped: number;
  failed: number;
  rows: Array<{
    asin: string;
    listingId: string;
    oldPrice: number;
    newPrice: number;
    status: "updated" | "skipped" | "failed";
    message?: string;
  }>;
};

export async function applyRepricingToAllListings(
  storeId: string
): Promise<ApplyRepricingResult> {
  return request<ApplyRepricingResult>(
    `/stores/${storeId}/listings/apply-repricing`,
    { method: "POST", body: "{}" }
  );
}

export async function createListing(
  storeId: string,
  payload: {
    asin: string;
    title?: string;
    price?: number;
    quantity?: number;
    condition?: string;
    paymentPolicyId?: string;
    returnPolicyId?: string;
    fulfillmentPolicyId?: string;
    publish?: boolean;
    categoryId?: string;
    manualPrice?: boolean;
  }
): Promise<ListingCreateResult> {
  return request<ListingCreateResult>(`/stores/${storeId}/listings`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function syncOrders(storeId: string) {
  return request<{ ok: boolean; upserted: number }>(`/stores/${storeId}/orders/sync`, {
    method: "POST",
    body: JSON.stringify({ limit: 50, offset: 0 }),
  });
}

export async function getOrders(storeId: string): Promise<OrderRow[]> {
  return request<OrderRow[]>(`/stores/${storeId}/orders`);
}

// ---- Product Finder ----

export type ProductFinderListing = {
  listing_id: string | null;
  title: string;
  sold_price: number | null;
  /** Live eBay listing price (active scans). */
  list_price?: number | null;
  listing_type?: "active" | "sold";
  quantity_sold: number;
  sold_date: string | null;
  url: string;
  image: string;
  amazon_asin: string | null;
  amazon_price: number | null;
  amazon_url?: string;
  amazon_stock?: string;
  match_confidence: number | null;
  match_method?: string;
  match_title_score?: number | null;
  match_image_score?: number | null;
  net_profit: number | null;
  margin_percent: number | null;
  roi_percent?: number | null;
  revenue?: number;
  ebay_fee?: number;
  payment_fee?: number;
  amazon_cost?: number;
  is_profitable: boolean;
  source_seller?: string;
  source_days_back?: number;
  /** Primary DB row id — use for remove-from-Found (do not recompute). */
  found_key?: string;
};

export type ProductFinderSummary = {
  total_listings: number;
  matched_to_amazon: number;
  profitable: number;
  match_rate: number;
  avg_margin: number;
  total_revenue: number;
  total_profit: number;
  truncated: boolean;
  truncated_at?: number | null;
  prices_fetched?: boolean;
  prices_loaded?: number;
  match_groups_total?: number;
  match_groups_attempted?: number;
  match_groups_skipped?: number;
  match_captcha_aborted?: boolean;
  ebay_status?: string;
  ebay_message?: string;
  ebay_seller_id?: string;
  ebay_store_resolved?: boolean;
  proxy_bytes?: number;
  proxy_mb?: number;
  proxy_requests?: number;
  proxy_cost_usd?: number;
  proxy_cost_per_gb?: number;
  proxy_stages?: Record<
    string,
    { bytes: number; requests: number; cost_usd: number }
  >;
  /** Amazon SERP stats (separate from proxy_meter.proxy_requests). */
  serp_lookups?: number;
  serp_http_requests?: number;
  serp_proxy_requests?: number;
  serp_direct_requests?: number;
  serp_direct_bytes?: number;
};

export type ProductFinderResult = {
  seller: string;
  cached?: boolean;
  /** When true, listings were omitted from response (use server Found import). */
  listings_omitted?: boolean;
  listings: ProductFinderListing[];
  summary: ProductFinderSummary;
};

export async function analyzeSeller(
  seller: string,
  daysBack: number,
  storeId?: string | null,
  forceRefresh = false,
  fetchPrices = true
): Promise<ProductFinderResult> {
  return apiFetch<ProductFinderResult>("/product-finder/analyze", {
    method: "POST",
    body: JSON.stringify({
      seller,
      daysBack,
      storeId: storeId || undefined,
      forceRefresh,
      fetchPrices,
    }),
    timeoutMs: 1_800_000,
    baseUrl: browserDirectBackendBase(),
  });
}

/** Scan seller's live/active eBay listings and match to Amazon. */
export async function analyzeActiveSeller(
  seller: string,
  storeId?: string | null,
  forceRefresh = false,
  fetchPrices = true
): Promise<ProductFinderResult> {
  return apiFetch<ProductFinderResult>("/product-finder/analyze-active", {
    method: "POST",
    body: JSON.stringify({
      seller,
      storeId: storeId || undefined,
      forceRefresh,
      fetchPrices,
    }),
    // Full-store live scans (no match cap) can take hours for big sellers.
    timeoutMs: 7_200_000,
    baseUrl: browserDirectBackendBase(),
  });
}

export type FinderPriceMap = Record<
  string,
  { price: number | null; stock?: string; amazon_url: string }
>;

export type FinderPriceResponse = {
  prices: FinderPriceMap;
  rows_updated?: number;
  proxy_bytes?: number;
  proxy_mb?: number;
  proxy_requests?: number;
  proxy_cost_usd?: number;
  proxy_cost_per_gb?: number;
  proxy_stages?: Record<
    string,
    { bytes: number; requests: number; cost_usd: number }
  >;
};

export async function fetchFinderPrices(asins: string[]): Promise<FinderPriceResponse> {
  const n = asins.length;
  return apiFetch<FinderPriceResponse>("/product-finder/prices", {
    method: "POST",
    body: JSON.stringify({ asins: asins.slice(0, 1000) }),
    timeoutMs: n >= 200 ? 900_000 : 600_000,
    baseUrl: browserDirectBackendBase(),
  });
}

export type FoundPageParams = {
  page?: number;
  limit?: number;
  seller?: string;
  q?: string;
  profitable?: boolean;
  missingPrice?: boolean;
  hasPrice?: boolean;
  minMatchConfidence?: number;
  minMargin?: number;
  minSoldPrice?: number;
  sort?: "profit" | "margin" | "sold_date" | "sold_price" | "quantity" | "match";
  /** First load only — skips heavy aggregate on page 2+. */
  includeStats?: boolean;
  /** Store VAT % (0–100) for server-side profitable filter. */
  vatRatePercent?: number;
  /** Fixed extra cost per unit for server-side profitable filter. */
  additionalFee?: number;
};

/** Drop inactive filters so toggling off clears previous server query state. */
export function sanitizeFoundParams(params: FoundPageParams): FoundPageParams {
  const out: FoundPageParams = {
    page: params.page,
    limit: params.limit,
    sort: params.sort,
  };
  if (params.seller?.trim()) out.seller = params.seller.trim();
  if (params.q?.trim()) out.q = params.q.trim();
  if (params.profitable) out.profitable = true;
  if (params.missingPrice) out.missingPrice = true;
  if (params.hasPrice) out.hasPrice = true;
  if (params.minMatchConfidence != null && params.minMatchConfidence > 0) {
    out.minMatchConfidence = params.minMatchConfidence;
  }
  if (params.minMargin != null && params.minMargin > 0) out.minMargin = params.minMargin;
  if (params.minSoldPrice != null && params.minSoldPrice > 0) {
    out.minSoldPrice = params.minSoldPrice;
  }
  if (params.includeStats) out.includeStats = true;
  if (params.vatRatePercent != null && Number.isFinite(params.vatRatePercent)) {
    out.vatRatePercent = params.vatRatePercent;
  }
  if (params.additionalFee != null && Number.isFinite(params.additionalFee)) {
    out.additionalFee = params.additionalFee;
  }
  return out;
}

export type FoundPageResponse = {
  listings: ProductFinderListing[];
  count: number;
  page: number;
  limit: number;
  stats?: {
    total: number;
    missing_prices: number;
    profitable: number;
    total_profit?: number;
    avg_margin?: number;
    total_revenue?: number;
  };
};

export type FoundStats = {
  total: number;
  missing_prices: number;
  profitable: number;
  total_profit?: number;
  avg_margin?: number;
  total_revenue?: number;
};

function foundQueryString(params: FoundPageParams): string {
  const p = sanitizeFoundParams(params);
  const q = new URLSearchParams();
  if (p.page != null) q.set("page", String(p.page));
  if (p.limit != null) q.set("limit", String(p.limit));
  if (p.seller) q.set("seller", p.seller);
  if (p.q) q.set("q", p.q);
  if (p.profitable) q.set("profitable", "true");
  if (p.missingPrice) q.set("missingPrice", "true");
  if (p.hasPrice) q.set("hasPrice", "true");
  if (p.minMatchConfidence != null) q.set("minMatchConfidence", String(p.minMatchConfidence));
  if (p.minMargin != null) q.set("minMargin", String(p.minMargin));
  if (p.minSoldPrice != null) q.set("minSoldPrice", String(p.minSoldPrice));
  if (p.sort) q.set("sort", p.sort);
  if (p.includeStats) q.set("includeStats", "true");
  if (p.vatRatePercent != null && Number.isFinite(p.vatRatePercent)) {
    q.set("vatRatePercent", String(p.vatRatePercent));
  }
  if (p.additionalFee != null && Number.isFinite(p.additionalFee)) {
    q.set("additionalFee", String(p.additionalFee));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export async function fetchFoundPage(params: FoundPageParams = {}): Promise<FoundPageResponse> {
  const limit = params.limit ?? 50;
  return apiFetch<FoundPageResponse>(`/product-finder/found${foundQueryString(params)}`, {
    timeoutMs: limit >= 500 ? 180_000 : 120_000,
  });
}

const FETCH_ALL_PAGE_SIZE = 1000;

/** Load every row matching the current Found filters (paginated server fetch). */
export async function fetchAllFoundPages(
  params: Omit<FoundPageParams, "page" | "includeStats">,
  onProgress?: (loaded: number, total: number) => void
): Promise<ProductFinderListing[]> {
  const limit = FETCH_ALL_PAGE_SIZE;
  const base = sanitizeFoundParams({ ...params, limit, includeStats: false });
  const first = await fetchFoundPage({ ...base, page: 1 });
  const total = first.count;
  const all: ProductFinderListing[] = [...first.listings];
  onProgress?.(all.length, total);
  const pages = Math.max(1, Math.ceil(total / limit));
  for (let page = 2; page <= pages; page++) {
    const res = await fetchFoundPage({ ...base, page });
    all.push(...res.listings);
    onProgress?.(all.length, total);
  }
  return all;
}

export async function fetchFoundStats(): Promise<FoundStats> {
  return apiFetch<FoundStats>("/product-finder/found/stats", { timeoutMs: 30_000 });
}

export async function fetchFoundSellers(): Promise<{ sellers: string[] }> {
  return apiFetch<{ sellers: string[] }>("/product-finder/found/sellers", { timeoutMs: 30_000 });
}

export async function fetchFoundSellerCounts(): Promise<{ counts: Record<string, number> }> {
  return apiFetch<{ counts: Record<string, number> }>(
    "/product-finder/found/seller-counts",
    { timeoutMs: 30_000 }
  );
}

export type ActivePageParams = {
  page?: number;
  limit?: number;
  seller?: string;
  q?: string;
  profitable?: boolean;
  missingPrice?: boolean;
  hasPrice?: boolean;
  minMatchConfidence?: number;
  minMargin?: number;
  minListPrice?: number;
  sort?: "profit" | "margin" | "sold_price" | "match";
  includeStats?: boolean;
  vatRatePercent?: number;
  additionalFee?: number;
};

export function sanitizeActiveParams(params: ActivePageParams): ActivePageParams {
  const out: ActivePageParams = {
    page: params.page,
    limit: params.limit,
    sort: params.sort,
  };
  if (params.seller?.trim()) out.seller = params.seller.trim();
  if (params.q?.trim()) out.q = params.q.trim();
  if (params.profitable) out.profitable = true;
  if (params.missingPrice) out.missingPrice = true;
  if (params.hasPrice) out.hasPrice = true;
  if (params.minMatchConfidence != null && params.minMatchConfidence > 0) {
    out.minMatchConfidence = params.minMatchConfidence;
  }
  if (params.minMargin != null && params.minMargin > 0) out.minMargin = params.minMargin;
  if (params.minListPrice != null && params.minListPrice > 0) {
    out.minListPrice = params.minListPrice;
  }
  if (params.includeStats) out.includeStats = true;
  if (params.vatRatePercent != null && Number.isFinite(params.vatRatePercent)) {
    out.vatRatePercent = params.vatRatePercent;
  }
  if (params.additionalFee != null && Number.isFinite(params.additionalFee)) {
    out.additionalFee = params.additionalFee;
  }
  return out;
}

export type ActivePageResponse = FoundPageResponse;

function activeQueryString(params: ActivePageParams): string {
  const p = sanitizeActiveParams(params);
  const q = new URLSearchParams();
  if (p.page != null) q.set("page", String(p.page));
  if (p.limit != null) q.set("limit", String(p.limit));
  if (p.seller) q.set("seller", p.seller);
  if (p.q) q.set("q", p.q);
  if (p.profitable) q.set("profitable", "true");
  if (p.missingPrice) q.set("missingPrice", "true");
  if (p.hasPrice) q.set("hasPrice", "true");
  if (p.minMatchConfidence != null) q.set("minMatchConfidence", String(p.minMatchConfidence));
  if (p.minMargin != null) q.set("minMargin", String(p.minMargin));
  if (p.minListPrice != null) q.set("minListPrice", String(p.minListPrice));
  if (p.sort) q.set("sort", p.sort);
  if (p.includeStats) q.set("includeStats", "true");
  if (p.vatRatePercent != null && Number.isFinite(p.vatRatePercent)) {
    q.set("vatRatePercent", String(p.vatRatePercent));
  }
  if (p.additionalFee != null && Number.isFinite(p.additionalFee)) {
    q.set("additionalFee", String(p.additionalFee));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export async function fetchActivePage(params: ActivePageParams = {}): Promise<ActivePageResponse> {
  const limit = params.limit ?? 50;
  return apiFetch<ActivePageResponse>(`/product-finder/active${activeQueryString(params)}`, {
    timeoutMs: limit >= 500 ? 180_000 : 120_000,
  });
}

/** Load every row matching the current Live filters (paginated server fetch). */
export async function fetchAllActivePages(
  params: Omit<ActivePageParams, "page" | "includeStats">,
  onProgress?: (loaded: number, total: number) => void
): Promise<ProductFinderListing[]> {
  const limit = FETCH_ALL_PAGE_SIZE;
  const base = sanitizeActiveParams({ ...params, limit, includeStats: false });
  const first = await fetchActivePage({ ...base, page: 1 });
  const total = first.count;
  const all: ProductFinderListing[] = [...first.listings];
  onProgress?.(all.length, total);
  const pages = Math.max(1, Math.ceil(total / limit));
  for (let page = 2; page <= pages; page++) {
    const res = await fetchActivePage({ ...base, page });
    all.push(...res.listings);
    onProgress?.(all.length, total);
  }
  return all;
}

export async function fetchActiveStats(seller?: string): Promise<FoundStats> {
  const q = seller ? `?seller=${encodeURIComponent(seller)}` : "";
  return apiFetch<FoundStats>(`/product-finder/active/stats${q}`, { timeoutMs: 30_000 });
}

export async function fetchActiveSellers(): Promise<{ sellers: string[] }> {
  return apiFetch<{ sellers: string[] }>("/product-finder/active/sellers", { timeoutMs: 30_000 });
}

export async function fetchActiveSellerCounts(): Promise<{ counts: Record<string, number> }> {
  return apiFetch<{ counts: Record<string, number> }>(
    "/product-finder/active/seller-counts",
    { timeoutMs: 30_000 }
  );
}

export async function removeActiveProducts(
  listingKeys: string[],
  listings?: ProductFinderListing[]
): Promise<{ removed: number; total: number }> {
  const CHUNK = 500;
  if (listings && listings.length > 0) {
    let removed = 0;
    let total = 0;
    for (let i = 0; i < listings.length; i += CHUNK) {
      const chunk = listings.slice(i, i + CHUNK);
      const res = await apiFetch<{ removed: number; total: number }>(
        "/product-finder/active/remove",
        {
          method: "POST",
          body: JSON.stringify({ listingKeys: [], listings: chunk }),
          timeoutMs: 120_000,
        }
      );
      removed += res.removed;
      total = res.total;
    }
    return { removed, total };
  }
  if (listingKeys.length === 0) return { removed: 0, total: 0 };
  let removed = 0;
  let total = 0;
  for (let i = 0; i < listingKeys.length; i += CHUNK) {
    const chunk = listingKeys.slice(i, i + CHUNK);
    const res = await apiFetch<{ removed: number; total: number }>(
      "/product-finder/active/remove",
      {
        method: "POST",
        body: JSON.stringify({ listingKeys: chunk, listings: [] }),
        timeoutMs: 120_000,
      }
    );
    removed += res.removed;
    total = res.total;
  }
  return { removed, total };
}

export async function clearActiveProducts(seller?: string): Promise<{ cleared: number; total: number }> {
  const q = seller ? `?seller=${encodeURIComponent(seller)}` : "";
  return apiFetch<{ cleared: number; total: number }>(`/product-finder/active${q}`, {
    method: "DELETE",
    timeoutMs: 120_000,
  });
}

export async function fetchMissingPriceAsins(limit = 1000): Promise<{ asins: string[]; count: number }> {
  return apiFetch<{ asins: string[]; count: number }>(
    `/product-finder/found/missing-price-asins?limit=${limit}`,
    { timeoutMs: 60_000 }
  );
}

/** @deprecated use fetchFoundPage — loads one page only */
export async function fetchFoundProducts(): Promise<{ listings: ProductFinderListing[]; count: number }> {
  return fetchFoundPage({ page: 1, limit: 50 });
}

const FINDER_MERGE_CHUNK = 80;

export async function mergeFoundProducts(
  listings: ProductFinderListing[],
  meta?: { seller?: string; daysBack?: number }
): Promise<{ merged: number; total: number }> {
  if (listings.length === 0) {
    return request<{ merged: number; total: number }>("/product-finder/found/merge", {
      method: "POST",
      body: JSON.stringify({ listings: [], seller: meta?.seller, daysBack: meta?.daysBack }),
    });
  }
  let total = 0;
  for (let i = 0; i < listings.length; i += FINDER_MERGE_CHUNK) {
    const chunk = listings.slice(i, i + FINDER_MERGE_CHUNK);
    const res = await request<{ merged: number; total: number }>("/product-finder/found/merge", {
      method: "POST",
      body: JSON.stringify({
        listings: chunk,
        seller: meta?.seller,
        daysBack: meta?.daysBack,
      }),
    });
    total = res.total;
  }
  return { merged: listings.length, total };
}

export async function loadSellerAnalysis(
  seller: string,
  daysBack: number
): Promise<ProductFinderResult> {
  return apiFetch<ProductFinderResult>(
    `/product-finder/history/${encodeURIComponent(seller)}/${daysBack}`,
    { timeoutMs: 600_000 }
  );
}

export async function importFoundFromAnalysis(
  seller: string,
  daysBack: number
): Promise<{ seller: string; daysBack: number; imported: number; sellerInFound: number; total: number }> {
  return apiFetch<{ seller: string; daysBack: number; imported: number; sellerInFound: number; total: number }>(
    `/product-finder/found/import/${encodeURIComponent(seller)}/${daysBack}`,
    { method: "POST", timeoutMs: 600_000 }
  );
}

export async function importAllFoundFromAnalyses(): Promise<{
  imported: number;
  total: number;
  sellers: number;
}> {
  return apiFetch<{ imported: number; total: number; sellers: number }>(
    "/product-finder/found/import-all",
    { method: "POST", timeoutMs: 600_000 }
  );
}

export async function removeFoundProducts(
  listingKeys: string[],
  listings?: ProductFinderListing[]
): Promise<{ removed: number; total: number }> {
  return request<{ removed: number; total: number }>("/product-finder/found/remove", {
    method: "POST",
    body: JSON.stringify({ listingKeys, listings: listings ?? [] }),
  });
}

export async function clearFoundProducts(): Promise<{ cleared: number; archived?: number }> {
  return request<{ cleared: number; archived?: number }>("/product-finder/found", { method: "DELETE" });
}

/** Remove duplicate Found rows (same ASIN / eBay listing / title). Keeps highest profit. */
export async function dedupeFoundProducts(): Promise<{ removed: number; total: number }> {
  return apiFetch<{ removed: number; total: number }>("/product-finder/found/dedupe", {
    method: "POST",
    timeoutMs: 120_000,
  });
}

export type LibraryBucket = "saved" | "reserved";

export async function fetchLibraryProducts(
  bucket: LibraryBucket
): Promise<{ listings: ProductFinderListing[]; count: number }> {
  return apiFetch<{ listings: ProductFinderListing[]; count: number }>(
    `/product-finder/library?bucket=${bucket}`,
    { timeoutMs: 120_000, baseUrl: browserLibraryApiBase() }
  );
}

export async function syncLibraryProducts(
  bucket: LibraryBucket,
  listings: ProductFinderListing[],
  opts?: { force?: boolean }
): Promise<{ count: number }> {
  return apiFetch<{ count: number }>("/product-finder/library", {
    method: "PUT",
    body: JSON.stringify({ bucket, listings, force: opts?.force === true }),
    timeoutMs: 180_000,
    baseUrl: browserLibraryApiBase(),
  });
}

const LIBRARY_MERGE_CHUNK = 200;

export async function mergeLibraryProducts(
  bucket: LibraryBucket,
  listings: ProductFinderListing[]
): Promise<{ merged: number }> {
  if (listings.length === 0) return { merged: 0 };
  let merged = 0;
  for (let i = 0; i < listings.length; i += LIBRARY_MERGE_CHUNK) {
    const chunk = listings.slice(i, i + LIBRARY_MERGE_CHUNK);
    const res = await apiFetch<{ merged: number }>("/product-finder/library/merge", {
      method: "POST",
      body: JSON.stringify({ bucket, listings: chunk }),
      timeoutMs: 120_000,
      baseUrl: browserLibraryApiBase(),
    });
    merged += res.merged;
  }
  return { merged };
}

export async function moveLibraryProducts(
  from: LibraryBucket,
  to: LibraryBucket,
  listings: ProductFinderListing[]
): Promise<{ moved: number; saved: ProductFinderListing[]; reserved: ProductFinderListing[] }> {
  return apiFetch<{
    moved: number;
    saved: ProductFinderListing[];
    reserved: ProductFinderListing[];
  }>("/product-finder/library/move", {
    method: "POST",
    body: JSON.stringify({ from, to, listings }),
    timeoutMs: 120_000,
    baseUrl: browserLibraryApiBase(),
  });
}

export async function removeLibraryProducts(
  bucket: LibraryBucket,
  listings: ProductFinderListing[]
): Promise<{ removed: number }> {
  return apiFetch<{ removed: number }>("/product-finder/library/remove", {
    method: "POST",
    body: JSON.stringify({ bucket, listings }),
    timeoutMs: 60_000,
    baseUrl: browserLibraryApiBase(),
  });
}

export async function clearLibraryProducts(
  bucket: LibraryBucket
): Promise<{ cleared: number; archived?: number }> {
  return apiFetch<{ cleared: number; archived?: number }>(
    `/product-finder/library?bucket=${bucket}`,
    { method: "DELETE", timeoutMs: 60_000, baseUrl: browserLibraryApiBase() }
  );
}

export async function restoreLibraryToFound(
  bucket: LibraryBucket,
  listings: ProductFinderListing[]
): Promise<{
  restored: number;
  saved: ProductFinderListing[];
  reserved: ProductFinderListing[];
  foundTotal: number;
}> {
  return apiFetch<{
    restored: number;
    saved: ProductFinderListing[];
    reserved: ProductFinderListing[];
    foundTotal: number;
  }>("/product-finder/library/restore-to-found", {
    method: "POST",
    body: JSON.stringify({ bucket, listings }),
    timeoutMs: 120_000,
    baseUrl: browserLibraryApiBase(),
  });
}

export type PfArchiveSource = "found" | "saved" | "reserved";

export async function fetchArchiveStatus(
  source: PfArchiveSource
): Promise<{ source: PfArchiveSource; count: number; archivedAt: string | null }> {
  return apiFetch<{ source: PfArchiveSource; count: number; archivedAt: string | null }>(
    `/product-finder/archive/status?source=${source}`,
    { timeoutMs: 30_000 }
  );
}

export async function restoreArchiveSnapshot(source: PfArchiveSource): Promise<{
  restored: number;
  source: PfArchiveSource;
  foundTotal?: number;
  saved?: ProductFinderListing[];
  reserved?: ProductFinderListing[];
}> {
  return apiFetch<{
    restored: number;
    source: PfArchiveSource;
    foundTotal?: number;
    saved?: ProductFinderListing[];
    reserved?: ProductFinderListing[];
  }>("/product-finder/archive/restore", {
    method: "POST",
    body: JSON.stringify({ source }),
    timeoutMs: 120_000,
  });
}

export async function dedupeLibraryProducts(
  bucket: LibraryBucket
): Promise<{ removed: number; total: number; listings: ProductFinderListing[] }> {
  return apiFetch<{ removed: number; total: number; listings: ProductFinderListing[] }>(
    `/product-finder/library/dedupe?bucket=${bucket}`,
    { method: "POST", timeoutMs: 120_000, baseUrl: browserLibraryApiBase() }
  );
}

export async function getSellerInfo(
  seller: string
): Promise<{ seller: string; exists: boolean }> {
  return request<{ seller: string; exists: boolean }>(
    `/product-finder/seller-info/${encodeURIComponent(seller)}`
  );
}

export async function updateOrder(
  storeId: string,
  id: string,
  patch: {
    notes?: string;
    sourceOrderUrl?: string;
    carrier?: string;
    tracking?: string;
    status?: "received_not_ordered" | "ordered" | "tracking" | "delivered";
  }
): Promise<OrderRow> {
  return request<OrderRow>(`/stores/${storeId}/orders/${id}`, {
    method: "POST",
    body: JSON.stringify(patch),
  });
}
