import { prisma } from "./db";
import { ebayFetch, marketplaceIdFromCountry } from "./ebayApi";
import { isDemoStore, mockPublishListing } from "./ebayMock";

const MERCHANT_LOCATION_KEY =
  process.env.EBAY_MERCHANT_LOCATION_KEY || "dropkanzi_default";

function currencyForCountry(country: string) {
  const c = String(country || "US").toUpperCase();
  if (c === "GB" || c === "UK") return "GBP";
  if (["DE", "FR", "IT", "ES"].includes(c)) return "EUR";
  if (c === "CA") return "CAD";
  if (c === "AU") return "AUD";
  return "USD";
}

function conditionEnum(condition: string) {
  const c = String(condition || "New").toLowerCase();
  if (c === "used") return "USED_GOOD";
  if (c === "refurbished") return "CERTIFIED_REFURBISHED";
  return "NEW";
}

function countryIso(store: { country: string; settings?: unknown }) {
  const settings = (store.settings as Record<string, unknown> | null) || {};
  const loc = (settings.locationSettings || settings.location) as
    | { country?: string; location?: string; postalCode?: string }
    | undefined;
  const name = String(loc?.country || "").toLowerCase();
  if (name.includes("united kingdom")) return "GB";
  if (name.includes("germany")) return "DE";
  if (name.includes("france")) return "FR";
  if (name.includes("italy")) return "IT";
  if (name.includes("spain")) return "ES";
  if (name.includes("canada")) return "CA";
  if (name.includes("australia")) return "AU";
  if (name.includes("united states")) return "US";
  return String(store.country || "US").toUpperCase().slice(0, 2);
}

function defaultCategoryId(store: { country: string; settings?: unknown }) {
  const settings = (store.settings as Record<string, unknown> | null) || {};
  const defaults = settings.listingDefaults as { categoryId?: string } | undefined;
  if (defaults?.categoryId) return String(defaults.categoryId);
  const env = process.env.EBAY_DEFAULT_CATEGORY_ID;
  if (env) return env;
  const c = String(store.country || "US").toUpperCase();
  if (c === "GB" || c === "UK") return "9355";
  return "58058";
}

async function ensureMerchantLocation(storeId: string) {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new Error("Store not found");

  try {
    const list = await ebayFetch<{ locations?: { merchantLocationKey?: string }[] }>(
      storeId,
      `/sell/inventory/v1/location?limit=1`
    );
    const key = list?.locations?.[0]?.merchantLocationKey;
    if (key) return key;
  } catch {
    // create below
  }

  const settings = (store.settings as Record<string, unknown> | null) || {};
  const loc = (settings.locationSettings || settings.location) as
    | { location?: string; postalCode?: string }
    | undefined;

  const iso = countryIso(store);
  await ebayFetch(
    storeId,
    `/sell/inventory/v1/location/${encodeURIComponent(MERCHANT_LOCATION_KEY)}`,
    {
      method: "POST",
      body: JSON.stringify({
        name: "Default warehouse",
        locationTypes: ["WAREHOUSE"],
        merchantLocationStatus: "ENABLED",
        location: {
          address: {
            addressLine1: "1 Main St",
            city: String(loc?.location || "Chicago"),
            postalCode: String(loc?.postalCode || "60631"),
            country: iso,
          },
        },
      }),
    }
  );

  return MERCHANT_LOCATION_KEY;
}

export type PublishListingInput = {
  sku: string;
  title: string;
  description: string;
  price: number;
  quantity: number;
  condition: string;
  imageUrls: string[];
  paymentPolicyId: string;
  returnPolicyId: string;
  fulfillmentPolicyId: string;
  categoryId?: string;
};

export async function publishListingToEbay(
  storeId: string,
  input: PublishListingInput
): Promise<{ offerId: string; listingId?: string }> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new Error("Store not found");

  if (isDemoStore(store)) {
    return mockPublishListing(input.sku);
  }

  const marketplaceId = marketplaceIdFromCountry(store.country);
  const currency = currencyForCountry(store.country);
  const merchantLocationKey = await ensureMerchantLocation(storeId);
  const categoryId = input.categoryId || defaultCategoryId(store);
  const sku = input.sku.slice(0, 50);

  const images = input.imageUrls.filter(Boolean).slice(0, 12);
  const description =
    input.description?.trim() ||
    `<p>${input.title}</p>`;

  await ebayFetch(storeId, `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: "PUT",
    body: JSON.stringify({
      availability: {
        shipToLocationAvailability: {
          quantity: Math.max(1, Math.floor(input.quantity)),
        },
      },
      condition: conditionEnum(input.condition),
      product: {
        title: input.title.slice(0, 80),
        description,
        imageUrls: images.length ? images : undefined,
      },
    }),
  });

  const offerRes = await ebayFetch<{ offerId?: string }>(
    storeId,
    `/sell/inventory/v1/offer`,
    {
      method: "POST",
      body: JSON.stringify({
        sku,
        marketplaceId,
        format: "FIXED_PRICE",
        availableQuantity: Math.max(1, Math.floor(input.quantity)),
        categoryId,
        merchantLocationKey,
        listingPolicies: {
          paymentPolicyId: input.paymentPolicyId,
          returnPolicyId: input.returnPolicyId,
          fulfillmentPolicyId: input.fulfillmentPolicyId,
        },
        pricingSummary: {
          price: {
            value: String(Number(input.price).toFixed(2)),
            currency,
          },
        },
      }),
    }
  );

  const offerId = offerRes?.offerId;
  if (!offerId) throw new Error("eBay did not return offerId");

  const published = await ebayFetch<{ listingId?: string }>(
    storeId,
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
    { method: "POST", body: JSON.stringify({}) }
  );

  return { offerId, listingId: published?.listingId };
}

export type ReviseListingInput = {
  sku: string;
  title: string;
  description: string;
  price: number;
  quantity: number;
  condition: string;
  imageUrls: string[];
};

/** Push new price/qty/title to an existing inventory offer (repricing apply). */
export async function reviseListingOnEbay(
  storeId: string,
  input: ReviseListingInput
): Promise<void> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new Error("Store not found");

  if (isDemoStore(store)) {
    return;
  }

  const marketplaceId = marketplaceIdFromCountry(store.country);
  const currency = currencyForCountry(store.country);
  const sku = input.sku.slice(0, 50);
  const images = input.imageUrls.filter(Boolean).slice(0, 12);
  const description =
    input.description?.trim() || `<p>${input.title}</p>`;

  await ebayFetch(storeId, `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: "PUT",
    body: JSON.stringify({
      availability: {
        shipToLocationAvailability: {
          quantity: Math.max(1, Math.floor(input.quantity)),
        },
      },
      condition: conditionEnum(input.condition),
      product: {
        title: input.title.slice(0, 80),
        description,
        imageUrls: images.length ? images : undefined,
      },
    }),
  });

  const list = await ebayFetch<{ offers?: { offerId?: string }[] }>(
    storeId,
    `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${encodeURIComponent(marketplaceId)}&limit=5`
  );

  const offerId = list?.offers?.[0]?.offerId;
  if (!offerId) {
    throw new Error(`No eBay offer found for SKU ${sku}`);
  }

  const existing = await ebayFetch<Record<string, unknown>>(
    storeId,
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`
  );

  await ebayFetch(
    storeId,
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        ...existing,
        sku,
        marketplaceId,
        availableQuantity: Math.max(1, Math.floor(input.quantity)),
        pricingSummary: {
          price: {
            value: String(Number(input.price).toFixed(2)),
            currency,
          },
        },
      }),
    }
  );
}
