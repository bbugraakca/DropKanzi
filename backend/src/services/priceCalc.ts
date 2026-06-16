/** Same pricing engine as frontend/lib/priceCalc.ts — keep in sync. */

type Settings = Record<string, unknown> | null | undefined;

export type RangeRow = { from: number; to: number; profit: number; fixProfit: number };

export type PriceBreakdown = {
  sourcePrice: number;
  marginPercent: number;
  marginFixed: number;
  addonsMargin: number;
  minProfit: number;
  profit: number;
  easyncAoFee: number;
  ebayFeePercent: number;
  paypalFeePercent: number;
  fixedPaypalFee: number;
  fixedFee: number;
  priceBeforeVat: number;
  vatPercent: number;
  vatAmount: number;
  priceBeforeRounding: number;
  priceAfterRounding: number;
};

function roundMoney(x: number) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function findRangeRule(amazonPrice: number, ranges: RangeRow[]): RangeRow | null {
  if (!ranges?.length) return null;
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  return (
    sorted.find((r) => amazonPrice >= r.from && amazonPrice < r.to) ||
    sorted[sorted.length - 1] ||
    null
  );
}

function applyRoundPrices(price: number, roundPrices: Record<string, unknown> | undefined): number {
  if (!roundPrices?.enabled) return roundMoney(price);

  const roundTo = roundPrices.roundTo;
  if (roundTo === "$0.95" || roundPrices.mode === "NEAREST_0_95") {
    return roundMoney(Math.floor(price) + 0.95);
  }
  if (roundTo === "$0.49") return roundMoney(Math.floor(price) + 0.49);
  if (roundTo === "Whole number" || roundPrices.mode === "NEAREST_INTEGER") {
    return Math.round(price);
  }

  const mode = String(roundPrices.mode || "NEAREST_0_99");
  if (mode === "NEAREST_INTEGER") return Math.round(price);
  if (mode === "NEAREST_0_95") return roundMoney(Math.floor(price) + 0.95);
  if (mode === "NEAREST_0_99") return roundMoney(Math.floor(price) + 0.99);
  return roundMoney(Math.floor(price) + 0.99);
}

function readFeeSettings(settings: Settings) {
  const additionalFee = (settings?.additionalFee || {}) as Record<string, unknown>;
  const repricing = (settings?.repricingSettings || {}) as Record<string, unknown>;

  const legacyAmount = Number(additionalFee.amount ?? 0);
  const feeType = additionalFee.feeType as string | undefined;

  let fixedFee = Number(additionalFee.fixedFee ?? additionalFee.extraFeeFixed ?? 0);
  let ebayFeePercent = Number(
    additionalFee.ebayFeePercent ??
      additionalFee.percentageFee ??
      additionalFee.extraFeePercent ??
      13
  );
  let paypalFeePercent = Number(additionalFee.paypalFeePercent ?? 0);
  let fixedPaypalFee = Number(additionalFee.fixedPaypalFee ?? 0);

  if (feeType === "Fixed Amount" && legacyAmount > 0 && fixedFee === 0) {
    fixedFee = legacyAmount;
  }
  if (feeType === "Percentage" && legacyAmount > 0 && ebayFeePercent === 13) {
    ebayFeePercent = legacyAmount;
  }

  return {
    fixedFee,
    ebayFeePercent,
    paypalFeePercent,
    fixedPaypalFee,
    easyncAoFee: Number(repricing.easyncAoFee ?? additionalFee.easyncAoFee ?? 0),
    minProfit: Number(repricing.minProfit ?? 0),
    addonsMargin: Number(repricing.addonsMargin ?? 0),
  };
}

export function calcSuggestedEbayPrice(input: {
  amazonPrice: number;
  settings: Settings;
}): { suggested: number; breakdown: PriceBreakdown } {
  const sourcePrice = Number(input.amazonPrice || 0);
  const empty: PriceBreakdown = {
    sourcePrice: 0,
    marginPercent: 0,
    marginFixed: 0,
    addonsMargin: 0,
    minProfit: 0,
    profit: 0,
    easyncAoFee: 0,
    ebayFeePercent: 0,
    paypalFeePercent: 0,
    fixedPaypalFee: 0,
    fixedFee: 0,
    priceBeforeVat: 0,
    vatPercent: 0,
    vatAmount: 0,
    priceBeforeRounding: 0,
    priceAfterRounding: 0,
  };

  if (!sourcePrice || sourcePrice <= 0) {
    return { suggested: 0, breakdown: empty };
  }

  const settings = input.settings || {};
  const rangeCfg = settings.rangeRepricing as { ranges?: RangeRow[] } | undefined;
  const ranges = rangeCfg?.ranges || [];
  const rule = findRangeRule(sourcePrice, ranges);

  const marginPercent = rule ? Number(rule.profit) : 18;
  const marginFixed = rule ? Number(rule.fixProfit) : 0;
  const fees = readFeeSettings(settings);

  let profit = sourcePrice * marginPercent * 0.01 + marginFixed + fees.addonsMargin;
  if (profit < fees.minProfit) profit = fees.minProfit;

  const numerator = sourcePrice + profit + fees.easyncAoFee;
  const feePctSum = fees.ebayFeePercent + fees.paypalFeePercent;
  const divisor = 1 - feePctSum * 0.01;

  const priceBeforeVat =
    divisor <= 0.01
      ? numerator + fees.fixedPaypalFee + fees.fixedFee
      : numerator / divisor + fees.fixedPaypalFee + fees.fixedFee;

  const vatCfg = (settings.vatDetails || settings.vat || {}) as Record<string, unknown>;
  const vatEnabled = !!(vatCfg.vatEnabled ?? vatCfg.enabled);
  const vatPercent = vatEnabled ? Number(vatCfg.vatRatePercent ?? vatCfg.vatPercent ?? 0) : 0;
  const vatAmount = vatEnabled ? priceBeforeVat * (vatPercent * 0.01) : 0;

  const priceBeforeRounding = priceBeforeVat + vatAmount;
  const priceAfterRounding = applyRoundPrices(
    priceBeforeRounding,
    settings.roundPrices as Record<string, unknown> | undefined
  );

  const breakdown: PriceBreakdown = {
    sourcePrice: roundMoney(sourcePrice),
    marginPercent,
    marginFixed: roundMoney(marginFixed),
    addonsMargin: roundMoney(fees.addonsMargin),
    minProfit: roundMoney(fees.minProfit),
    profit: roundMoney(profit),
    easyncAoFee: roundMoney(fees.easyncAoFee),
    ebayFeePercent: fees.ebayFeePercent,
    paypalFeePercent: fees.paypalFeePercent,
    fixedPaypalFee: roundMoney(fees.fixedPaypalFee),
    fixedFee: roundMoney(fees.fixedFee),
    priceBeforeVat: roundMoney(priceBeforeVat),
    vatPercent,
    vatAmount: roundMoney(vatAmount),
    priceBeforeRounding: roundMoney(priceBeforeRounding),
    priceAfterRounding,
  };

  return { suggested: priceAfterRounding, breakdown };
}
