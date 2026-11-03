import * as React from "react";

import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-28 w-full resize-y rounded-xl border border-input/90 bg-card/65 px-3.5 py-3 text-[0.95rem] leading-relaxed text-foreground shadow-[inset_0_1px_0_hsl(var(--card)/0.6)] transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-muted-foreground/70 focus-visible:border-ring/50 focus-visible:bg-card focus-visible:ring-4 focus-visible:ring-ring/10 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export { Textarea };
