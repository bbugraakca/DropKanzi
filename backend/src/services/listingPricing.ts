import type { Product } from "@prisma/client";
import { applyListingTemplate } from "./listingTemplate";
import { calcSuggestedEbayPrice } from "./priceCalc";

export type ListingDraft = {
  asin: string;
  title: string;
  description: string;
  price: number;
  quantity: number;
  condition: string;
  categoryId?: string;
  amazonPrice: number | null;
  breakdown: ReturnType<typeof calcSuggestedEbayPrice>["breakdown"];
  /** Which store settings keys were applied (audit trail). */
  settingsApplied: string[];
};

type ProductLike = Pick<
  Product,
  "asin" | "title" | "description" | "aboutText" | "bulletPoints" | "images" | "price"
>;

/**
 * Applies every listing-related store setting in order:
 * rangeRepricing → repricingSettings (min/addons) → additionalFee → vatDetails → roundPrices
 * → listingTemplate → offerSelection → repricingSettings (qty)
 */
export function buildListingFromStoreSettings(
  storeSettings: Record<string, unknown> | null | undefined,
  product: ProductLike,
  overrides?: {
    title?: string;
    price?: number;
    quantity?: number;
    condition?: string;
    /** If true, use client price instead of calculated (not recommended). */
    manualPrice?: boolean;
  }
): ListingDraft {
  const settings = storeSettings || {};
  const applied: string[] = [];

  const amazonPrice = product.price != null ? Number(product.price) : null;

  // 1–5: Price pipeline
  applied.push(
    "rangeRepricing",
    "repricingSettings",
    "additionalFee",
    "vatDetails",
    "roundPrices"
  );

  let price = 0;
  let breakdown = calcSuggestedEbayPrice({ amazonPrice: amazonPrice || 0, settings }).breakdown;

  if (amazonPrice && amazonPrice > 0) {
    const calc = calcSuggestedEbayPrice({ amazonPrice, settings });
    breakdown = calc.breakdown;
    price = overrides?.manualPrice && overrides.price != null ? overrides.price : calc.suggested;
  } else if (overrides?.price != null) {
    price = overrides.price;
  }

  // 6: Listing template (title + HTML description + category)
  applied.push("listingTemplate");
  const template = (settings.listingTemplate || settings.listingDefaults) as
    | Record<string, unknown>
    | undefined;
  const baseTitle =
    overrides?.title?.trim() || product.title?.trim() || `Item ${product.asin}`;
  const templated = applyListingTemplate(
    {
      asin: product.asin,
      title: product.title,
      description: product.description,
      aboutText: product.aboutText,
      bulletPoints: product.bulletPoints,
    },
    baseTitle,
    template
  );

  // 7: Offer selection → condition
  applied.push("offerSelection");
  const offer = settings.offerSelection as { condition?: string } | undefined;
  let condition = overrides?.condition || offer?.condition || "New";
  if (condition === "Any") condition = "New";

  // 8: Default quantity from repricing settings
  const repricing = (settings.repricingSettings || {}) as { quantityInStock?: number };
  const quantity =
    overrides?.quantity ??
    (Number(repricing.quantityInStock) > 0 ? Number(repricing.quantityInStock) : 1);

  // Location is applied at eBay publish (ebayListing.ensureMerchantLocation)
  applied.push("locationSettings");

  return {
    asin: product.asin,
    title: templated.title,
    description: templated.description,
    price,
    quantity,
    condition,
    categoryId: templated.categoryId,
    amazonPrice,
    breakdown,
    settingsApplied: applied,
  };
}
