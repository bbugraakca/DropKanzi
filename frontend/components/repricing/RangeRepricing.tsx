"use client";

import { useEffect, useState } from "react";
import { Trash2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { PriceBreakdownCard } from "@/components/pricing/PriceBreakdownCard";
import { cn } from "@/lib/utils";
import {
  getStoreSettings,
  saveAllStoresSettingsKey,
  saveStoreSettingsKey,
} from "@/lib/api";
import { calcSuggestedEbayPrice } from "@/lib/priceCalc";

export type RangeRow = {
  from: number;
  to: number;
  profit: number;
  fixProfit: number;
};

const defaultRanges: RangeRow[] = [
  { from: 0, to: 20, profit: 18, fixProfit: 1.6 },
  { from: 20, to: 50, profit: 16, fixProfit: 1 },
  { from: 50, to: 150, profit: 16, fixProfit: 3 },
  { from: 150, to: 300, profit: 23, fixProfit: 4.3 },
  { from: 300, to: 9999, profit: 20, fixProfit: 10 },
];

/** Each row's From = previous row's To (first row keeps its From). */
export function chainRangeRows(rows: RangeRow[]): RangeRow[] {
  if (rows.length === 0) return [];
  return rows.map((row, i) => {
    if (i === 0) return { ...row };
    return { ...row, from: rows[i - 1].to };
  });
}

export function RangeRepricing({ storeId }: { storeId: string }) {
  const [ranges, setRanges] = useState<RangeRow[]>(() =>
    chainRangeRows(defaultRanges)
  );
  const [allSettings, setAllSettings] = useState<Record<string, unknown>>({});

  useEffect(() => {
    getStoreSettings(storeId)
      .then((r) => {
        setAllSettings(r.settings || {});
        const saved = r.settings?.rangeRepricing?.ranges;
        if (Array.isArray(saved) && saved.length > 0) {
          setRanges(chainRangeRows(saved as RangeRow[]));
        }
      })
      .catch(() => undefined);
  }, [storeId]);

  const preview = calcSuggestedEbayPrice({
    amazonPrice: 10,
    settings: { ...allSettings, rangeRepricing: { ranges } },
  });

  const setChainedRanges = (updater: (prev: RangeRow[]) => RangeRow[]) => {
    setRanges((prev) => chainRangeRows(updater(prev)));
  };

  const updateRow = (idx: number, patch: Partial<RangeRow>) => {
    setChainedRanges((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, ...patch } : row))
    );
  };

  const removeRow = (idx: number) => {
    setChainedRanges((prev) =>
      prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)
    );
  };

  const addRow = () => {
    setChainedRanges((prev) => {
      const last = prev[prev.length - 1];
      return [
        ...prev,
        {
          from: last?.to ?? 0,
          to: (last?.to ?? 0) + 50,
          profit: 16,
          fixProfit: 0,
        },
      ];
    });
  };

  const save = async (forAll: boolean) => {
    const chained = chainRangeRows(ranges);
    for (let i = 0; i < chained.length; i++) {
      const r = chained[i];
      if (r.from >= r.to) {
        toast.error(`Row ${i + 1}: From must be less than To`);
        return;
      }
      if (r.profit < 0 || r.profit > 100) {
        toast.error(`Row ${i + 1}: Margin % must be 0–100`);
        return;
      }
    }
    const payload = { ranges: chained };
    try {
      if (forAll) await saveAllStoresSettingsKey("rangeRepricing", payload);
      else await saveStoreSettingsKey(storeId, "rangeRepricing", payload);
      setRanges(chained);
      toast.success("Settings saved ✓");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <p className="text-sm text-text-muted mb-4">
          Margin % and margin fixed ($) per source price range. Each band starts where the
          previous one ends — change <strong>To</strong> and the next row&apos;s{" "}
          <strong>From</strong> updates automatically.
        </p>

        <div className="space-y-0 border border-border rounded-[10px] overflow-hidden">
          <div className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 items-end bg-bg px-3 py-2 label-caps">
            <span>From $</span>
            <span>To $</span>
            <span>Profit %</span>
            <span>Fix profit $</span>
            <span className="w-9" aria-hidden />
          </div>
          {ranges.map((row, idx) => (
            <div
              key={idx}
              className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 items-end border-t border-border px-3 py-2"
            >
              <div>
                <Input
                  type="number"
                  step="0.01"
                  value={row.from}
                  readOnly={idx > 0}
                  title={
                    idx > 0
                      ? `Linked to row ${idx} To ($${ranges[idx - 1]?.to})`
                      : undefined
                  }
                  className={cn(
                    "h-8 rounded-none border-0 border-b border-border bg-transparent px-0 shadow-none focus:border-accent focus:shadow-none",
                    idx > 0 && "text-text-3 cursor-default"
                  )}
                  onChange={(e) => {
                    if (idx === 0) updateRow(idx, { from: Number(e.target.value) });
                  }}
                />
              </div>
              <div>
                <Input
                  type="number"
                  step="0.01"
                  value={row.to}
                  className="h-8 rounded-none border-0 border-b border-border bg-transparent px-0 shadow-none focus:border-accent focus:shadow-none"
                  onChange={(e) => updateRow(idx, { to: Number(e.target.value) })}
                />
              </div>
              <div>
                <Input
                  type="number"
                  step="0.01"
                  value={row.profit}
                  className="h-8 rounded-none border-0 border-b border-border bg-transparent px-0 shadow-none focus:border-accent focus:shadow-none"
                  onChange={(e) => updateRow(idx, { profit: Number(e.target.value) })}
                />
              </div>
              <div>
                <Input
                  type="number"
                  step="0.01"
                  value={row.fixProfit}
                  className="h-8 rounded-none border-0 border-b border-border bg-transparent px-0 shadow-none focus:border-accent focus:shadow-none"
                  onChange={(e) => updateRow(idx, { fixProfit: Number(e.target.value) })}
                />
              </div>
              <button
                type="button"
                className="flex h-8 w-9 items-center justify-center text-text-3 transition-colors duration-150 hover:text-[#D83A3A]"
                onClick={() => removeRow(idx)}
                aria-label="Delete row"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={addRow}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-[7px] border border-dashed border-border py-3 text-[13px] text-text-3 transition-colors duration-100 hover:border-border-2 hover:bg-surface-2"
        >
          <Plus className="h-4 w-4" /> Add Range
        </button>

        <div className="flex justify-end gap-2 pt-4">
          <Button type="button" onClick={() => save(false)}>
            Save
          </Button>
          <Button type="button" variant="secondary" onClick={() => save(true)}>
            Save for all stores
          </Button>
        </div>
      </Card>

      <Card className="p-6">
        <div className="text-sm font-semibold text-text-primary mb-3">
          Preview (source $10.00)
        </div>
        <PriceBreakdownCard b={preview.breakdown} sampleSource={10} />
      </Card>
    </div>
  );
}
