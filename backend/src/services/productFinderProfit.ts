/** Profit math for Product Finder (matches frontend `productFinderProfit.ts`). */

const EBAY_FEE_RATE = 0.1325;
const PAYMENT_FEE_RATE = 0.03;
/** Revenue after eBay + payment fees: 1 - 0.1325 - 0.03 */
export const REVENUE_AFTER_FEES = 1 - EBAY_FEE_RATE - PAYMENT_FEE_RATE;

export type ProfitQueryParams = {
  vatRate?: number;
  additionalFee?: number;
};

export function vatRateFromSettings(settings?: Record<string, unknown> | null): number {
  if (!settings) return 0;
  const vat = (settings.vatDetails ?? settings.vat) as Record<string, unknown> | undefined;
  if (!vat) return 0;
  const enabled = Boolean(vat.vatEnabled ?? vat.enabled);
  if (!enabled) return 0;
  const pct = Number(vat.vatRatePercent ?? vat.vatPercent ?? 0);
  return Number.isFinite(pct) ? pct / 100 : 0;
}

export function additionalFeeFromSettings(settings?: Record<string, unknown> | null): number {
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

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function calculateProductFinderProfit(
  soldPrice: number,
  amazonPrice: number,
  params: ProfitQueryParams = {}
): {
  revenue: number;
  ebay_fee: number;
  payment_fee: number;
  amazon_cost: number;
  net_profit: number;
  margin_percent: number;
  roi_percent: number;
  is_profitable: boolean;
} {
  const vatRate = params.vatRate ?? 0;
  const additionalFee = params.additionalFee ?? 0;
  const revenue = soldPrice;
  const ebayFee = revenue * EBAY_FEE_RATE;
  const paymentFee = revenue * PAYMENT_FEE_RATE;
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

export function enrichListingProfit(
  listing: Record<string, unknown>,
  params: ProfitQueryParams = {}
): Record<string, unknown> {
  const sold = Number(listing.sold_price);
  const amazon = Number(listing.amazon_price);
  if (!Number.isFinite(sold) || !Number.isFinite(amazon) || sold <= 0 || amazon <= 0) {
    return listing;
  }
  return { ...listing, ...calculateProductFinderProfit(sold, amazon, params) };
}

/** Bind index for a numeric parameter (Prisma raw queries may send text). */
function sqlNum(idx: number): string {
  return `$${idx}::double precision`;
}

/** SQL fragment: row is profitable given sold + Amazon prices. */
export function netProfitExprSql(vatParamIdx: number, feeParamIdx: number): string {
  const sold = `(NULLIF(payload->>'sold_price', '')::double precision)`;
  const amazon = `(NULLIF(payload->>'amazon_price', '')::double precision)`;
  return `(${sold} * ${REVENUE_AFTER_FEES} - ${amazon} * (1 + ${sqlNum(vatParamIdx)}) - ${sqlNum(feeParamIdx)})`;
}

export function profitableWhereSql(
  params: ProfitQueryParams,
  startIdx: number
): { sql: string; params: unknown[] } {
  const sold = `(NULLIF(payload->>'sold_price', '')::double precision)`;
  const amazon = `(NULLIF(payload->>'amazon_price', '')::double precision)`;
  const net = netProfitExprSql(startIdx, startIdx + 1);
  const sql = `(
    ${sold} IS NOT NULL AND ${amazon} IS NOT NULL
    AND ${sold} > 0 AND ${amazon} > 0
    AND ${net} > 0
  )`;
  return { sql, params: [params.vatRate ?? 0, params.additionalFee ?? 0].map(Number) };
}

export function minMarginWhereSql(
  minMargin: number,
  params: ProfitQueryParams,
  startIdx: number
): { sql: string; params: unknown[] } {
  const sold = `(NULLIF(payload->>'sold_price', '')::double precision)`;
  const amazon = `(NULLIF(payload->>'amazon_price', '')::double precision)`;
  const net = netProfitExprSql(startIdx + 1, startIdx + 2);
  const sql = `(
    ${sold} IS NOT NULL AND ${amazon} IS NOT NULL
    AND ${sold} > 0 AND ${amazon} > 0
    AND (${net} / ${sold} * 100) >= ${sqlNum(startIdx)}
  )`;
  return {
    sql,
    params: [Number(minMargin), Number(params.vatRate ?? 0), Number(params.additionalFee ?? 0)],
  };
}

export function effectiveMatchConfidenceSql(): string {
  return `COALESCE(
    CASE
      WHEN NULLIF(payload->>'match_confidence', '')::double precision > 1
      THEN NULLIF(payload->>'match_confidence', '')::double precision / 100
      ELSE NULLIF(payload->>'match_confidence', '')::double precision
    END,
    0
  )`;
}

/** Rows with Amazon ASIN accepted at the default 80% bar (or description match). */
export const ACCEPTED_MATCH_SQL = `(
  payload->>'amazon_asin' IS NOT NULL
  AND (
    payload->>'match_method' = 'description'
    OR ${effectiveMatchConfidenceSql()} >= 0.8
  )
)`;

export function minMatchConfidenceWhereSql(
  minConfidence: number,
  startIdx: number
): { sql: string; params: unknown[] } {
  const conf = effectiveMatchConfidenceSql();
  return {
    sql: `(
      payload->>'amazon_asin' IS NOT NULL
      AND (
        payload->>'match_method' = 'description'
        OR ${conf} >= ${sqlNum(startIdx)}
      )
    )`,
    params: [Number(minConfidence)],
  };
}

export const HAS_PRICE_SQL = `(
  payload->>'amazon_price' IS NOT NULL
  AND NULLIF(payload->>'amazon_price', '') IS NOT NULL
)`;

export const MISSING_PRICE_SQL = `(
  payload->>'amazon_asin' IS NOT NULL
  AND (payload->>'amazon_price' IS NULL OR payload->>'amazon_price' = '')
)`;
