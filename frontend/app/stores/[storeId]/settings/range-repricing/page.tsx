"use client";

import { RangeRepricing } from "@/components/repricing/RangeRepricing";
import { SettingsPageIntro } from "@/components/settings/SettingsPageIntro";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { getStoreSettingMeta } from "@/lib/storeSettingsMeta";

const meta = getStoreSettingMeta("range-repricing")!;

export default function Page({ params }: { params: { storeId: string } }) {
  return (
    <SettingsPageShell
      storeId={params.storeId}
      title="Range Repricing"
      breadcrumb="Store Settings / Range Repricing"
    >
      <SettingsPageIntro meta={meta} />
      <RangeRepricing storeId={params.storeId} />
    </SettingsPageShell>
  );
}
