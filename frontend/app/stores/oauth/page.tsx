"use client";

import { Suspense } from "react";
import EbayOAuthInner from "./oauth-inner";

export default function EbayOAuthPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-text-muted">Loading…</div>}>
      <EbayOAuthInner />
    </Suspense>
  );
}
