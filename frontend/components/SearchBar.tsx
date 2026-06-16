"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { searchProduct } from "@/lib/api";
import { parseAsinsFromText } from "@/lib/asin";
import type { Product } from "@/lib/types";

interface SearchBarProps {
  onResults: (products: Product[]) => void;
  onLoading: (asins: string[]) => void;
}

export function SearchBar({ onResults, onLoading }: SearchBarProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    const asins = parseAsinsFromText(input);
    if (asins.length === 0) {
      toast.error("Gecerli ASIN veya Amazon /dp/ linki girin");
      return;
    }

    setLoading(true);
    onLoading(asins);

    const results: Product[] = [];
    for (const asin of asins) {
      try {
        const product = await searchProduct(asin);
        results.push(product);
        toast.success(`${asin} bulundu`);
      } catch (err) {
        toast.error(`${asin}: ${err instanceof Error ? err.message : "Hata"}`);
      }
    }

    onResults(results);
    setLoading(false);
  };

  return (
    <div className="flex flex-col sm:flex-row gap-3 w-full max-w-2xl">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          placeholder="ASIN veya Amazon linki (orn. B0D1XD1ZV3)"
          className="w-full h-12 pl-10 pr-4 rounded-lg bg-card border border-border text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent font-mono text-sm"
          disabled={loading}
        />
      </div>
      <Button onClick={handleSubmit} disabled={loading} className="shrink-0 h-12 px-5">
        {loading ? "Aranıyor..." : "Ürün Bul"}
      </Button>
    </div>
  );
}
