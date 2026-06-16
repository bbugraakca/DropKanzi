import { prisma } from "./db";
import { refreshAccessToken } from "./ebayOAuth";
import {
  isDemoStore,
  MOCK_FULFILLMENT_POLICIES,
  MOCK_PAYMENT_POLICIES,
  MOCK_RETURN_POLICIES,
} from "./ebayMock";

const EBAY_SANDBOX = (process.env.EBAY_SANDBOX || "false").toLowerCase() === "true";

function apiBase() {
  return EBAY_SANDBOX ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}

export function marketplaceIdFromCountry(country: string) {
  const c = String(country || "US").toUpperCase();
  if (c === "US") return "EBAY_US";
  if (c === "GB" || c === "UK") return "EBAY_GB";
  if (c === "DE") return "EBAY_DE";
  if (c === "FR") return "EBAY_FR";
  if (c === "IT") return "EBAY_IT";
  if (c === "ES") return "EBAY_ES";
  if (c === "CA") return "EBAY_CA";
  if (c === "AU") return "EBAY_AU";
  return "EBAY_US";
}

async function getValidAccessToken(storeId: string) {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new Error("Store not found");

  const needsRefresh = store.expiresAt.getTime() - Date.now() < 60_000;
  if (!needsRefresh) return { store, accessToken: store.accessToken };

  if (!store.refreshToken) throw new Error("Missing refresh token for store");

  const token = await refreshAccessToken(store.refreshToken);
  const expiresAt = new Date(Date.now() + token.expires_in * 1000);
  const updated = await prisma.store.update({
    where: { id: storeId },
    data: {
      accessToken: token.access_token,
      expiresAt,
      // refresh_token may be omitted on refresh responses; keep existing
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    },
  });

  return { store: updated, accessToken: updated.accessToken };
}

export async function ebayFetch<T>(
  storeId: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const { store, accessToken } = await getValidAccessToken(storeId);
  const marketplaceId = marketplaceIdFromCountry(store.country);
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
      ...(init?.headers || {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`eBay API error: ${res.status} ${text}`);
  }
  return (text ? (JSON.parse(text) as T) : ({} as T));
}

export async function getPaymentPolicies(storeId: string) {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new Error("Store not found");
  if (isDemoStore(store)) return MOCK_PAYMENT_POLICIES;

  const { store: refreshed } = await getValidAccessToken(storeId);
  const marketplaceId = marketplaceIdFromCountry(refreshed.country);
  return ebayFetch<{ paymentPolicies?: unknown[] }>(
    storeId,
    `/sell/account/v1/payment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`
  );
}

export async function getReturnPolicies(storeId: string) {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new Error("Store not found");
  if (isDemoStore(store)) return MOCK_RETURN_POLICIES;

  const { store: refreshed } = await getValidAccessToken(storeId);
  const marketplaceId = marketplaceIdFromCountry(refreshed.country);
  return ebayFetch<{ returnPolicies?: unknown[] }>(
    storeId,
    `/sell/account/v1/return_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`
  );
}

export async function getFulfillmentPolicies(storeId: string) {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new Error("Store not found");
  if (isDemoStore(store)) return MOCK_FULFILLMENT_POLICIES;

  const { store: refreshed } = await getValidAccessToken(storeId);
  const marketplaceId = marketplaceIdFromCountry(refreshed.country);
  return ebayFetch<{ fulfillmentPolicies?: unknown[] }>(
    storeId,
    `/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`
  );
}

export async function getOrders(storeId: string, limit = 50, offset = 0) {
  return ebayFetch<any>(
    storeId,
    `/sell/fulfillment/v1/order?limit=${limit}&offset=${offset}`
  );
}

export async function getOrder(storeId: string, orderId: string) {
  return ebayFetch<any>(storeId, `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`);
}

