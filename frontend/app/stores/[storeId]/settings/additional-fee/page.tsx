"use client";

import { AdditionalFee } from "@/components/repricing/AdditionalFee";
import { SettingsPageIntro } from "@/components/settings/SettingsPageIntro";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { getStoreSettingMeta } from "@/lib/storeSettingsMeta";

const meta = getStoreSettingMeta("additional-fee")!;

export default function Page({ params }: { params: { storeId: string } }) {
  return (
    <SettingsPageShell
      storeId={params.storeId}
      title="Additional Fee"
      breadcrumb="Store Settings / Additional Fee"
    >
      <SettingsPageIntro meta={meta} />
      <AdditionalFee storeId={params.storeId} />
    </SettingsPageShell>
  );
}
