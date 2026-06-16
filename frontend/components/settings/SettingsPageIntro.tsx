"use client";

import { ChevronDown } from "lucide-react";
import type { StoreSettingMeta } from "@/lib/storeSettingsMeta";

export function SettingsPageIntro({ meta }: { meta: StoreSettingMeta }) {
  return (
    <div className="mb-6 space-y-3">
      <p className="text-[13px] leading-relaxed text-text-3">{meta.summary}</p>
      <details className="group surface-card overflow-hidden">
        <summary className="settings-row mb-0 cursor-pointer list-none rounded-[10px] border-0 bg-transparent">
          <span>What you can configure</span>
          <ChevronDown className="h-4 w-4 text-text-3 transition-transform duration-150 group-open:rotate-180" />
        </summary>
        <div className="border-t border-border px-4 pb-4 pt-3">
          <ul className="space-y-1.5 text-[13px] text-text-2">
            {meta.fields.map((f) => (
              <li key={f} className="flex gap-2">
                <span className="text-text-3">·</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}
