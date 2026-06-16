"use client";

import { useEffect } from "react";
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

const DEFAULT_MARKETS =
  "amazon_us,amazon_ca,amazon_uk,amazon_fr,amazon_de,amazon_it,amazon_es,walmart_us,homedepot_us";

type FormValues = {
  enabled: boolean;
  replaceTrackingCarrier: boolean;
  carrierMode: "only_amazon" | "all_trackers";
  instantReplace: boolean;
  supportedSourceMarkets: string;
};

const defaults: FormValues = {
  enabled: false,
  replaceTrackingCarrier: true,
  carrierMode: "only_amazon",
  instantReplace: false,
  supportedSourceMarkets: DEFAULT_MARKETS,
};

export function TrackingSettings({ storeId }: { storeId: string }) {
  const { register, reset, watch, handleSubmit } = useForm<FormValues>({
    defaultValues: defaults,
  });
  const enabled = watch("enabled");

  useEffect(() => {
    getStoreSettings(storeId)
      .then((r) => {
        const saved = r.settings?.trackingSettings;
        if (saved) {
          reset({
            ...defaults,
            enabled: !!saved.enabled,
            replaceTrackingCarrier: saved.replaceTrackingCarrier !== false,
            carrierMode:
              saved.carrierMode === "all_trackers" || saved.allTrackers
                ? "all_trackers"
                : "only_amazon",
            instantReplace: !!saved.instantReplace,
            supportedSourceMarkets:
              saved.supportedSourceMarkets || DEFAULT_MARKETS,
          });
        }
      })
      .catch(() => undefined);
  }, [storeId, reset]);

  const save = async (forAll: boolean, data: FormValues) => {
    const payload = {
      enabled: data.enabled,
      replaceTrackingCarrier: data.replaceTrackingCarrier,
      onlyAmazonsCarrier: data.carrierMode === "only_amazon",
      allTrackers: data.carrierMode === "all_trackers",
      carrierMode: data.carrierMode,
      instantReplace: data.instantReplace,
      supportedSourceMarkets: data.supportedSourceMarkets
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .join(","),
    };
    try {
      if (forAll) await saveAllStoresSettingsKey("trackingSettings", payload);
      else await saveStoreSettingsKey(storeId, "trackingSettings", payload);
      toast.success("Settings saved ✓");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <form className="space-y-4" onSubmit={handleSubmit((d) => save(false, d))}>
          <Checkbox label="Enable" {...register("enabled")} />

          {enabled ? (
            <>
              <Checkbox
                label="Replace Tracking Carrier"
                {...register("replaceTrackingCarrier")}
              />
              <div className="max-w-[360px]">
                <div className="text-xs text-text-muted mb-1">Carrier source</div>
                <Select {...register("carrierMode")}>
                  <option value="only_amazon">Only Amazon&apos;s Carrier</option>
                  <option value="all_trackers">All Trackers</option>
                </Select>
              </div>
              <Checkbox label="Instant Replace" {...register("instantReplace")} />
              <div>
                <div className="text-xs text-text-muted mb-1">Supported Source Markets</div>
                <Input
                  {...register("supportedSourceMarkets")}
                  placeholder={DEFAULT_MARKETS}
                />
                <p className="text-xs text-text-muted mt-1">
                  Comma-separated market codes (e.g. amazon_us, walmart_us).
                </p>
              </div>
            </>
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
