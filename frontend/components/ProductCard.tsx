"use client";

import { Package } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Product } from "@/lib/types";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Az önce";
  if (mins < 60) return `${mins} dk önce`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} sa önce`;
  return `${Math.floor(hours / 24)} gün önce`;
}

interface ProductCardProps {
  product: Product;
  onClick: () => void;
  className?: string;
}

export function ProductCard({ product, onClick, className }: ProductCardProps) {
  const image = product.images?.[0];

  return (
    <article
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      onClick={onClick}
      className={cn(
        "group cursor-pointer rounded-xl border border-border bg-card p-4 transition-all duration-200",
        "hover:border-accent hover:-translate-y-1 hover:shadow-lg hover:shadow-accent/5",
        "animate-fadeIn",
        className
      )}
    >
      <div className="aspect-square rounded-lg bg-background mb-3 overflow-hidden flex items-center justify-center">
        {image ? (
          <img src={image} alt={product.title || product.asin} className="w-full h-full object-contain" />
        ) : (
          <Package className="w-12 h-12 text-muted" />
        )}
      </div>

      <h3 className="text-sm font-medium line-clamp-2 min-h-[2.5rem] mb-1">
        {product.title || "Başlık yok"}
      </h3>

      <p className="font-mono text-xs text-muted mb-2">{product.asin}</p>

      <p className="font-mono text-2xl text-accent font-bold mb-3">
        {product.price != null ? `$${product.price.toFixed(2)}` : "—"}
      </p>

      <div className="flex flex-wrap gap-2 mb-2">
        {product.isInStock ? (
          <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">✓ Stokta</span>
        ) : (
          <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">✗ Stok Yok</span>
        )}
        {product.isAmazonFulfilled ? (
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">Amazon Satar</span>
        ) : (
          <span className="text-xs px-2 py-0.5 rounded-full bg-muted/20 text-muted">3rd Party</span>
        )}
      </div>

      {product.rating != null && (
        <p className="text-xs text-muted mb-1">★ {product.rating.toFixed(1)}</p>
      )}

      {product.buyBoxSeller && (
        <p className="text-xs text-muted truncate mb-3">{product.buyBoxSeller}</p>
      )}

      <footer className="flex items-center justify-between text-xs text-muted pt-2 border-t border-border">
        <span>{timeAgo(product.updatedAt)}</span>
        <a
          href={`https://www.amazon.com/dp/${product.asin}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-accent hover:underline"
        >
          Amazon&apos;da Gör →
        </a>
      </footer>
    </article>
  );
}
