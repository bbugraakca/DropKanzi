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
  enabled: boolean;
  minSalesLast30Days: number;
  maxSalesLast30Days: number;
};

const defaults: FormValues = {
  enabled: false,
  minSalesLast30Days: 0,
  maxSalesLast30Days: 9999,
};

export function SalesCountSettings({ storeId }: { storeId: string }) {
  const { register, reset, watch, handleSubmit } = useForm<FormValues>({
    defaultValues: defaults,
  });
  const enabled = watch("enabled");

  useEffect(() => {
    getStoreSettings(storeId)
      .then((r) => {
        const saved = r.settings?.salesCount;
        if (saved && typeof saved.minSalesLast30Days === "number") {
          reset({
            enabled: !!saved.enabled,
            minSalesLast30Days: Number(saved.minSalesLast30Days) || 0,
            maxSalesLast30Days: Number(saved.maxSalesLast30Days) || 9999,
          });
        }
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
    <div className="space-y-4">
      <Card className="p-6">
        <form className="space-y-4" onSubmit={handleSubmit((d) => save(false, d))}>
          <p className="text-sm text-text-muted">
            Filter repricing by product sales velocity on the source marketplace.
          </p>
          <Checkbox label="Enable sales count filter" {...register("enabled")} />
          {enabled ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-text-muted mb-1">Min sales (last 30 days)</div>
                <Input
                  type="number"
                  {...register("minSalesLast30Days", { valueAsNumber: true })}
                />
              </div>
              <div>
                <div className="text-xs text-text-muted mb-1">Max sales (last 30 days)</div>
                <Input
                  type="number"
                  {...register("maxSalesLast30Days", { valueAsNumber: true })}
                />
              </div>
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
