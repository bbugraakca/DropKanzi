/** Mock eBay business policies for demo stores (no OAuth / API calls). */

export const MOCK_PAYMENT_POLICY_ID = "mock-payment-us";
export const MOCK_RETURN_POLICY_ID = "mock-return-30";
export const MOCK_FULFILLMENT_POLICY_ID = "mock-shipping-free";

export const MOCK_PAYMENT_POLICIES = {
  paymentPolicies: [
    {
      paymentPolicyId: MOCK_PAYMENT_POLICY_ID,
      name: "Mock Payment — PayPal & cards",
      marketplaceId: "EBAY_US",
    },
  ],
};

export const MOCK_RETURN_POLICIES = {
  returnPolicies: [
    {
      returnPolicyId: MOCK_RETURN_POLICY_ID,
      name: "Mock Returns — 30 days",
      marketplaceId: "EBAY_US",
    },
  ],
};

export const MOCK_FULFILLMENT_POLICIES = {
  fulfillmentPolicies: [
    {
      fulfillmentPolicyId: MOCK_FULFILLMENT_POLICY_ID,
      name: "Mock Shipping — Free 3–5 business days",
      marketplaceId: "EBAY_US",
    },
  ],
};

export function isDemoStore(store: {
  accessToken: string;
  settings?: unknown;
}): boolean {
  if (store.accessToken === "demo") return true;
  const settings = store.settings as Record<string, unknown> | null;
  return settings?.isDemo === true;
}

export function mockPublishListing(sku: string): {
  offerId: string;
  listingId: string;
} {
  const suffix = Math.floor(100000000 + Math.random() * 899999999);
  return {
    offerId: `demo-offer-${sku}`,
    listingId: String(suffix),
  };
}

export const DEMO_LISTING_DEFAULTS = {
  paymentPolicyId: MOCK_PAYMENT_POLICY_ID,
  returnPolicyId: MOCK_RETURN_POLICY_ID,
  fulfillmentPolicyId: MOCK_FULFILLMENT_POLICY_ID,
};
