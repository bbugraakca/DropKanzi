"use client";

import { SalesCountSettings } from "@/components/settings/SalesCountSettings";
import { SettingsPageIntro } from "@/components/settings/SettingsPageIntro";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { getStoreSettingMeta } from "@/lib/storeSettingsMeta";

const meta = getStoreSettingMeta("sales-count")!;

export default function Page({ params }: { params: { storeId: string } }) {
  return (
    <SettingsPageShell
      storeId={params.storeId}
      title="Sales Count"
      breadcrumb="Store Settings / Sales Count"
    >
      <SettingsPageIntro meta={meta} />
      <SalesCountSettings storeId={params.storeId} />
    </SettingsPageShell>
  );
}
