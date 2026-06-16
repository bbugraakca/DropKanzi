"use client";

import { TrackingSettings } from "@/components/settings/TrackingSettings";
import { SettingsPageIntro } from "@/components/settings/SettingsPageIntro";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { getStoreSettingMeta } from "@/lib/storeSettingsMeta";

const meta = getStoreSettingMeta("tracking-settings")!;

export default function Page({ params }: { params: { storeId: string } }) {
  return (
    <SettingsPageShell
      storeId={params.storeId}
      title="Tracking Settings"
      breadcrumb="Store Settings / Tracking Settings"
    >
      <SettingsPageIntro meta={meta} />
      <TrackingSettings storeId={params.storeId} />
    </SettingsPageShell>
  );
}
