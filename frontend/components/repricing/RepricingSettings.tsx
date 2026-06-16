"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import {
  applyRepricingToAllListings,
  getStoreSettings,
  saveAllStoresSettingsKey,
  saveStoreSettingsKey,
} from "@/lib/api";
import { useAppStore } from "@/lib/store/appStore";
import { cn } from "@/lib/utils";

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
  minProfit: number;
  addonsMargin: number;
};

const defaults: FormValues = {
  enableRepricing: false,
  quantityInStock: 2,
  shippingTime: 6,
  checkDuplicates: true,
  walmartShipping: false,
  allowOOS: true,
  applyDiscounts: false,
  autoDelistCold: false,
  autoDelistFailed: false,
  minProfit: 0,
  addonsMargin: 0,
};

export function RepricingSettings({ storeId }: { storeId: string }) {
  const bumpListingsVersion = useAppStore((s) => s.bumpListingsVersion);
  const [applying, setApplying] = useState(false);
  const { register, reset, handleSubmit, watch } = useForm<FormValues>({
    defaultValues: defaults,
  });
  const enableRepricing = watch("enableRepricing");

  useEffect(() => {
    getStoreSettings(storeId)
      .then((r) => {
        const saved = r.settings?.repricingSettings || r.settings?.salesCount;
        if (saved) reset({ ...defaults, ...saved });
      })
      .catch(() => undefined);
  }, [storeId, reset]);

  const save = async (forAll: boolean, data: FormValues) => {
    try {
      if (forAll) await saveAllStoresSettingsKey("repricingSettings", data);
      else await saveStoreSettingsKey(storeId, "repricingSettings", data);
      toast.success("Settings saved ✓");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  const applyToAllListings = async () => {
    setApplying(true);
    try {
      const result = await applyRepricingToAllListings(storeId);
      bumpListingsVersion();
      toast.success(
        `Applied to ${result.updated} listing${result.updated === 1 ? "" : "s"} · skipped ${result.skipped} · failed ${result.failed}`
      );
      if (result.failed > 0) {
        const first = result.rows.find((r) => r.status === "failed");
        if (first?.message) toast.error(first.message);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Apply failed");
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <form className="space-y-4" onSubmit={handleSubmit((d) => save(false, d))}>
          <div className="flex flex-wrap items-center justify-between gap-3 pb-1 border-b border-border/60">
            <Checkbox label="Enable Repricing" {...register("enableRepricing")} />
            <Button
              type="button"
              variant="secondary"
              disabled={applying}
              onClick={() => void applyToAllListings()}
              title="Recalculate every listing price using current store settings (range, fees, VAT, round)"
            >
              <RefreshCw className={cn("w-4 h-4", applying && "animate-spin")} />
              {applying ? "Applying…" : "Apply to all listings"}
            </Button>
          </div>
          {!enableRepricing ? (
            <p className="text-xs text-text-muted -mt-1">
              Repricing is off for automation, but you can still apply new prices to all
              listings manually with the button above.
            </p>
          ) : null}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-text-muted mb-1">Quantity in stock</div>
              <Input
                type="number"
                {...register("quantityInStock", { valueAsNumber: true })}
              />
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">Shipping Time</div>
              <Input type="number" {...register("shippingTime", { valueAsNumber: true })} />
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">Min profit ($)</div>
              <Input type="number" step="0.01" min={0} {...register("minProfit", { valueAsNumber: true })} />
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">Addons margin ($)</div>
              <Input
                type="number"
                step="0.01"
                min={0}
                {...register("addonsMargin", { valueAsNumber: true })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Checkbox
              label="Enable Check Duplicates Across All Stores"
              {...register("checkDuplicates")}
            />
            <Checkbox
              label="Add $5.99 shipping to orders under $35 (Walmart only)"
              {...register("walmartShipping")}
            />
            <Checkbox label="Allow OOS Listings" {...register("allowOOS")} />
            <Checkbox label="Apply seller discounts" {...register("applyDiscounts")} />
            <Checkbox label="Auto-delist Cold Products" {...register("autoDelistCold")} />
            <Checkbox label="Auto-delist Failed Listings" {...register("autoDelistFailed")} />
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
