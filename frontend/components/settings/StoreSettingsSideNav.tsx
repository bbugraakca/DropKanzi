"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  STORE_SETTINGS_CATALOG,
  STORE_SETTINGS_GROUPS,
} from "@/lib/storeSettingsMeta";
import { cn } from "@/lib/utils";

export function StoreSettingsSideNav({ storeId }: { storeId: string }) {
  const pathname = usePathname();
  const base = `/stores/${storeId}/settings`;
  const hubActive = pathname === base;

  return (
    <nav className="w-[210px] shrink-0 pr-5 border-r border-border-subtle">
      <Link
        href={base}
        className={cn(
          "block px-3 py-2 rounded-lg text-sm font-medium mb-4 transition-colors",
          hubActive
            ? "bg-accent-light text-accent"
            : "text-text-body hover:bg-surface-hover"
        )}
      >
        Overview
      </Link>

      {STORE_SETTINGS_GROUPS.map((group) => (
        <div key={group.id} className="mb-5">
          <div className="px-3 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            {group.title}
          </div>
          <ul className="space-y-0.5">
            {STORE_SETTINGS_CATALOG.filter((s) => s.group === group.id).map((item) => {
              const href = `${base}/${item.href}`;
              const active = pathname === href;
              return (
                <li key={item.href}>
                  <Link
                    href={href}
                    className={cn(
                      "block px-3 py-2 rounded-lg text-[13px] leading-snug transition-colors",
                      active
                        ? "bg-accent-light text-accent font-medium"
                        : "text-text-body hover:bg-surface-hover"
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export const STORE_SETTINGS_LINKS = STORE_SETTINGS_CATALOG.map((s) => ({
  label: s.label,
  href: s.href,
}));
