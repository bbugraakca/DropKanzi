import { redirect } from "next/navigation";

export default function LegacyProductsRedirect({
  params,
}: {
  params: { storeId: string };
}) {
  redirect(`/stores/${params.storeId}/listings`);
}
