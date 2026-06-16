"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAppStore } from "@/lib/store/appStore";

/** Legacy /products URL → store listings. */
export default function ProductsRedirectPage() {
  const router = useRouter();
  const activeStoreId = useAppStore((s) => s.activeStoreId);

  useEffect(() => {
    if (activeStoreId) {
      router.replace(`/stores/${activeStoreId}/listings`);
    } else {
      router.replace("/stores");
    }
  }, [activeStoreId, router]);

  return (
    <div className="p-8 text-sm text-text-muted">Redirecting to Listing…</div>
  );
}
