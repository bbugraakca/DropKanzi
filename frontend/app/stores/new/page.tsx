"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ConnectStoreRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/stores/oauth");
  }, [router]);
  return null;
}
