import { cn } from "@/lib/utils";

export function TopBar({
  title,
  breadcrumb,
  description,
  compact,
}: {
  title: string;
  breadcrumb?: string;
  description?: string;
  compact?: boolean;
}) {
  return (
    <header
      className={cn(
        "sticky top-0 z-10 flex min-h-[44px] flex-col justify-center border-b border-border bg-surface px-8 lg:px-[32px]",
        compact ? "py-2" : "py-4"
      )}
    >
      {breadcrumb ? (
        <p className="label-caps mb-0.5">{breadcrumb}</p>
      ) : null}
      <h1 className="page-title">{title}</h1>
      {description ? (
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-3">
          {description}
        </p>
      ) : null}
    </header>
  );
}
