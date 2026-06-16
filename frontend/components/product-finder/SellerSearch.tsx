"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { rememberSellerSearches, unmarkSellerRemoved } from "@/lib/productFinderStorage";
import { parseEbaySellerInput } from "@/lib/parseEbaySellerInput";
import { cn } from "@/lib/utils";

const DAY_OPTIONS = [7, 14, 30, 60, 90] as const;

export function SellerSearch({
  onAnalyze,
}: {
  onAnalyze: (
    seller: string,
    daysBack: number,
    forceRefresh?: boolean,
    fetchPrices?: boolean
  ) => void;
}) {
  const [seller, setSeller] = useState("");
  const [daysBack, setDaysBack] = useState<number>(30);
  const [forceRefresh, setForceRefresh] = useState(false);
  const [skipPrices, setSkipPrices] = useState(false);
  const [showOptions, setShowOptions] = useState(false);

  const queueSellers = (
    names: string[],
    days: number,
    fresh = forceRefresh,
    withPrices = !skipPrices
  ) => {
    const seen = new Set<string>();
    const queued: Array<{
      seller: string;
      daysBack: number;
      sellerInput?: string;
    }> = [];
    for (const raw of names) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const parsed = parseEbaySellerInput(trimmed);
      if (!parsed.seller) continue;
      const key = parsed.seller.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unmarkSellerRemoved(parsed.seller);
      queued.push({
        seller: parsed.seller,
        daysBack: days,
        sellerInput: parsed.apiInput,
      });
      onAnalyze(trimmed, days, fresh, withPrices);
    }
    if (queued.length === 0) return;
    rememberSellerSearches(queued);
  };

  const submit = () => {
    const names = seller
      .split(/[\s,\n]+/)
      .map((s) => s.trim().replace(/^@/, ""))
      .filter(Boolean);
    queueSellers(names, daysBack);
    setSeller("");
  };

  return (
    <div className="pf-search p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
        <div className="min-w-0 flex-1">
          <label className="label-caps mb-1.5 block">Seller username</label>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" />
              <Input
                className="h-9 pl-9"
                placeholder="batudeals, or paste eBay sold URL"
                value={seller}
                onChange={(e) => setSeller(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
            </div>
            <Button
              onClick={submit}
              disabled={!seller.trim()}
              type="button"
              className="h-9 shrink-0 px-5"
            >
              Analyze
            </Button>
          </div>
        </div>

        <div className="shrink-0">
          <label className="label-caps mb-1.5 block">Days back</label>
          <div className="segmented">
            {DAY_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDaysBack(d)}
                className={cn(
                  "segmented-item min-w-[40px] text-center",
                  daysBack === d && "segmented-item-active"
                )}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => setShowOptions((v) => !v)}
          className="text-[12px] font-medium text-text-3 transition-colors hover:text-text-1"
        >
          {showOptions ? "Hide options" : "Scan options"}
        </button>
        {(forceRefresh || skipPrices) && !showOptions ? (
          <span className="text-[11px] text-text-3">
            {forceRefresh ? "Fresh scan" : null}
            {forceRefresh && skipPrices ? " · " : null}
            {skipPrices ? "Match only" : null}
          </span>
        ) : null}
      </div>

      {showOptions ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <Checkbox
            checked={forceRefresh}
            onChange={(e) => setForceRefresh(e.target.checked)}
            label="Fresh scan — re-scrape eBay + re-match Amazon (uses proxy)"
          />
          <Checkbox
            checked={skipPrices}
            onChange={(e) => setSkipPrices(e.target.checked)}
            label="Match only — skip Amazon price fetch during scan"
          />
          <p className="text-[11px] leading-relaxed text-text-3">
            Match uses Amazon search (title + image + list price). Use Fresh scan after changing
            options.
          </p>
        </div>
      ) : null}
    </div>
  );
}
