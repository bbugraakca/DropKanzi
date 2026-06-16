"use client";

import { LocationSettings } from "@/components/repricing/LocationSettings";
import { SettingsPageIntro } from "@/components/settings/SettingsPageIntro";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { getStoreSettingMeta } from "@/lib/storeSettingsMeta";

const meta = getStoreSettingMeta("location-settings")!;

export default function Page({ params }: { params: { storeId: string } }) {
  return (
    <SettingsPageShell
      storeId={params.storeId}
      title="Location Settings"
      breadcrumb="Store Settings / Location Settings"
    >
      <SettingsPageIntro meta={meta} />
      <LocationSettings storeId={params.storeId} />
    </SettingsPageShell>
  );
}
