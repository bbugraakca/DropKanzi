import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-[7px] text-[13px] font-medium",
          "transition-[background,transform,box-shadow,border-color,color]",
          "duration-100 ease-out",
          "active:scale-[0.98]",
          "focus:outline-none focus-visible:shadow-[0_0_0_3px_rgba(28,53,87,0.08)]",
          "disabled:pointer-events-none disabled:opacity-40 disabled:active:scale-100",
          size === "md" && "h-8 px-3.5",
          size === "sm" && "h-[30px] px-2.5 text-xs",
          variant === "primary" &&
            "border border-transparent bg-accent text-white hover:bg-accent-hover hover:shadow-sm",
          variant === "secondary" &&
            "border border-border bg-surface text-text-2 hover:border-border-2 hover:bg-surface-2 hover:text-text-1",
          variant === "ghost" &&
            "border border-transparent text-text-2 hover:bg-surface-2 hover:text-text-1",
          variant === "danger" &&
            "border border-transparent bg-red text-white hover:bg-red/90",
          className
        )}
        {...props}
      />
    );
  }
);

Button.displayName = "Button";
