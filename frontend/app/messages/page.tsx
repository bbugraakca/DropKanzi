"use client";

import { Layout } from "@/components/layout/Layout";
import { Card } from "@/components/ui/Card";

export default function MessagesPage() {
  return (
    <Layout title="Messages" breadcrumb="Home / Messages">
      <Card className="p-5">
        <div className="text-sm font-semibold text-text-primary">Messages</div>
        <div className="text-sm text-text-muted mt-1">Coming soon.</div>
      </Card>
    </Layout>
  );
}

