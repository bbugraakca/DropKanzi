import * as React from "react";
import { cn } from "@/lib/utils";

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, label, ...props }, ref) => {
    return (
      <label
        className={cn(
          "inline-flex cursor-pointer items-start gap-2.5 text-[13px] text-text-secondary",
          className
        )}
      >
        <span className="relative mt-0.5 inline-flex shrink-0">
          <input ref={ref} type="checkbox" className="peer sr-only" {...props} />
          <span className="checkbox-ui" aria-hidden />
        </span>
        {label ? <span className="leading-snug">{label}</span> : null}
      </label>
    );
  }
);

Checkbox.displayName = "Checkbox";
