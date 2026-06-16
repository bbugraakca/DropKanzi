"use client";

import { VatDetails } from "@/components/repricing/VatDetails";
import { SettingsPageIntro } from "@/components/settings/SettingsPageIntro";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { getStoreSettingMeta } from "@/lib/storeSettingsMeta";

const meta = getStoreSettingMeta("vat-details")!;

export default function Page({ params }: { params: { storeId: string } }) {
  return (
    <SettingsPageShell
      storeId={params.storeId}
      title="VAT Details"
      breadcrumb="Store Settings / VAT Details"
    >
      <SettingsPageIntro meta={meta} />
      <VatDetails storeId={params.storeId} />
    </SettingsPageShell>
  );
}
