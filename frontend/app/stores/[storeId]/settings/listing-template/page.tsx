"use client";

import { ListingTemplate } from "@/components/settings/ListingTemplate";
import { SettingsPageIntro } from "@/components/settings/SettingsPageIntro";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { getStoreSettingMeta } from "@/lib/storeSettingsMeta";

const meta = getStoreSettingMeta("listing-template")!;

export default function Page({ params }: { params: { storeId: string } }) {
  return (
    <SettingsPageShell
      storeId={params.storeId}
      title="eBay Listing Template"
      breadcrumb="Store Settings / Listing Template"
    >
      <SettingsPageIntro meta={meta} />
      <ListingTemplate storeId={params.storeId} />
    </SettingsPageShell>
  );
}
