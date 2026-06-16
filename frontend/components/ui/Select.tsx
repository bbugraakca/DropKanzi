import * as React from "react";
import { cn } from "@/lib/utils";

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={cn(
          "h-8 w-full rounded-[7px] border border-border bg-surface px-2.5",
          "text-[13px] text-text-1 outline-none",
          "transition-[border-color,box-shadow] duration-150 ease-out",
          "focus:border-accent focus:shadow-[0_0_0_3px_rgba(28,53,87,0.08)]",
          className
        )}
        {...props}
      />
    );
  }
);

Select.displayName = "Select";
