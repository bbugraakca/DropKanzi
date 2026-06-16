"use client";

import type { PriceBreakdown } from "@/lib/priceCalc";

function fmt(n: number) {
  return `$${n.toFixed(2)}`;
}

function Line({
  label,
  formula,
  result,
}: {
  label: string;
  formula: string;
  result: string;
}) {
  return (
    <div className="py-2 border-b border-border-subtle last:border-0 text-sm">
      <div className="text-xs font-medium text-text-muted mb-1">{label}</div>
      <div className="font-mono text-[13px] text-text-body break-all">{formula}</div>
      <div className="font-mono text-[13px] text-accent font-medium mt-1">= {result}</div>
    </div>
  );
}

export function PriceBreakdownCard({
  b,
  sampleSource,
}: {
  b: PriceBreakdown;
  sampleSource?: number;
}) {
  const src = sampleSource ?? b.sourcePrice;
  if (!src || src <= 0) {
    return (
      <p className="text-sm text-text-muted">Enter a source price to preview the formula.</p>
    );
  }

  const profitFormula = `${fmt(src)} * ${b.marginPercent} * 0.01 + ${b.marginFixed.toFixed(2)} + ${b.addonsMargin.toFixed(2)}`;
  const minClause =
    b.profit < b.minProfit
      ? ` (min profit ${fmt(b.minProfit)})`
      : b.minProfit > 0
        ? ` (min ${fmt(b.minProfit)} OK)`
        : "";

  const numer = src + b.profit + b.easyncAoFee;
  const feeSum = b.ebayFeePercent + b.paypalFeePercent;
  const priceFormula = `(${fmt(src)} + ${fmt(b.profit)} + ${fmt(b.easyncAoFee)}) / (1 - (${b.ebayFeePercent} + ${b.paypalFeePercent}) * 0.01) + ${b.fixedPaypalFee.toFixed(2)} + ${b.fixedFee.toFixed(2)}`;

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-muted/50 p-4 space-y-1">
      <Line
        label="Profit"
        formula={`${profitFormula}${minClause}`}
        result={fmt(b.profit)}
      />
      <Line label="Price (before VAT)" formula={priceFormula} result={fmt(b.priceBeforeVat)} />
      {b.vatPercent > 0 ? (
        <Line
          label="VAT"
          formula={`${fmt(b.priceBeforeVat)} * ${b.vatPercent}%`}
          result={fmt(b.vatAmount)}
        />
      ) : null}
      <Line
        label="Price before rounding"
        formula={
          b.vatPercent > 0
            ? `${fmt(b.priceBeforeVat)} + ${fmt(b.vatAmount)}`
            : fmt(b.priceBeforeRounding)
        }
        result={fmt(b.priceBeforeRounding)}
      />
      <Line
        label="Result after rounding"
        formula="Round prices setting"
        result={fmt(b.priceAfterRounding)}
      />
      <div className="pt-3 mt-2 border-t border-border-subtle text-xs text-text-muted space-y-1">
        <div>
          Source price = <span className="font-mono text-text-primary">{fmt(b.sourcePrice)}</span>
        </div>
        {b.vatPercent > 0 ? (
          <div>
            VAT = <span className="font-mono text-text-primary">{b.vatPercent}%</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
