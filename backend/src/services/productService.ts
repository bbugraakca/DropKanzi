import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import {
  scrapeDidFullFetch,
  scrapePriceOnly,
  scrapeProduct,
  ScrapeResult,
} from "./scraper";
import { extractAsin } from "../utils/asin";

export { extractAsin };

const CACHE_MS = 5 * 60 * 1000;
const FULL_FETCH_MS = 24 * 60 * 60 * 1000;

export function needsFullPage(
  title: string | null | undefined,
  fullFetchAt: Date | null | undefined,
  price: number | null | undefined,
  bulletPoints?: string[] | null
): boolean {
  if (!title || price == null) return true;
  if (!bulletPoints || bulletPoints.length === 0) return true;
  if (!fullFetchAt) return true;
  return Date.now() - fullFetchAt.getTime() > FULL_FETCH_MS;
}

function mapScrapeToDb(data: ScrapeResult) {
  const attrs =
    data.attributes && Object.keys(data.attributes).length > 0
      ? (data.attributes as Prisma.InputJsonValue)
      : undefined;

  return {
    asin: data.asin,
    title: data.title ?? null,
    description: data.description ?? null,
    aboutText: data.about_text ?? null,
    bulletPoints: data.bullet_points ?? [],
    attributes: attrs,
    dimensions: data.dimensions ?? null,
    brand: data.brand ?? null,
    images: data.images ?? [],
    rating: data.rating ?? null,
    reviewsCount: data.reviews_count ?? null,
    price: data.price,
    stock: data.stock,
    isInStock: data.is_in_stock,
    buyBoxSeller: data.buy_box_seller,
    isAmazonFulfilled: data.is_amazon_fulfilled,
    isPrime: !!data.is_prime,
    isPrimePantry: !!data.is_prime_pantry,
  };
}

export async function upsertFromScrape(data: ScrapeResult, fullPage: boolean) {
  const mapped = mapScrapeToDb(data);

  await prisma.product.upsert({
    where: { asin: data.asin },
    create: {
      ...mapped,
      fullFetchAt: fullPage ? new Date() : null,
    },
    update: {
      ...(data.title != null && { title: data.title }),
      ...(data.description != null && { description: data.description }),
      ...(data.about_text != null && { aboutText: data.about_text }),
      ...(data.bullet_points &&
        data.bullet_points.length > 0 && { bulletPoints: data.bullet_points }),
      ...(data.attributes &&
        Object.keys(data.attributes).length > 0 && {
          attributes: data.attributes as Prisma.InputJsonValue,
        }),
      ...(data.dimensions != null && { dimensions: data.dimensions }),
      ...(data.brand != null && { brand: data.brand }),
      ...(data.images && data.images.length > 0 && { images: data.images }),
      ...(data.rating != null && { rating: data.rating }),
      ...(data.reviews_count != null && { reviewsCount: data.reviews_count }),
      price: data.price,
      stock: data.stock,
      isInStock: data.is_in_stock,
      buyBoxSeller: data.buy_box_seller,
      isAmazonFulfilled: data.is_amazon_fulfilled,
      isPrime: !!data.is_prime,
      isPrimePantry: !!data.is_prime_pantry,
      ...(fullPage && { fullFetchAt: new Date() }),
    },
  });

  await prisma.priceHistory.create({
    data: {
      asin: data.asin,
      price: data.price,
      stock: data.stock,
      isInStock: data.is_in_stock,
      buyBoxSeller: data.buy_box_seller,
    },
  });
}

async function upsertPriceOnlyFromScrape(data: ScrapeResult) {
  const asin = data.asin.toUpperCase();
  const priceFields = {
    price: data.price,
    stock: data.stock,
    isInStock: data.is_in_stock,
    buyBoxSeller: data.buy_box_seller,
    isAmazonFulfilled: data.is_amazon_fulfilled,
    isPrime: !!data.is_prime,
    isPrimePantry: !!data.is_prime_pantry,
  };

  await prisma.product.upsert({
    where: { asin },
    create: {
      asin,
      title: data.title ?? null,
      images: data.images?.length ? data.images : [],
      bulletPoints: data.bullet_points ?? [],
      ...priceFields,
    },
    update: priceFields,
  });

  await prisma.priceHistory.create({
    data: {
      asin,
      price: data.price,
      stock: data.stock,
      isInStock: data.is_in_stock,
      buyBoxSeller: data.buy_box_seller,
    },
  });
}

/** AOD-only price refresh (~8–140 KB). Skips full /dp page when fullFetchAt is recent. */
export async function refreshProductPrice(asinInput: string) {
  const normalized = extractAsin(asinInput);
  if (!normalized) {
    throw new Error(
      "Gecersiz ASIN. 10 karakter (orn. B0D1XD1ZV3) veya Amazon /dp/ linki girin."
    );
  }

  let scraped = await scrapePriceOnly(normalized);
  if (!scraped?.price) {
    // Extra client-side retry if scraper was briefly blocked
    for (let attempt = 0; attempt < 2 && !scraped?.price; attempt++) {
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      scraped = await scrapePriceOnly(normalized);
    }
  }

  if (!scraped) {
    throw new Error("Price check failed — Amazon blocked or ASIN unavailable");
  }

  if (scraped.price == null) {
    throw new Error("No buy box price returned from Amazon");
  }

  await upsertPriceOnlyFromScrape(scraped);

  const product = await prisma.product.findUnique({
    where: { asin: normalized },
  });

  if (!product) {
    throw new Error("Product not found after price update");
  }

  return {
    product,
    meta: {
      fetch_type: scraped.fetch_type ?? "aod",
      bytes_downloaded: scraped.bytes_downloaded ?? 0,
      full_fetch: scraped.full_fetch ?? false,
    },
  };
}

export async function searchProduct(asinInput: string) {
  const normalized = extractAsin(asinInput);
  if (!normalized) {
    throw new Error(
      "Gecersiz ASIN. 10 karakter (orn. B0D1XD1ZV3) veya Amazon /dp/ linki girin."
    );
  }

  const existing = await prisma.product.findUnique({
    where: { asin: normalized },
  });

  if (
    existing &&
    existing.price != null &&
    existing.bulletPoints.length > 0 &&
    Date.now() - existing.updatedAt.getTime() < CACHE_MS
  ) {
    return prisma.product.findUnique({
      where: { asin: normalized },
      include: {
        priceHistory: { orderBy: { scrapedAt: "desc" }, take: 30 },
      },
    });
  }

  const forceFullPage = needsFullPage(
    existing?.title,
    existing?.fullFetchAt,
    existing?.price,
    existing?.bulletPoints
  );

  const scraped = await scrapeProduct(normalized, {
    forceFullPage,
    lastFullFetch: existing?.fullFetchAt ?? null,
  });
  if (!scraped) return null;

  await upsertFromScrape(scraped, scrapeDidFullFetch(scraped));

  return prisma.product.findUnique({
    where: { asin: normalized },
    include: {
      priceHistory: { orderBy: { scrapedAt: "desc" }, take: 30 },
    },
  });
}
