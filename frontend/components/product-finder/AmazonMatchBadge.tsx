import { Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function AmazonMatchBadge({
  asin,
  confidence,
  method,
  imageScore,
}: {
  asin: string | null;
  confidence: number | null;
  method?: string;
  imageScore?: number | null;
}) {
  if (!asin) {
    return (
      <span className="inline-flex items-center rounded-md bg-surface-muted px-2 py-0.5 text-xs text-muted-foreground ring-1 ring-black/[0.05]">
        No match
      </span>
    );
  }

  const conf = confidence ?? 0;
  const label =
    conf >= 0.99
      ? "Exact"
      : conf >= 0.9
        ? "High"
        : conf >= 0.8
          ? "Good"
          : "Low";
  const tone =
    conf >= 0.9
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : conf >= 0.8
        ? "bg-sky-50 text-sky-700 ring-sky-200"
        : conf >= 0.7
          ? "bg-amber-50 text-amber-800 ring-amber-200"
          : "bg-rose-50 text-rose-700 ring-rose-200";

  const hasImage =
    (method?.includes("image") || method === "image_dhash" || method === "image_vision") &&
    imageScore != null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1",
        tone
      )}
      title={
        `Match confidence: ${(conf * 100).toFixed(0)}%` +
        (method ? ` · ${method}` : "") +
        (imageScore != null ? ` · image ${(imageScore * 100).toFixed(0)}%` : "")
      }
    >
      {label}
      <span className="font-normal opacity-70">{(conf * 100).toFixed(0)}%</span>
      {hasImage ? <ImageIcon className="h-3 w-3 opacity-70" /> : null}
    </span>
  );
}
