"use client";

import { RepricingSettings } from "@/components/repricing/RepricingSettings";
import { SettingsPageIntro } from "@/components/settings/SettingsPageIntro";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { getStoreSettingMeta } from "@/lib/storeSettingsMeta";

const meta = getStoreSettingMeta("repricing-settings")!;

export default function Page({ params }: { params: { storeId: string } }) {
  return (
    <SettingsPageShell
      storeId={params.storeId}
      title="Repricing Settings"
      breadcrumb="Store Settings / Repricing Settings"
    >
      <SettingsPageIntro meta={meta} />
      <RepricingSettings storeId={params.storeId} />
    </SettingsPageShell>
  );
}
