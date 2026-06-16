"use client";

import { RoundPrices } from "@/components/repricing/RoundPrices";
import { SettingsPageIntro } from "@/components/settings/SettingsPageIntro";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { getStoreSettingMeta } from "@/lib/storeSettingsMeta";

const meta = getStoreSettingMeta("round-prices")!;

export default function Page({ params }: { params: { storeId: string } }) {
  return (
    <SettingsPageShell
      storeId={params.storeId}
      title="Round Prices"
      breadcrumb="Store Settings / Round Prices"
    >
      <SettingsPageIntro meta={meta} />
      <RoundPrices storeId={params.storeId} />
    </SettingsPageShell>
  );
}
