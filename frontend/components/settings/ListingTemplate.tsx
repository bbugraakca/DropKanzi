"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import {
  getStoreSettings,
  saveAllStoresSettingsKey,
  saveStoreSettingsKey,
} from "@/lib/api";

type FormValues = {
  categoryId: string;
  titlePrefix: string;
  titleSuffix: string;
  descriptionHtml: string;
  conditionNote: string;
};

const defaults: FormValues = {
  categoryId: "",
  titlePrefix: "",
  titleSuffix: "",
  descriptionHtml:
    "<p>{{title}}</p><p>Fast shipping. Questions welcome.</p><p>{{bullet_points}}</p>",
  conditionNote: "Brand new item in original packaging.",
};

export function ListingTemplate({ storeId }: { storeId: string }) {
  const { register, reset, handleSubmit } = useForm<FormValues>({ defaultValues: defaults });

  useEffect(() => {
    getStoreSettings(storeId)
      .then((r) => {
        const saved = r.settings?.listingTemplate || r.settings?.listingDefaults;
        if (saved) {
          reset({
            ...defaults,
            categoryId: String(saved.categoryId || ""),
            titlePrefix: String(saved.titlePrefix || ""),
            titleSuffix: String(saved.titleSuffix || ""),
            descriptionHtml: String(
              saved.descriptionHtml || saved.description || defaults.descriptionHtml
            ),
            conditionNote: String(saved.conditionNote || ""),
          });
        }
      })
      .catch(() => undefined);
  }, [storeId, reset]);

  const save = async (forAll: boolean, data: FormValues) => {
    const payload = {
      ...data,
      categoryId: data.categoryId.trim() || undefined,
    };
    try {
      if (forAll) await saveAllStoresSettingsKey("listingTemplate", payload);
      else await saveStoreSettingsKey(storeId, "listingTemplate", payload);
      if (!forAll) {
        await saveStoreSettingsKey(storeId, "listingDefaults", {
          categoryId: payload.categoryId || undefined,
        }).catch(() => undefined);
      }
      toast.success("Listing template saved ✓");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <form className="space-y-4" onSubmit={handleSubmit((d) => save(false, d))}>
          <p className="text-sm text-text-muted">
            Template used when publishing to eBay. Placeholders:{" "}
            <span className="font-mono text-text-primary">
              {"{{title}} {{description}} {{bullet_points}} {{asin}}"}
            </span>
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-text-muted mb-1">eBay category ID</div>
              <Input {...register("categoryId")} placeholder="58058" />
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">Title prefix</div>
              <Input {...register("titlePrefix")} placeholder="NEW " />
            </div>
            <div className="md:col-span-2">
              <div className="text-xs text-text-muted mb-1">Title suffix</div>
              <Input {...register("titleSuffix")} placeholder=" - Free Ship" />
            </div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">Description HTML template</div>
            <textarea
              {...register("descriptionHtml")}
              className="w-full min-h-[160px] rounded-lg border border-border bg-surface px-3 py-2 text-sm font-mono text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/15"
            />
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">Condition note</div>
            <Input {...register("conditionNote")} />
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
