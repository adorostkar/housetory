import { cn } from "@/lib/utils";

export function BrandSymbol({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-primary text-primary-foreground shadow-[0_1px_2px_hsl(var(--shadow-color)/0.18)]",
        className,
      )}
      aria-hidden="true"
    >
      <svg viewBox="0 0 40 40" className="size-6" fill="none">
        <path
          d="M12.25 29.5V19.35c0-5.02 3.47-9.1 7.75-9.1s7.75 4.08 7.75 9.1V29.5"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <path
          d="M15.6 21.4h8.8M15.6 26.1h8.8"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          opacity="0.85"
        />
        <circle cx="20" cy="17.8" r="1.25" fill="hsl(var(--brass))" />
      </svg>
    </span>
  );
}

export function BrandMark({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandSymbol />
      {!compact && (
        <span className="font-display text-[1.35rem] font-normal leading-none tracking-[-0.022em] text-foreground">
          Housetory
        </span>
      )}
    </span>
  );
}
