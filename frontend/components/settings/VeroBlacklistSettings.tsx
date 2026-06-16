"use client";

import { useEffect } from "react";
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

type FormValues = {
  enabled: boolean;
  highlightConflicts: boolean;
  validateDescription: boolean;
  shop: string;
  brandBlacklist: string;
  keywordBlacklist: string;
  asinBlacklist: string;
};

const defaults: FormValues = {
  enabled: true,
  highlightConflicts: true,
  validateDescription: true,
  shop: "ebay_us",
  brandBlacklist: "",
  keywordBlacklist: "",
  asinBlacklist: "",
};

export function VeroBlacklistSettings({ storeId }: { storeId: string }) {
  const { register, reset, handleSubmit } = useForm<FormValues>({ defaultValues: defaults });

  useEffect(() => {
    getStoreSettings(storeId)
      .then((r) => {
        const saved = r.settings?.veroBlacklist as Partial<FormValues> | undefined;
        if (saved) reset({ ...defaults, ...saved });
      })
      .catch(() => undefined);
  }, [storeId, reset]);

  const save = async (forAll: boolean, data: FormValues) => {
    try {
      if (forAll) await saveAllStoresSettingsKey("veroBlacklist", data);
      else await saveStoreSettingsKey(storeId, "veroBlacklist", data);
      toast.success("VeRO blacklist saved ✓");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <Card className="p-6">
      <form className="space-y-5" onSubmit={handleSubmit((d) => save(false, d))}>
        <div className="flex flex-wrap gap-4">
          <Checkbox label="Enable" {...register("enabled")} />
          <Checkbox
            label="Enable conflicts highlighting"
            {...register("highlightConflicts")}
          />
          <Checkbox
            label="Enable description validation"
            {...register("validateDescription")}
          />
        </div>

        <div className="max-w-[240px]">
          <div className="text-xs text-text-muted mb-1">Shop</div>
          <Select {...register("shop")}>
            <option value="ebay_us">eBay US</option>
            <option value="ebay_uk">eBay UK</option>
            <option value="ebay_de">eBay DE</option>
          </Select>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div>
            <div className="text-xs font-medium text-text-primary mb-1">Brand blacklist</div>
            <p className="text-[11px] text-text-muted mb-2">
              Exact Amazon brand only (e.g. Nike). Placeholders like NA are ignored.
            </p>
            <textarea
              {...register("brandBlacklist")}
              rows={14}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs font-mono resize-y focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="Finish&#10;Nike&#10;…"
            />
          </div>
          <div>
            <div className="text-xs font-medium text-text-primary mb-1">Keyword blacklist</div>
            <p className="text-[11px] text-text-muted mb-2">
              Whole word in title / bullets / description (min 3 chars)
            </p>
            <textarea
              {...register("keywordBlacklist")}
              rows={14}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs font-mono resize-y focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="finish&#10;Pepper Spray&#10;…"
            />
          </div>
          <div>
            <div className="text-xs font-medium text-text-primary mb-1">
              ASIN / product ID blacklist
            </div>
            <p className="text-[11px] text-text-muted mb-2">Exact ASIN match</p>
            <textarea
              {...register("asinBlacklist")}
              rows={14}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs font-mono resize-y focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="B079D7XG7V&#10;…"
            />
          </div>
        </div>

        <p className="text-xs text-text-muted">
          Add Product and Bulk status check these lists automatically. Prime eligibility uses
          Offer Selection (Allow Prime Only / Prime Pantry).
        </p>

        <div className="flex gap-2 pt-1">
          <Button type="submit">Save</Button>
          <Button type="button" variant="secondary" onClick={handleSubmit((d) => save(true, d))}>
            Save for all stores
          </Button>
        </div>
      </form>
    </Card>
  );
}
