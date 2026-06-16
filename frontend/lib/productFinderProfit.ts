import type { ProductFinderListing } from "./api";

const EBAY_FEE_RATE = 0.1325;
const PAYMENT_FEE_RATE = 0.03;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function vatRateFromSettings(settings?: Record<string, unknown> | null): number {
  if (!settings) return 0;
  const vat = (settings.vatDetails ?? settings.vat) as Record<string, unknown> | undefined;
  if (!vat) return 0;
  const enabled = Boolean(vat.vatEnabled ?? vat.enabled);
  if (!enabled) return 0;
  const pct = Number(vat.vatRatePercent ?? vat.vatPercent ?? 0);
  return Number.isFinite(pct) ? pct / 100 : 0;
}

function additionalFeeFromSettings(settings?: Record<string, unknown> | null): number {
  if (!settings) return 0;
  const fee = settings.additionalFee as Record<string, unknown> | undefined;
  if (!fee) return 0;
  for (const key of ["fixedFee", "extraFeeFixed", "amount"] as const) {
    const val = fee[key];
    if (val != null && val !== "") {
      const n = Number(val);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

/** Reverse profit: eBay sold price vs Amazon buy cost (matches scraper profit_calculator.py). */
export function calculateProductFinderProfit(
  soldPrice: number,
  amazonPrice: number,
  storeSettings?: Record<string, unknown> | null
) {
  const revenue = soldPrice;
  const ebayFee = revenue * EBAY_FEE_RATE;
  const paymentFee = revenue * PAYMENT_FEE_RATE;
  const vatRate = vatRateFromSettings(storeSettings);
  const additionalFee = additionalFeeFromSettings(storeSettings);
  const amazonCost = amazonPrice * (1 + vatRate) + additionalFee;
  const netProfit = revenue - ebayFee - paymentFee - amazonCost;
  const margin = revenue > 0 ? (netProfit / revenue) * 100 : 0;
  const roi = amazonCost > 0 ? (netProfit / amazonCost) * 100 : 0;

  return {
    revenue: round2(revenue),
    ebay_fee: round2(ebayFee),
    payment_fee: round2(paymentFee),
    amazon_cost: round2(amazonCost),
    net_profit: round2(netProfit),
    margin_percent: round2(margin),
    roi_percent: round2(roi),
    is_profitable: netProfit > 0,
  };
}

/** Fill profit fields when sold + Amazon prices exist (e.g. after late price fetch). */
export function enrichListingProfit(
  listing: ProductFinderListing,
  storeSettings?: Record<string, unknown> | null
): ProductFinderListing {
  const sold = listing.sold_price;
  const amazon = listing.amazon_price;
  if (
    sold == null ||
    amazon == null ||
    !Number.isFinite(sold) ||
    !Number.isFinite(amazon) ||
    sold <= 0 ||
    amazon <= 0
  ) {
    return listing;
  }
  return { ...listing, ...calculateProductFinderProfit(sold, amazon, storeSettings) };
}

export function enrichListingsProfit(
  listings: ProductFinderListing[],
  storeSettings?: Record<string, unknown> | null
): ProductFinderListing[] {
  return listings.map((l) => enrichListingProfit(l, storeSettings));
}

export function profitQueryFromSettings(
  storeSettings?: Record<string, unknown> | null
): { vatRatePercent: number; additionalFee: number } {
  return {
    vatRatePercent: vatRateFromSettings(storeSettings) * 100,
    additionalFee: additionalFeeFromSettings(storeSettings),
  };
}
