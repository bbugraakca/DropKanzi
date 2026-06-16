const SCRAPER_URL = process.env.SCRAPER_URL || "http://localhost:8001";

export interface ScrapeResult {
  asin: string;
  price: number | null;
  stock: string;
  is_in_stock: boolean;
  buy_box_seller: string | null;
  is_amazon_fulfilled: boolean;
  is_prime?: boolean;
  is_prime_pantry?: boolean;
  title?: string | null;
  description?: string | null;
  about_text?: string | null;
  bullet_points?: string[];
  attributes?: Record<string, string>;
  dimensions?: string | null;
  brand?: string | null;
  images?: string[];
  rating?: number | null;
  reviews_count?: number | null;
  all_offer_prices?: number[];
  scraped_at: string;
  fetch_type?: "aod" | "full" | "full_page" | "dp_stream" | "dp_offer";
  full_fetch?: boolean;
  bytes_downloaded?: number;
  error?: string;
}

export type ScrapeProductOptions = {
  /** Force full /dp page in addition to AOD */
  forceFullPage?: boolean;
  lastFullFetch?: Date | null;
};

export type ScrapeBatchOptions = {
  concurrency?: number;
  fullPageAsins?: string[];
  lastFullFetchByAsin?: Record<string, string | null>;
};

export async function scrapePriceOnly(asin: string): Promise<ScrapeResult | null> {
  const res = await fetch(`${SCRAPER_URL}/scrape/price`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asin }),
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Scraper price error: ${res.status} ${text}`);
  }
  return res.json() as Promise<ScrapeResult>;
}

export async function scrapeProduct(
  asin: string,
  options?: ScrapeProductOptions
): Promise<ScrapeResult | null> {
  const res = await fetch(`${SCRAPER_URL}/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      asin,
      full_page: options?.forceFullPage ?? false,
      last_full_fetch: options?.lastFullFetch?.toISOString() ?? null,
      fast: false,
    }),
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Scraper error: ${res.status} ${text}`);
  }
  return res.json() as Promise<ScrapeResult>;
}

export async function scrapeBatch(
  asins: string[],
  options?: ScrapeBatchOptions
): Promise<ScrapeResult[]> {
  const limit =
    options?.concurrency ?? parseInt(process.env.BULK_CONCURRENCY || "40", 10);
  const timeoutMs = Math.min(600_000, 60_000 + asins.length * 2500);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const res = await fetch(`${SCRAPER_URL}/scrape/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      asins,
      full_page: false,
      full_page_asins: options?.fullPageAsins ?? [],
      last_full_fetch_by_asin: options?.lastFullFetchByAsin ?? {},
      fast: true,
      concurrency: limit,
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Scraper batch error: ${res.status} ${text}`);
  }
  return res.json() as Promise<ScrapeResult[]>;
}

export function scrapeDidFullFetch(result: ScrapeResult): boolean {
  return (
    result.full_fetch === true ||
    result.fetch_type === "full" ||
    result.fetch_type === "full_page"
  );
}
