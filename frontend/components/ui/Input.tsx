import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          "h-8 w-full rounded-[7px] border border-border bg-surface px-2.5",
          "text-[13px] text-text-1 outline-none",
          "placeholder:text-text-3",
          "transition-[border-color,box-shadow] duration-150 ease-out",
          "focus:border-accent focus:shadow-[0_0_0_3px_rgba(28,53,87,0.08)]",
          className
        )}
        {...props}
      />
    );
  }
);

Input.displayName = "Input";

export const AsinInput = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => {
    return (
      <Input
        ref={ref}
        className={cn("font-mono uppercase tracking-[0.05em]", className)}
        {...props}
      />
    );
  }
);

AsinInput.displayName = "AsinInput";
