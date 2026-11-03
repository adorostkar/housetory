import { AlertCircle, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  className,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "surface flex flex-col items-center px-6 py-16 text-center",
        className,
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertCircle className="size-5" />
      </span>
      <h3 className="mt-5 font-display text-2xl tracking-[-0.02em]">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {message ?? "Housetory could not load this view. Please try again."}
      </p>
      {onRetry && (
        <Button variant="outline" className="mt-6" onClick={onRetry}>
          <RotateCcw />
          Try again
        </Button>
      )}
    </div>
  );
}
