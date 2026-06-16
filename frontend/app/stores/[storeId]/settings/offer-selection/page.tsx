"use client";

import { OfferSelection } from "@/components/repricing/OfferSelection";
import { SettingsPageIntro } from "@/components/settings/SettingsPageIntro";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { getStoreSettingMeta } from "@/lib/storeSettingsMeta";

const meta = getStoreSettingMeta("offer-selection")!;

export default function Page({ params }: { params: { storeId: string } }) {
  return (
    <SettingsPageShell
      storeId={params.storeId}
      title="Offer Selection Settings"
      breadcrumb="Store Settings / Offer Selection"
    >
      <SettingsPageIntro meta={meta} />
      <OfferSelection storeId={params.storeId} />
    </SettingsPageShell>
  );
}
