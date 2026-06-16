"use client";

import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Select } from "@/components/ui/Select";
import {
  getStoreSettings,
  saveAllStoresSettingsKey,
  saveStoreSettingsKey,
} from "@/lib/api";
import { calcSuggestedEbayPrice } from "@/lib/priceCalc";

type FormValues = {
  enabled: boolean;
  roundTo: "$0.99" | "$0.95" | "$0.49" | "Whole number";
};

const defaults: FormValues = {
  enabled: false,
  roundTo: "$0.99",
};

const roundToMode: Record<FormValues["roundTo"], string> = {
  "$0.99": "NEAREST_0_99",
  "$0.95": "NEAREST_0_95",
  "$0.49": "NEAREST_0_49",
  "Whole number": "NEAREST_INTEGER",
};

export function RoundPrices({ storeId }: { storeId: string }) {
  const { register, reset, watch, handleSubmit } = useForm<FormValues>({
    defaultValues: defaults,
  });

  const enabled = watch("enabled");
  const roundTo = watch("roundTo");

  useEffect(() => {
    getStoreSettings(storeId)
      .then((r) => {
        const saved = r.settings?.roundPrices;
        if (saved) {
          const rt =
            saved.roundTo ||
            (saved.mode === "NEAREST_0_95"
              ? "$0.95"
              : saved.mode === "NEAREST_0_49"
                ? "$0.49"
                : saved.mode === "NEAREST_INTEGER"
                  ? "Whole number"
                  : "$0.99");
          reset({ enabled: !!saved.enabled, roundTo: rt });
        }
      })
      .catch(() => undefined);
  }, [storeId, reset]);

  const preview = useMemo(() => {
    const sample = 24.73;
    const { suggested } = calcSuggestedEbayPrice({
      amazonPrice: sample,
      settings: {
        roundPrices: {
          enabled,
          roundTo,
          mode: roundToMode[roundTo],
        },
      },
    });
    return { sample, rounded: suggested };
  }, [enabled, roundTo]);

  const save = async (forAll: boolean, data: FormValues) => {
    const payload = {
      enabled: data.enabled,
      roundTo: data.roundTo,
      mode: roundToMode[data.roundTo],
    };
    try {
      if (forAll) await saveAllStoresSettingsKey("roundPrices", payload);
      else await saveStoreSettingsKey(storeId, "roundPrices", payload);
      toast.success("Settings saved ✓");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <form className="space-y-4" onSubmit={handleSubmit((d) => save(false, d))}>
          <Checkbox label="Enable round prices" {...register("enabled")} />
          <div className="max-w-[320px]">
            <div className="text-xs text-text-muted mb-1">Round to nearest</div>
            <Select {...register("roundTo")}>
              <option value="$0.99">$0.99</option>
              <option value="$0.95">$0.95</option>
              <option value="$0.49">$0.49</option>
              <option value="Whole number">Whole number</option>
            </Select>
          </div>
          <p className="text-sm text-text-muted">
            e.g. ${preview.sample} → ${preview.rounded}
          </p>
          <div className="pt-2 flex gap-2">
            <Button type="submit">Save</Button>
            <Button type="button" variant="secondary" onClick={handleSubmit((d) => save(true, d))}>
              Save for all stores
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
