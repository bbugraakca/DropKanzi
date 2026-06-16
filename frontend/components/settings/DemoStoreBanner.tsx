"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getStoreSettings } from "@/lib/api";

export function DemoStoreBanner({ storeId }: { storeId: string }) {
  const [isDemo, setIsDemo] = useState(false);

  useEffect(() => {
    getStoreSettings(storeId)
      .then((r) => setIsDemo(!!(r.settings as { isDemo?: boolean })?.isDemo))
      .catch(() => setIsDemo(false));
  }, [storeId]);

  if (!isDemo) return null;

  return (
    <div className="mb-5 rounded-xl border border-amber-200/80 bg-amber-50/90 px-4 py-3 text-sm text-amber-950/90 leading-relaxed">
      Demo store — settings save without eBay.{" "}
      <Link href="/stores/oauth" className="text-accent hover:underline font-medium">
        Connect eBay later
      </Link>
    </div>
  );
}
