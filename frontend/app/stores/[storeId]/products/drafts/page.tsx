import { redirect } from "next/navigation";

export default function LegacyDraftsRedirect({
  params,
}: {
  params: { storeId: string };
}) {
  redirect(`/stores/${params.storeId}/listings`);
}
