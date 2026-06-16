"use client";

import { Layout } from "@/components/layout/Layout";
import { DemoStoreBanner } from "@/components/settings/DemoStoreBanner";

export function SettingsPageShell({
  storeId,
  title,
  breadcrumb,
  children,
}: {
  storeId: string;
  title: string;
  breadcrumb: string;
  children: React.ReactNode;
}) {
  return (
    <Layout title={title} breadcrumb={`Store Settings / ${breadcrumb.replace(/^Store Settings\s*\/?\s*/i, "")}`}>
      <div className="max-w-[900px]">
        <DemoStoreBanner storeId={storeId} />
        {children}
      </div>
    </Layout>
  );
}
