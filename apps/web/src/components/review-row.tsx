import { AlertTriangle, ChevronDown } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * The one row that every review uses: a photo finding, an imported item, a line of a
 * document, a suggestion. It is closed by default and shows what will be saved. Small
 * corrections (name, quantity) are made in the row; anything larger opens below it.
 */

export interface ReviewValue {
  label: string;
  /** The proposed value. For a new record this is the value that was read. */
  value: React.ReactNode;
  /** The value an existing record has now. When set, the row shows old → proposed. */
  before?: React.ReactNode;
  /** The value was guessed or conflicts with something. It is marked "check". */
  uncertain?: boolean;
}

export function ReviewRow({
  title,
  titleLabel,
  onTitleChange,
  titleError,
  quantity,
  onQuantityChange,
  quantityError,
  thumbnail,
  values = [],
  checks = [],
  badges,
  selection,
  primary,
  onSkip,
  skipLabel = "Skip",
  expand,
  actions,
  error,
  status,
  extra,
  disabled = false,
  className,
  style,
  children,
}: {
  title: string;
  /** Accessible name of the name field, for example "Name of Cordless drill". */
  titleLabel?: string;
  onTitleChange?: (value: string) => void;
  titleError?: string | null;
  quantity?: number | string | null;
  onQuantityChange?: (value: string) => void;
  quantityError?: string | null;
  thumbnail?: React.ReactNode;
  values?: ReviewValue[];
  /**
   * Short warnings a person must see before pressing the row's button. They are shown
   * on the closed row, in one line under the name. A longer text belongs in the editor.
   */
  checks?: string[];
  badges?: React.ReactNode;
  /** A checkbox only selects the row for the bulk action. It never decides anything. */
  selection?: { checked: boolean; onChange: (checked: boolean) => void; label: string };
  primary?: { label: string; onClick: () => void; disabled?: boolean; pending?: boolean };
  onSkip?: () => void;
  skipLabel?: string;
  expand?: { open: boolean; onOpenChange: (open: boolean) => void; label?: string };
  /** More actions for this row, shown after Skip. */
  actions?: React.ReactNode;
  /** A problem with the whole row, for example a failed save. Always visible. */
  error?: string | null;
  /** Shown in place of the actions when the row is finished. */
  status?: React.ReactNode;
  /** Always visible content under the values, for example a duplicate comparison. */
  extra?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  const ids = React.useId();
  const editable = Boolean(onTitleChange) && !disabled;
  const inlineInput =
    "min-h-11 rounded-md border border-transparent bg-transparent px-1.5 text-sm font-medium transition-colors hover:border-border focus-visible:border-input focus-visible:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 lg:min-h-9";
  return (
    <article
      aria-label={title || "Unnamed"}
      className={cn("surface overflow-hidden", selection?.checked && "border-sage/40", className)}
      style={style}
    >
      <div className="flex items-start gap-2 p-3 sm:gap-3 sm:p-4">
        {selection && (
          <label className="-m-1 flex size-11 shrink-0 cursor-pointer items-center justify-center">
            <input
              type="checkbox"
              checked={selection.checked}
              disabled={disabled}
              onChange={(event) => selection.onChange(event.target.checked)}
              aria-label={selection.label}
              className="size-5 rounded-none accent-primary"
            />
          </label>
        )}
        {thumbnail && <div className="shrink-0">{thumbnail}</div>}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {editable ? (
              <input
                id={`${ids}-title`}
                value={title}
                maxLength={200}
                aria-label={titleLabel ?? "Name"}
                aria-invalid={titleError ? true : undefined}
                aria-describedby={titleError ? `${ids}-title-error` : undefined}
                onChange={(event) => onTitleChange?.(event.target.value)}
                className={cn(inlineInput, "-ml-1.5 min-w-0 flex-1 basis-40", titleError && "border-destructive")}
              />
            ) : (
              <h3 className="min-w-0 break-words text-sm font-medium">{title}</h3>
            )}
            {onQuantityChange && !disabled ? (
              <label className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
                <span aria-hidden="true">×</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={quantity ?? ""}
                  aria-label={`Quantity of ${title || "this row"}`}
                  aria-invalid={quantityError ? true : undefined}
                  aria-describedby={quantityError ? `${ids}-quantity-error` : undefined}
                  onChange={(event) => onQuantityChange(event.target.value)}
                  className={cn(inlineInput, "w-16 text-foreground", quantityError && "border-destructive")}
                />
              </label>
            ) : quantity != null && quantity !== "" && String(quantity) !== "1" ? (
              <span className="shrink-0 text-sm text-muted-foreground">×{quantity}</span>
            ) : null}
            {badges}
          </div>
          {titleError && (
            <p id={`${ids}-title-error`} role="alert" className="text-xs text-destructive">{titleError}</p>
          )}
          {quantityError && (
            <p id={`${ids}-quantity-error`} role="alert" className="text-xs text-destructive">{quantityError}</p>
          )}
          {checks.length > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-brass">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">Check: {checks.join(" · ")}</span>
            </p>
          )}
          {values.length > 0 && (
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {values.map((entry) => (
                <li key={entry.label} className="min-w-0 break-words">
                  {entry.label}:{" "}
                  {entry.before != null && entry.before !== "" && (
                    <>
                      <span className="line-through">{entry.before}</span>
                      <span aria-hidden="true"> → </span>
                      <span className="sr-only"> changes to </span>
                    </>
                  )}
                  <span
                    className={cn(
                      "font-medium text-foreground",
                      entry.uncertain && "rounded bg-brass-soft/60 px-1 text-brass",
                    )}
                  >
                    {entry.value}
                  </span>
                  {entry.uncertain && <span className="ml-1 text-brass">· check</span>}
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </p>
          )}
          {extra}
          {status ?? (
            (primary || onSkip || expand || actions) && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {primary && (
                  <Button type="button" size="sm" className="min-h-11 lg:min-h-9"
                    disabled={disabled || primary.disabled || primary.pending} onClick={primary.onClick}>
                    {primary.pending && <Spinner />}
                    {primary.label}
                  </Button>
                )}
                {onSkip && (
                  <Button type="button" size="sm" variant="ghost" className="min-h-11 lg:min-h-9"
                    disabled={disabled} onClick={onSkip}>
                    {skipLabel}
                  </Button>
                )}
                {actions}
                {expand && (
                  <Button type="button" size="sm" variant="ghost" className="ml-auto min-h-11 lg:min-h-9"
                    aria-expanded={expand.open} aria-controls={`${ids}-more`}
                    onClick={() => expand.onOpenChange(!expand.open)}>
                    {expand.open ? "Close" : expand.label ?? "Edit"}
                    <ChevronDown aria-hidden="true"
                      className={cn("transition-transform", expand.open && "rotate-180")} />
                  </Button>
                )}
              </div>
            )
          )}
        </div>
      </div>
      {expand?.open && children && (
        <div id={`${ids}-more`} className="space-y-5 border-t border-border/60 p-3 sm:p-4">
          {children}
        </div>
      )}
    </article>
  );
}

/** Empty fields stay here, closed, so that a row's editor shows only what has a value. */
export function MoreDetails({ children, label = "More details", defaultOpen = false }: {
  children: React.ReactNode;
  label?: string;
  /** Open at first when a field inside already has a value. Decided once. */
  defaultOpen?: boolean;
}) {
  const [initiallyOpen] = React.useState(defaultOpen);
  return (
    <details className="rounded-xl border border-border/60" open={initiallyOpen || undefined}>
      <summary className="flex min-h-11 cursor-pointer items-center px-3.5 text-sm font-medium lg:text-xs">
        {label}
      </summary>
      <div className="space-y-5 border-t border-border/60 p-3.5">{children}</div>
    </details>
  );
}

/**
 * Skipped rows leave the list and wait here, at the end. They can be put back after
 * the Undo message is gone.
 */
export function SkippedSection({ count, hint, children }: {
  count: number;
  hint?: string;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <details className="surface px-3 sm:px-4" aria-label="Skipped">
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
        Skipped ({count})
      </summary>
      <div className="space-y-1 pb-3">
        <p className="text-xs text-muted-foreground">
          {hint ?? "Nothing was added for these. Restore puts a row back in the list with its edits."}
        </p>
        <ul className="divide-y divide-border/60">{children}</ul>
      </div>
    </details>
  );
}

export function SkippedRow({ title, detail, onRestore, disabled = false, restoreLabel = "Restore" }: {
  title: string;
  detail?: React.ReactNode;
  onRestore?: () => void;
  disabled?: boolean;
  restoreLabel?: string;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <p className="min-w-0 break-words text-sm">
        {title}
        {detail && <span className="block text-xs text-muted-foreground">{detail}</span>}
      </p>
      {onRestore && (
        <Button type="button" size="sm" variant="outline" className="min-h-11 lg:min-h-9"
          aria-label={`${restoreLabel} ${title}`} disabled={disabled} onClick={onRestore}>
          {restoreLabel}
        </Button>
      )}
    </li>
  );
}
