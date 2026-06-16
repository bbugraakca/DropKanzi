export type PolicyOption = { id: string; name: string };

/** Matches backend ebayMock.ts — used for demo store listing without eBay API. */
export const MOCK_EBAY_POLICY_IDS = {
  paymentPolicyId: "mock-payment-us",
  returnPolicyId: "mock-return-30",
  fulfillmentPolicyId: "mock-shipping-free",
};

function pickPolicies(raw: unknown, idKeys: string[], nameKeys: string[]): PolicyOption[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const list =
    (Array.isArray(obj.paymentPolicies) && obj.paymentPolicies) ||
    (Array.isArray(obj.returnPolicies) && obj.returnPolicies) ||
    (Array.isArray(obj.fulfillmentPolicies) && obj.fulfillmentPolicies) ||
    [];

  return list
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const id = idKeys.map((k) => row[k]).find((v) => typeof v === "string") as
        | string
        | undefined;
      const name = nameKeys.map((k) => row[k]).find((v) => typeof v === "string") as
        | string
        | undefined;
      if (!id) return null;
      return { id, name: name || id };
    })
    .filter(Boolean) as PolicyOption[];
}

export function parsePaymentPolicies(data: unknown): PolicyOption[] {
  return pickPolicies(data, ["paymentPolicyId"], ["name", "paymentPolicyId"]);
}

export function parseReturnPolicies(data: unknown): PolicyOption[] {
  return pickPolicies(data, ["returnPolicyId"], ["name", "returnPolicyId"]);
}

export function parseFulfillmentPolicies(data: unknown): PolicyOption[] {
  return pickPolicies(data, ["fulfillmentPolicyId"], ["name", "fulfillmentPolicyId"]);
}

const POLICY_STORAGE = "dropkanzi.listingPolicies";

export function loadSavedPolicyIds(storeId: string): {
  paymentPolicyId: string;
  returnPolicyId: string;
  fulfillmentPolicyId: string;
} {
  if (typeof window === "undefined") {
    return { paymentPolicyId: "", returnPolicyId: "", fulfillmentPolicyId: "" };
  }
  try {
    const all = JSON.parse(window.localStorage.getItem(POLICY_STORAGE) || "{}") as Record<
      string,
      { paymentPolicyId?: string; returnPolicyId?: string; fulfillmentPolicyId?: string }
    >;
    const s = all[storeId] || {};
    return {
      paymentPolicyId: s.paymentPolicyId || "",
      returnPolicyId: s.returnPolicyId || "",
      fulfillmentPolicyId: s.fulfillmentPolicyId || "",
    };
  } catch {
    return { paymentPolicyId: "", returnPolicyId: "", fulfillmentPolicyId: "" };
  }
}

export function savePolicyIds(
  storeId: string,
  ids: { paymentPolicyId: string; returnPolicyId: string; fulfillmentPolicyId: string }
) {
  if (typeof window === "undefined") return;
  try {
    const all = JSON.parse(window.localStorage.getItem(POLICY_STORAGE) || "{}") as Record<
      string,
      unknown
    >;
    all[storeId] = ids;
    window.localStorage.setItem(POLICY_STORAGE, JSON.stringify(all));
  } catch {
    // ignore
  }
}
