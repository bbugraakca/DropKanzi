"use client";

import { StoreListingsTable } from "@/components/stores/StoreListingsTable";

export default function StoreListingPage({ params }: { params: { storeId: string } }) {
  return <StoreListingsTable storeId={params.storeId} />;
}
