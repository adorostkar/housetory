import { ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(
  ({ className, children, ...props }, ref) => (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          "flex h-11 w-full appearance-none rounded-xl border border-input/90 bg-card/65 px-3.5 py-2 pr-10 text-[0.95rem] text-foreground shadow-[inset_0_1px_0_hsl(var(--card)/0.6)] transition-[border-color,box-shadow,background-color] duration-200 focus-visible:border-ring/50 focus-visible:bg-card focus-visible:ring-4 focus-visible:ring-ring/10 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  ),
);
Select.displayName = "Select";

export { Select };
