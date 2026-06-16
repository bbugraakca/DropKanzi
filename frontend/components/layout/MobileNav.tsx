"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Layers, Search, ClipboardList, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store/appStore";

const tabs = [
  { href: "/", label: "Home", icon: Home, match: (p: string) => p === "/" },
  { href: "/bulk", label: "Bulk", icon: Layers, match: (p: string) => p.startsWith("/bulk") },
  {
    href: "/product-finder",
    label: "Finder",
    icon: Search,
    match: (p: string) => p.startsWith("/product-finder"),
  },
  {
    href: "/orders",
    label: "Orders",
    icon: ClipboardList,
    match: (p: string) => p.startsWith("/orders"),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    match: (p: string) => p.startsWith("/settings") || p.includes("/settings"),
  },
];

export function MobileNav() {
  const pathname = usePathname();
  const { activeStoreId } = useAppStore();

  const resolveHref = (href: string) => {
    if (href === "/settings" && activeStoreId) {
      return `/stores/${activeStoreId}/settings`;
    }
    return href;
  };

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex h-14 border-t border-border bg-surface md:hidden">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const href = resolveHref(tab.href);
        const active = tab.match(pathname);
        return (
          <Link
            key={tab.href}
            href={href}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors duration-100",
              active ? "text-accent" : "text-text-3"
            )}
          >
            <Icon className="h-[18px] w-[18px]" />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
