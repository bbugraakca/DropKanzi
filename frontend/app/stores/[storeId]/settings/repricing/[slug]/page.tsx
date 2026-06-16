import { redirect } from "next/navigation";

const map: Record<string, string> = {
  "offer-selection": "offer-selection",
  "range-repricing": "range-repricing",
  "additional-fee": "additional-fee",
  "round-prices": "round-prices",
  "sales-count": "sales-count",
  "location-settings": "location-settings",
  "vat-details": "vat-details",
};

export default function LegacyRepricingSlugRedirect({
  params,
}: {
  params: { storeId: string; slug: string };
}) {
  const target = map[params.slug] || "repricing-settings";
  redirect(`/stores/${params.storeId}/settings/${target}`);
}
