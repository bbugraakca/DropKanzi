"use client";

import { VeroBlacklistSettings } from "@/components/settings/VeroBlacklistSettings";
import { SettingsPageIntro } from "@/components/settings/SettingsPageIntro";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { getStoreSettingMeta } from "@/lib/storeSettingsMeta";

const meta = getStoreSettingMeta("vero-blacklist")!;

export default function Page({ params }: { params: { storeId: string } }) {
  return (
    <SettingsPageShell
      storeId={params.storeId}
      title="VeRO Blacklist Settings"
      breadcrumb="Store Settings / VeRO Blacklist"
    >
      <SettingsPageIntro meta={meta} />
      <VeroBlacklistSettings storeId={params.storeId} />
    </SettingsPageShell>
  );
}
