"use client";

import { Layout } from "@/components/layout/Layout";
import { Card } from "@/components/ui/Card";

export default function BillingPage() {
  return (
    <Layout title="Billing settings" breadcrumb="Home / Billing">
      <Card className="p-5">
        <div className="text-sm font-semibold text-text-primary">Billing</div>
        <div className="text-sm text-text-muted mt-1">Coming soon.</div>
      </Card>
    </Layout>
  );
}

