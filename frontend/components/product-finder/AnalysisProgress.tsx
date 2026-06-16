"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = [
  "Scraping eBay sold listings",
  "Finding Amazon ASINs",
  "Fetching live Amazon prices",
  "Calculating profit",
];

/** Indeterminate animated stepper shown while the analysis runs. */
export function AnalysisProgress() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setActive((a) => (a < STEPS.length - 1 ? a + 1 : a));
    }, 2500);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="surface-card p-6">
      <div className="space-y-4">
        {STEPS.map((label, i) => {
          const done = i < active;
          const current = i === active;
          return (
            <div key={label} className="flex items-center gap-3">
              <div
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-full ring-1 transition-colors",
                  done
                    ? "bg-emerald-50 text-emerald-600 ring-emerald-200"
                    : current
                      ? "bg-accent-light text-accent ring-accent/30"
                      : "bg-surface-muted text-muted-foreground ring-black/[0.05]"
                )}
              >
                {done ? (
                  <Check className="h-4 w-4" />
                ) : current ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <span className="text-xs">{i + 1}</span>
                )}
              </div>
              <span
                className={cn(
                  "text-sm",
                  current
                    ? "font-medium text-foreground"
                    : done
                      ? "text-foreground/70"
                      : "text-muted-foreground"
                )}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-5 text-xs text-muted-foreground">
        This can take 1–3 minutes for large sellers. Results are cached for the rest of
        the day.
      </p>
    </div>
  );
}
