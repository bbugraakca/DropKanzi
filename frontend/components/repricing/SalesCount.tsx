"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import {
  getStoreSettings,
  saveAllStoresSettingsKey,
  saveStoreSettingsKey,
} from "@/lib/api";

type FormValues = {
  enableRepricing: boolean;
  quantityInStock: number;
  shippingTime: number;
  checkDuplicates: boolean;
  walmartShipping: boolean;
  allowOOS: boolean;
  applyDiscounts: boolean;
  autoDelistCold: boolean;
  autoDelistFailed: boolean;
};

const defaults: FormValues = {
  enableRepricing: false,
  quantityInStock: 1,
  shippingTime: 2,
  checkDuplicates: true,
  walmartShipping: false,
  allowOOS: true,
  applyDiscounts: false,
  autoDelistCold: false,
  autoDelistFailed: false,
};

export function SalesCount({ storeId }: { storeId: string }) {
  const { register, reset, handleSubmit } = useForm<FormValues>({ defaultValues: defaults });

  useEffect(() => {
    getStoreSettings(storeId)
      .then((r) => {
        const saved = r.settings?.salesCount;
        if (saved) reset({ ...defaults, ...saved });
      })
      .catch(() => undefined);
  }, [storeId, reset]);

  const save = async (forAll: boolean, data: FormValues) => {
    try {
      if (forAll) await saveAllStoresSettingsKey("salesCount", data);
      else await saveStoreSettingsKey(storeId, "salesCount", data);
      toast.success("Settings saved ✓");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <div className="space-y-4 max-w-[900px]">
      <Card className="p-5">
        <form className="space-y-4" onSubmit={handleSubmit((d) => save(false, d))}>
          <Checkbox label="Enable repricing" {...register("enableRepricing")} />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-text-muted mb-1">Quantity in stock (eBay)</div>
              <Input
                type="number"
                {...register("quantityInStock", { valueAsNumber: true })}
              />
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">Shipping time (days)</div>
              <Input type="number" {...register("shippingTime", { valueAsNumber: true })} />
            </div>
          </div>

          <div className="space-y-2">
            <Checkbox
              label="Enable check duplicates across all stores"
              {...register("checkDuplicates")}
            />
            <Checkbox
              label="Add $5.99 shipping to orders under $35 (Walmart only)"
              {...register("walmartShipping")}
            />
            <Checkbox label="Allow OOS listings" {...register("allowOOS")} />
            <Checkbox label="Apply seller discounts" {...register("applyDiscounts")} />
            <Checkbox label="Auto-delist cold products" {...register("autoDelistCold")} />
            <Checkbox label="Auto-delist failed listings" {...register("autoDelistFailed")} />
          </div>

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
