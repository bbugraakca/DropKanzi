"use client";

import { useCallback, useEffect, useState } from "react";
import { X, RefreshCw } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { getProduct, searchProduct } from "@/lib/api";
import type { Product } from "@/lib/types";

interface ProductModalProps {
  product: Product;
  onClose: () => void;
  onUpdate: (product: Product) => void;
}

function parseAttributes(raw: Product["attributes"]): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  return raw as Record<string, string>;
}

export function ProductModal({ product, onClose, onUpdate }: ProductModalProps) {
  const [current, setCurrent] = useState(product);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<"bullets" | "about" | "specs">("bullets");

  const bullets = current.bulletPoints ?? [];
  const attrs = parseAttributes(current.attributes);
  const attrEntries = Object.entries(attrs);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    setCurrent(product);
  }, [product]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [handleClose]);

  useEffect(() => {
    if (current.bulletPoints?.length && current.priceHistory?.length) return;
    let cancelled = false;
    getProduct(current.asin)
      .then((full) => {
        if (!cancelled) {
          setCurrent(full);
          onUpdate(full);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [current.asin, current.bulletPoints?.length, current.priceHistory?.length, onUpdate]);

  const chartData = (current.priceHistory || [])
    .slice()
    .reverse()
    .map((h) => ({
      date: new Date(h.scrapedAt).toLocaleDateString("tr-TR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      price: h.price ?? 0,
    }));

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const updated = await searchProduct(current.asin);
      setCurrent(updated);
      onUpdate(updated);
      toast.success("Urun yenilendi");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Yenileme basarisiz");
    } finally {
      setRefreshing(false);
    }
  };

  const rows = [
    ["ASIN", current.asin],
    ["Marka", current.brand || "—"],
    ["Fiyat", current.price != null ? `$${current.price.toFixed(2)}` : "—"],
    ["Stok", current.stock || "—"],
    ["Buy Box", current.buyBoxSeller || "—"],
    ["Rating", current.rating != null ? `${current.rating} ★` : "—"],
    ["Yorumlar", current.reviewsCount != null ? String(current.reviewsCount) : "—"],
    ["Olcu / Boyut", current.dimensions || "—"],
    ["Son Guncelleme", new Date(current.updatedAt).toLocaleString("tr-TR")],
  ];

  return (
    <div
      className="fixed inset-0 z-[100] flex justify-end"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/60 cursor-pointer border-0 p-0"
        aria-label="Kapat"
        onClick={handleClose}
      />
      <div
        className="relative z-[101] w-full max-w-xl h-full bg-card border-l border-border overflow-y-auto animate-fadeIn shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-start justify-between gap-2 p-4 border-b border-border bg-card z-10">
          <h2 className="font-semibold text-lg line-clamp-2 flex-1">
            {current.title || current.asin}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="shrink-0 p-2 rounded-lg hover:bg-background text-foreground"
            aria-label="Kapat"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {current.images && current.images.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-2">
              {current.images.slice(0, 6).map((src, i) => (
                <img
                  key={`${src}-${i}`}
                  src={src}
                  alt=""
                  className="h-24 w-24 shrink-0 object-contain rounded-lg bg-background border border-border"
                />
              ))}
            </div>
          )}

          <dl className="space-y-2">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 text-sm">
                <dt className="text-muted shrink-0">{label}</dt>
                <dd className="font-mono text-right text-xs sm:text-sm break-all">
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          {(bullets.length > 0 || current.aboutText || attrEntries.length > 0) && (
            <div className="border border-border rounded-xl overflow-hidden">
              <div className="flex border-b border-border bg-background/50">
                {bullets.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setTab("bullets")}
                    className={`flex-1 px-3 py-2 text-xs font-medium ${
                      tab === "bullets"
                        ? "text-accent border-b-2 border-accent"
                        : "text-muted"
                    }`}
                  >
                    Ozellikler ({bullets.length})
                  </button>
                )}
                {current.aboutText && (
                  <button
                    type="button"
                    onClick={() => setTab("about")}
                    className={`flex-1 px-3 py-2 text-xs font-medium ${
                      tab === "about"
                        ? "text-accent border-b-2 border-accent"
                        : "text-muted"
                    }`}
                  >
                    Aciklama
                  </button>
                )}
                {attrEntries.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setTab("specs")}
                    className={`flex-1 px-3 py-2 text-xs font-medium ${
                      tab === "specs"
                        ? "text-accent border-b-2 border-accent"
                        : "text-muted"
                    }`}
                  >
                    Teknik ({attrEntries.length})
                  </button>
                )}
              </div>

              <div className="p-4 max-h-80 overflow-y-auto text-sm">
                {tab === "bullets" && bullets.length > 0 && (
                  <ul className="space-y-2 list-none">
                    {bullets.map((b, i) => (
                      <li key={i} className="flex gap-2 leading-relaxed">
                        <span className="text-accent shrink-0">•</span>
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {tab === "about" && current.aboutText && (
                  <div className="text-muted leading-relaxed whitespace-pre-wrap">
                    {current.aboutText}
                  </div>
                )}
                {tab === "specs" && attrEntries.length > 0 && (
                  <table className="w-full text-xs">
                    <tbody>
                      {attrEntries.map(([k, v]) => (
                        <tr
                          key={k}
                          className="border-b border-border/50 last:border-0"
                        >
                          <td className="py-2 pr-3 text-muted align-top font-medium w-[40%]">
                            {k}
                          </td>
                          <td className="py-2 align-top">{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {chartData.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-3">Fiyat Gecmisi</h3>
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: "#6b6b80" }}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: "#6b6b80" }}
                      domain={["auto", "auto"]}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "#12121a",
                        border: "1px solid #1e1e2e",
                        borderRadius: "8px",
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="price"
                      stroke="#f0c040"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <div className="flex gap-3 pb-6">
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <RefreshCw
                className={`w-4 h-4 mr-2 ${refreshing ? "animate-spin" : ""}`}
              />
              Yenile
            </Button>
            <a
              href={`https://www.amazon.com/dp/${current.asin}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1"
            >
              <Button type="button" className="w-full">
                Amazon&apos;da Gor
              </Button>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
