"use client";

import { useEffect } from "react";
import { useAppStore } from "@/lib/store/appStore";

export default function ListingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { storeId: string };
}) {
  const setActiveStoreId = useAppStore((s) => s.setActiveStoreId);

  useEffect(() => {
    setActiveStoreId(params.storeId);
  }, [params.storeId, setActiveStoreId]);

  return <>{children}</>;
}
