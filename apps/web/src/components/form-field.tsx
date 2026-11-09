import { cn } from "@/lib/utils";

export function Field({
  label,
  htmlFor,
  hint,
  error,
  optional,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="field-label">
          {label}
          {optional && <span className="ml-1.5 font-normal text-muted-foreground">Optional</span>}
        </label>
        {hint && <span className="text-2xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
      {error && (
        <p className="text-2xs leading-snug text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div
      className="rounded-xl border border-destructive/20 bg-destructive/[0.06] px-3.5 py-3 text-xs leading-relaxed text-destructive"
      role="alert"
    >
      {message}
    </div>
  );
}
