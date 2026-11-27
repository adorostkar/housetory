import { AlertTriangle, ChevronDown } from "lucide-react";
import * as React from "react";

import { useBarEditor, type BarEditRequest } from "@/components/shell/bar-editor";
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
  /**
   * Makes the value a button that opens it in the bar editor. Where there is no bar
   * (a page on its own), the value stays as text and is changed in the row's editor.
   */
  edit?: ValueEdit;
}

/** What the bar editor needs to change one value of a row. */
export type ValueEdit = Pick<BarEditRequest, "value" | "inputMode" | "validate" | "onCommit"> & {
  /** Short name in front of the field. Defaults to the value's label. */
  label?: string;
  /** What is being changed, for screen readers: "Serial number of Cordless drill". */
  description: string;
};

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** A value that is tapped to change it through the bar. */
function ValueButton({ edit, label, className, children }: {
  edit: ValueEdit;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  const barEditor = useBarEditor();
  const ref = React.useRef<HTMLButtonElement>(null);
  // The save must go through the row as it is when the value is saved, not as
  // it was when the value was tapped: another edit may have come in between.
  const latest = React.useRef(edit);
  latest.current = edit;
  if (!barEditor) return <>{children}</>;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Edit ${lowerFirst(edit.description)}`}
      onClick={() => barEditor.edit({
        label: edit.label ?? label,
        description: edit.description,
        value: edit.value,
        inputMode: edit.inputMode,
        validate: (value) => latest.current.validate?.(value) ?? null,
        onCommit: (value) => latest.current.onCommit(value),
        returnFocus: ref.current,
      })}
      className={cn(
        "inline-flex min-h-11 min-w-11 max-w-full items-center rounded-md text-left underline decoration-dotted underline-offset-4 transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 lg:min-h-7 lg:min-w-0 coarse:!min-h-11 coarse:!min-w-11",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function ReviewRow({
  id,
  number,
  marked = false,
  onActivate,
  title,
  titleLabel,
  onTitleChange,
  titleValidate,
  titleError,
  quantity,
  onQuantityChange,
  quantityValidate,
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
  /** Id of the row element, so that something else (a pin on a photo) can go to it. */
  id?: string;
  /** The number of a finding. It is the same number as its pin on the photo. */
  number?: number;
  /** The row is the one that is pointed at, for example by its pin. */
  marked?: boolean;
  /** The pointer or the focus came to this row. */
  onActivate?: () => void;
  title: string;
  /** Accessible name of the name field, for example "Name of Cordless drill". */
  titleLabel?: string;
  onTitleChange?: (value: string) => void;
  /** Checked before the bar editor saves a name. A text keeps the editor open. */
  titleValidate?: (value: string) => string | null;
  titleError?: string | null;
  quantity?: number | string | null;
  onQuantityChange?: (value: string) => void;
  quantityValidate?: (value: string) => string | null;
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
  // With a bar on the page, a value is tapped and changed there. Without one (a page
  // on its own), name and quantity are fields in the row, as before.
  const barEditor = useBarEditor();
  const selected = Boolean(selection?.checked);
  const inlineInput =
    "min-h-11 rounded-md border border-transparent bg-transparent px-1.5 text-sm font-medium transition-colors hover:border-border focus-visible:border-input focus-visible:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 lg:min-h-9";
  return (
    <article
      aria-label={title || "Unnamed"}
      id={id}
      tabIndex={id ? -1 : undefined}
      data-selected={selected ? "true" : undefined}
      data-marked={marked ? "true" : undefined}
      onMouseEnter={onActivate}
      onFocusCapture={onActivate}
      className={cn(
        "surface overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        // A selected row has its own background and a bar in the primary colour, so
        // that it does not depend on colour alone. Text on it stays in the foreground
        // colours, which are readable on this background in every theme.
        selected && "border-primary bg-accent shadow-[inset_4px_0_0_0_hsl(var(--primary))]",
        marked && "ring-2 ring-ring/60",
        className,
      )}
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
            {number != null && (
              <span
                aria-label={`Finding ${number}`}
                className="flex size-6 shrink-0 items-center justify-center rounded-full border border-primary bg-card text-xs font-semibold tabular-nums text-foreground"
              >
                {number}
              </span>
            )}
            {editable && barEditor ? (
              <h3 className="min-w-0 flex-1 basis-16">
                <ValueButton
                  label="Name"
                  className={cn("break-words text-sm font-medium", titleError && "decoration-destructive")}
                  edit={{
                    description: titleLabel ?? "Name",
                    value: title,
                    inputMode: "text",
                    validate: titleValidate,
                    onCommit: (value) => onTitleChange?.(value),
                  }}
                >
                  {title || <span className="text-muted-foreground">No name</span>}
                </ValueButton>
              </h3>
            ) : editable ? (
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
            {onQuantityChange && !disabled && barEditor ? (
              <ValueButton
                label="Quantity"
                className="ml-auto shrink-0 justify-end text-sm tabular-nums"
                edit={{
                  description: `Quantity of ${title || "this row"}`,
                  value: quantity == null ? "" : String(quantity),
                  inputMode: "numeric",
                  validate: quantityValidate,
                  onCommit: (value) => onQuantityChange(value),
                }}
              >
                <span aria-hidden="true" className="text-muted-foreground">×</span>
                {quantity == null || quantity === "" ? "?" : quantity}
              </ValueButton>
            ) : onQuantityChange && !disabled ? (
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
          {/* Warnings and errors are written in the text colour; the icon carries the
              warning colour. So they stay readable on the selected background too. */}
          {titleError && (
            <p id={`${ids}-title-error`} role="alert" className="flex items-start gap-1.5 text-xs font-medium text-foreground">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              <span className="min-w-0 break-words">{titleError}</span>
            </p>
          )}
          {quantityError && (
            <p id={`${ids}-quantity-error`} role="alert" className="flex items-start gap-1.5 text-xs font-medium text-foreground">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              <span className="min-w-0 break-words">{quantityError}</span>
            </p>
          )}
          {checks.length > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-foreground">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-brass" />
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
                      entry.uncertain && "rounded bg-brass-soft/60 px-1",
                    )}
                  >
                    {entry.edit && !disabled ? (
                      <ValueButton label={entry.label} edit={entry.edit}>{entry.value}</ValueButton>
                    ) : entry.value}
                  </span>
                  {entry.uncertain && <span className="ml-1 font-medium text-foreground">· check</span>}
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="flex items-start gap-1.5 text-xs font-medium text-foreground">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
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
        // The editor keeps the normal surface colour, also when the row is selected.
        <div id={`${ids}-more`} className="space-y-5 border-t border-border/60 bg-card p-3 sm:p-4">
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
