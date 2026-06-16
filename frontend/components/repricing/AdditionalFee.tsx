"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { PriceBreakdownCard } from "@/components/pricing/PriceBreakdownCard";
import {
  getStoreSettings,
  saveAllStoresSettingsKey,
  saveStoreSettingsKey,
} from "@/lib/api";
import { calcSuggestedEbayPrice } from "@/lib/priceCalc";

type FormValues = {
  fixedFee: number;
  ebayFeePercent: number;
  paypalFeePercent: number;
  fixedPaypalFee: number;
  easyncAoFee: number;
  applyTo: "All Products" | "Specific Categories";
};

const defaults: FormValues = {
  fixedFee: 0.4,
  ebayFeePercent: 13,
  paypalFeePercent: 0,
  fixedPaypalFee: 0,
  easyncAoFee: 0,
  applyTo: "All Products",
};

function loadFees(saved: Record<string, unknown>): FormValues {
  const feeType = saved.feeType as string | undefined;
  const legacyAmount = Number(saved.amount ?? 0);

  let fixedFee = Number(saved.fixedFee ?? saved.extraFeeFixed ?? defaults.fixedFee);
  let ebayFeePercent = Number(
    saved.ebayFeePercent ?? saved.percentageFee ?? saved.extraFeePercent ?? defaults.ebayFeePercent
  );
  const paypalFeePercent = Number(saved.paypalFeePercent ?? defaults.paypalFeePercent);
  const fixedPaypalFee = Number(saved.fixedPaypalFee ?? defaults.fixedPaypalFee);
  const easyncAoFee = Number(saved.easyncAoFee ?? defaults.easyncAoFee);

  if (feeType === "Fixed Amount" && legacyAmount > 0 && fixedFee === defaults.fixedFee) {
    fixedFee = legacyAmount;
  }
  if (feeType === "Percentage" && legacyAmount > 0) {
    ebayFeePercent = legacyAmount;
  }

  return {
    fixedFee,
    ebayFeePercent,
    paypalFeePercent,
    fixedPaypalFee,
    easyncAoFee,
    applyTo: (saved.applyTo as FormValues["applyTo"]) || "All Products",
  };
}

export function AdditionalFee({ storeId }: { storeId: string }) {
  const { register, reset, watch, handleSubmit } = useForm<FormValues>({ defaultValues: defaults });
  const values = watch();

  const [previewSettings, setPreviewSettings] = useState<Record<string, unknown>>({});

  useEffect(() => {
    getStoreSettings(storeId)
      .then((r) => {
        const all = r.settings || {};
        setPreviewSettings(all);
        const saved = all.additionalFee;
        if (saved && typeof saved === "object") {
          reset({ ...defaults, ...loadFees(saved as Record<string, unknown>) });
        }
      })
      .catch(() => undefined);
  }, [storeId, reset]);

  const preview = calcSuggestedEbayPrice({
    amazonPrice: 10,
    settings: {
      ...previewSettings,
      additionalFee: {
        ...(previewSettings.additionalFee as object),
        fixedFee: values.fixedFee,
        ebayFeePercent: values.ebayFeePercent,
        paypalFeePercent: values.paypalFeePercent,
        fixedPaypalFee: values.fixedPaypalFee,
        easyncAoFee: values.easyncAoFee,
      },
    },
  });

  const save = async (forAll: boolean, data: FormValues) => {
    const payload = {
      fixedFee: Number(data.fixedFee) || 0,
      ebayFeePercent: Number(data.ebayFeePercent) || 0,
      paypalFeePercent: Number(data.paypalFeePercent) || 0,
      fixedPaypalFee: Number(data.fixedPaypalFee) || 0,
      easyncAoFee: Number(data.easyncAoFee) || 0,
      percentageFee: Number(data.ebayFeePercent) || 0,
      extraFeeFixed: Number(data.fixedFee) || 0,
      applyTo: data.applyTo,
      enabled: true,
    };
    try {
      if (forAll) await saveAllStoresSettingsKey("additionalFee", payload);
      else await saveStoreSettingsKey(storeId, "additionalFee", payload);
      setPreviewSettings((p) => ({ ...p, additionalFee: payload }));
      toast.success("Settings saved ✓");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <form className="space-y-4" onSubmit={handleSubmit((d) => save(false, d))}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-text-muted mb-1">Fixed Fee</div>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-muted">
                  $
                </span>
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  className="pl-7"
                  {...register("fixedFee", { valueAsNumber: true })}
                />
              </div>
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">eBay fee %</div>
              <div className="relative">
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  max={99}
                  className="pr-7"
                  {...register("ebayFeePercent", { valueAsNumber: true })}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-text-muted">
                  %
                </span>
              </div>
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">PayPal fee %</div>
              <div className="relative">
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  max={99}
                  className="pr-7"
                  {...register("paypalFeePercent", { valueAsNumber: true })}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-text-muted">
                  %
                </span>
              </div>
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">Fixed PayPal fee</div>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-muted">
                  $
                </span>
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  className="pl-7"
                  {...register("fixedPaypalFee", { valueAsNumber: true })}
                />
              </div>
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">Easync AO fee</div>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-muted">
                  $
                </span>
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  className="pl-7"
                  {...register("easyncAoFee", { valueAsNumber: true })}
                />
              </div>
            </div>
          </div>

          <div className="max-w-[320px]">
            <div className="text-xs text-text-muted mb-1">Apply to</div>
            <Select {...register("applyTo")}>
              <option value="All Products">All Products</option>
              <option value="Specific Categories">Specific Categories</option>
            </Select>
          </div>

          <p className="text-sm text-text-muted">
            Price = (source + profit + AO fee) ÷ (1 − (eBay% + PayPal%) × 0.01) + fixed PayPal + fixed
            fee. Margin % and fixed profit come from Range Repricing.
          </p>

          <div className="pt-2 flex gap-2">
            <Button type="submit">Save</Button>
            <Button type="button" variant="secondary" onClick={handleSubmit((d) => save(true, d))}>
              Save for all stores
            </Button>
          </div>
        </form>
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
