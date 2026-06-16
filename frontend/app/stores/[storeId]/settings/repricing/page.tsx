import { redirect } from "next/navigation";

export default function LegacyRepricingRedirect({
  params,
}: {
  params: { storeId: string };
}) {
  redirect(`/stores/${params.storeId}/settings`);
}
