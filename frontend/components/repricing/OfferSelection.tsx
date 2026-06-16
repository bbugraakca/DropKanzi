"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import {
  getStoreSettings,
  saveAllStoresSettingsKey,
  saveStoreSettingsKey,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type FormValues = {
  shippingMethod: "Free" | "Standard" | "Expedited" | "Overnight";
  maxHandlingDays: number;
  allowFBA: boolean;
  fbaMargin: number;
  allowPrimeOnly: boolean;
  allowPrimePantry: boolean;
  allowMerchantFulfilled: boolean;
  condition: "New" | "Used" | "Refurbished" | "Any";
};

const defaultValues: FormValues = {
  shippingMethod: "Free",
  maxHandlingDays: 2,
  allowFBA: false,
  fbaMargin: 0,
  allowPrimeOnly: true,
  allowPrimePantry: true,
  allowMerchantFulfilled: false,
  condition: "New",
};

export function OfferSelection({ storeId }: { storeId: string }) {
  const [tab, setTab] = useState<"AMAZON" | "WALMART" | "ALIEXPRESS">("AMAZON");
  const { register, watch, reset, handleSubmit } = useForm<FormValues>({
    defaultValues,
  });

  const allowFBA = watch("allowFBA");

  useEffect(() => {
    getStoreSettings(storeId)
      .then((r) => {
        const saved = r.settings?.offerSelection;
        if (saved) reset({ ...defaultValues, ...saved });
      })
      .catch(() => undefined);
  }, [storeId, reset]);

  const save = async (forAll: boolean, data: FormValues) => {
    try {
      if (forAll) {
        await saveAllStoresSettingsKey("offerSelection", data);
      } else {
        await saveStoreSettingsKey(storeId, "offerSelection", data);
      }
      toast.success("Settings saved ✓");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <div className="inline-flex gap-1 p-1 rounded-lg bg-surface-muted border border-border-subtle mb-5">
          {(["AMAZON", "WALMART", "ALIEXPRESS"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                tab === t
                  ? "bg-surface text-accent shadow-card"
                  : "text-text-muted hover:text-text-body"
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {tab !== "AMAZON" ? (
          <div className="text-sm text-text-muted">Coming soon.</div>
        ) : (
          <form className="space-y-4" onSubmit={handleSubmit((d) => save(false, d))}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-text-muted mb-1">Shipping method</div>
                <Select {...register("shippingMethod")}>
                  {["Free", "Standard", "Expedited", "Overnight"].map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <div className="text-xs text-text-muted mb-1">Maximum handling days</div>
                <Input type="number" {...register("maxHandlingDays", { valueAsNumber: true })} />
              </div>
            </div>

            <Checkbox label="Allow third party FBA offers" {...register("allowFBA")} />

            {allowFBA ? (
              <div className="max-w-[320px]">
                <div className="text-xs text-text-muted mb-1">
                  Third party fba offers margin ($)
                </div>
                <Input type="number" step="0.01" {...register("fbaMargin", { valueAsNumber: true })} />
              </div>
            ) : null}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Checkbox label="Allow 'Prime Only' offers" {...register("allowPrimeOnly")} />
              <Checkbox label="Allow Prime Pantry" {...register("allowPrimePantry")} />
              <Checkbox
                label="Allow third party merchant-fulfilled offers (not recommended)"
                {...register("allowMerchantFulfilled")}
              />
            </div>

            <div className="max-w-[320px]">
              <div className="text-xs text-text-muted mb-1">Condition Settings</div>
              <Select {...register("condition")}>
                {["New", "Used", "Refurbished", "Any"].map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            </div>

            <div className="pt-2 flex gap-2">
              <Button type="submit">Save</Button>
              <Button
                type="button"
                variant="secondary"
                onClick={handleSubmit((d) => save(true, d))}
              >
                Save for all stores
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}

