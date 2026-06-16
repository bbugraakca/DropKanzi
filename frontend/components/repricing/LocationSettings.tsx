"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import {
  getStoreSettings,
  saveAllStoresSettingsKey,
  saveStoreSettingsKey,
} from "@/lib/api";

type FormValues = {
  country: string;
  location: string;
  postalCode: string;
};

const defaults: FormValues = {
  country: "United States",
  location: "Chicago",
  postalCode: "60631",
};

export function LocationSettings({ storeId }: { storeId: string }) {
  const { register, reset, handleSubmit } = useForm<FormValues>({ defaultValues: defaults });

  useEffect(() => {
    getStoreSettings(storeId)
      .then((r) => {
        const saved = r.settings?.locationSettings || r.settings?.location;
        if (saved) reset({ ...defaults, ...saved });
      })
      .catch(() => undefined);
  }, [storeId, reset]);

  const save = async (forAll: boolean, data: FormValues) => {
    try {
      if (forAll) await saveAllStoresSettingsKey("locationSettings", data);
      else await saveStoreSettingsKey(storeId, "locationSettings", data);
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
            Used when listing on eBay for shipping rates and availability.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <div className="text-xs text-text-muted mb-1">Country</div>
              <Select {...register("country")}>
                {[
                  "United States",
                  "United Kingdom",
                  "Germany",
                  "France",
                  "Italy",
                  "Spain",
                  "Canada",
                  "Australia",
                ].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">Location (city)</div>
              <Input {...register("location")} />
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">Postal code</div>
              <Input {...register("postalCode")} />
            </div>
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
