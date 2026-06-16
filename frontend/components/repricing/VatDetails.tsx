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
  vatEnabled: boolean;
  vatRatePercent: number;
};

const defaults: FormValues = {
  vatEnabled: false,
  vatRatePercent: 7,
};

export function VatDetails({ storeId }: { storeId: string }) {
  const { register, reset, watch, handleSubmit } = useForm<FormValues>({
    defaultValues: defaults,
  });

  const vatEnabled = watch("vatEnabled");

  useEffect(() => {
    getStoreSettings(storeId)
      .then((r) => {
        const saved = r.settings?.vatDetails || r.settings?.vat;
        if (saved) {
          reset({
            vatEnabled: !!(saved.vatEnabled ?? saved.enabled),
            vatRatePercent: Number(saved.vatRatePercent ?? saved.vatPercent ?? 7),
          });
        }
      })
      .catch(() => undefined);
  }, [storeId, reset]);

  const save = async (forAll: boolean, data: FormValues) => {
    const payload = {
      vatEnabled: data.vatEnabled,
      vatRatePercent: data.vatRatePercent,
      enabled: data.vatEnabled,
      vatPercent: data.vatRatePercent,
    };
    try {
      if (forAll) await saveAllStoresSettingsKey("vatDetails", payload);
      else await saveStoreSettingsKey(storeId, "vatDetails", payload);
      toast.success("Settings saved ✓");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <form className="space-y-4" onSubmit={handleSubmit((d) => save(false, d))}>
          <Checkbox label="Enable VAT" {...register("vatEnabled")} />
          {vatEnabled ? (
            <div className="max-w-[200px]">
              <div className="text-xs text-text-muted mb-1">VAT percent (%)</div>
              <Input
                type="number"
                step="0.01"
                {...register("vatRatePercent", { valueAsNumber: true })}
              />
            </div>
          ) : null}
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
