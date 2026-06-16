"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const links = [
  { label: "Menu", href: "" },
  { label: "Offer", href: "offer-selection" },
  { label: "Range", href: "range-repricing" },
  { label: "Fee", href: "additional-fee" },
  { label: "Round", href: "round-prices" },
  { label: "Sales", href: "sales-count" },
  { label: "Location", href: "location-settings" },
  { label: "VAT", href: "vat-details" },
];

export function RepricingSubnav({ storeId }: { storeId: string }) {
  const pathname = usePathname();
  const base = `/stores/${storeId}/settings/repricing`;

  return (
    <div className="flex flex-wrap gap-2 mb-4">
      {links.map((l) => {
        const href = l.href ? `${base}/${l.href}` : base;
        const active = l.href
          ? pathname === href
          : pathname === base;
        return (
          <Link
            key={l.href || "menu"}
            href={href}
            className={cn(
              "px-3 py-1.5 rounded-[6px] text-xs font-medium border",
              active
                ? "bg-accent-light text-accent border-accent/30"
                : "bg-white text-text-muted border-border hover:bg-[#F9FAFB]"
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </div>
  );
}
