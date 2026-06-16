import { cn } from "@/lib/utils";

type BadgeVariant = "green" | "red" | "amber" | "gray";

export function Badge({
  children,
  variant = "gray",
  className,
}: {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "badge",
        variant === "green" && "badge-green",
        variant === "red" && "badge-red",
        variant === "amber" && "badge-amber",
        variant === "gray" && "badge-gray",
        className
      )}
    >
      {children}
    </span>
  );
}
