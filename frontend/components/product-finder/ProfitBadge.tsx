import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";

export function ProfitBadge({
  profit,
  margin,
}: {
  profit: number | null;
  margin: number | null;
}) {
  if (profit === null || profit === undefined) {
    return <span className="text-xs text-text-tertiary">—</span>;
  }

  const variant =
    profit > 5 ? "green" : profit >= 0 ? "amber" : "red";

  return (
    <Badge variant={variant} className="font-mono tabular-nums">
      {profit > 0 ? "+" : ""}${profit.toFixed(2)}
      {margin != null ? (
        <span className="font-sans font-normal opacity-80">
          ({margin.toFixed(0)}%)
        </span>
      ) : null}
    </Badge>
  );
}
