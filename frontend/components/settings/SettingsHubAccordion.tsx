"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import {
  STORE_SETTINGS_CATALOG,
  STORE_SETTINGS_GROUPS,
} from "@/lib/storeSettingsMeta";

export function SettingsHubAccordion({ storeId }: { storeId: string }) {
  const base = `/stores/${storeId}/settings`;

  return (
    <div className="space-y-6">
      {STORE_SETTINGS_GROUPS.map((group) => {
        const items = STORE_SETTINGS_CATALOG.filter((s) => s.group === group.id);
        if (items.length === 0) return null;
        return (
          <section key={group.id}>
            <h2 className="label-caps mb-2">{group.title}</h2>
            <div>
              {items.map((item) => (
                <Link
                  key={item.href}
                  href={`${base}/${item.href}`}
                  className="settings-row group"
                >
                  <span>{item.label}</span>
                  <ChevronRight className="h-4 w-4 text-text-3 transition-transform duration-100 group-hover:translate-x-0.5" />
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
