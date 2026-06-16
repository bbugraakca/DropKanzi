"use client";

import Link from "next/link";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { SettingsHubAccordion } from "@/components/settings/SettingsHubAccordion";

export default function StoreSettingsHub({
  params,
}: {
  params: { storeId: string };
}) {
  return (
    <SettingsPageShell
      storeId={params.storeId}
      title="Store Settings"
      breadcrumb="Home / Store Settings"
    >
      <p className="mb-5 text-[13px] text-text-3">
        Pick a section below. Each page has Save and Save for all stores.
        eBay connection is optional for demo stores.
      </p>
      <SettingsHubAccordion storeId={params.storeId} />
      <p className="mt-6 text-[13px] text-text-2">
        <Link href="/stores" className="font-medium text-accent hover:underline">
          Manage connected stores
        </Link>
      </p>
    </SettingsPageShell>
  );
}
