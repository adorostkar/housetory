import { ChevronDown, FileText, Link2 } from "lucide-react";
import * as React from "react";

import { Field } from "@/components/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DOCUMENT_TYPE_OPTIONS } from "@/lib/labels";
import type { DocumentType } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The optional steps of adding a document. They are shared by upload and scan. */

export function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!file || typeof URL.createObjectURL !== "function") {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

/** A closed row that opens one optional step. It never hides an error: pass `forceOpen`. */
export function OptionalStep({
  title,
  summary,
  defaultOpen = false,
  forceOpen = false,
  children,
}: {
  title: string;
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const id = React.useId();
  const shown = open || forceOpen;
  return (
    <div className="rounded-xl border border-border/70 bg-card/40">
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3.5 py-2 text-left transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium lg:text-xs">{title}</span>
          {summary && (
            <span className="block truncate text-xs text-muted-foreground lg:text-2xs">{summary}</span>
          )}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", shown && "rotate-180")}
        />
      </button>
      {shown && (
        <div id={id} className="space-y-4 border-t border-border/60 px-3.5 py-3.5">
          {children}
        </div>
      )}
    </div>
  );
}

/** Says which item the document belongs to when the user started from that item. */
export function AttachedItemChip({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <p className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border border-sage/30 bg-sage-soft/50 px-3 py-1 text-xs">
      <Link2 aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        Attached to: <span className="font-medium">{names.join(", ")}</span>
      </span>
    </p>
  );
}

export interface DocumentDetailsDraft {
  title: string;
  documentType: DocumentType;
  merchant: string;
  documentDate: string;
  notes: string;
}

export function DocumentDetailsFields({
  idPrefix,
  value,
  onChange,
  manualMode = false,
  disabled = false,
}: {
  idPrefix: string;
  value: DocumentDetailsDraft;
  onChange: (next: DocumentDetailsDraft) => void;
  manualMode?: boolean;
  disabled?: boolean;
}) {
  const set = (patch: Partial<DocumentDetailsDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {!manualMode && (
        <Field label="Type" htmlFor={`${idPrefix}-type`}>
          <Select
            id={`${idPrefix}-type`}
            value={value.documentType}
            disabled={disabled}
            onChange={(event) => set({ documentType: event.target.value as DocumentType })}
          >
            {DOCUMENT_TYPE_OPTIONS.map(([type, label]) => (
              <option key={type} value={type}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Title" htmlFor={`${idPrefix}-title`} optional>
        <Input
          id={`${idPrefix}-title`}
          maxLength={200}
          value={value.title}
          disabled={disabled}
          onChange={(event) => set({ title: event.target.value })}
          placeholder={manualMode ? "Cordless drill manual" : "Purchase receipt"}
        />
      </Field>
      {!manualMode && (
        <Field label="Merchant" htmlFor={`${idPrefix}-merchant`} optional>
          <Input
            id={`${idPrefix}-merchant`}
            maxLength={160}
            value={value.merchant}
            disabled={disabled}
            onChange={(event) => set({ merchant: event.target.value })}
            placeholder="Where it came from"
          />
        </Field>
      )}
      {!manualMode && (
        <Field label="Document date" htmlFor={`${idPrefix}-date`} optional>
          <Input
            id={`${idPrefix}-date`}
            type="date"
            value={value.documentDate}
            disabled={disabled}
            onChange={(event) => set({ documentDate: event.target.value })}
          />
        </Field>
      )}
      <div className="sm:col-span-2">
        <Field label="Notes" htmlFor={`${idPrefix}-notes`} optional>
          <Textarea
            id={`${idPrefix}-notes`}
            maxLength={4000}
            value={value.notes}
            disabled={disabled}
            onChange={(event) => set({ notes: event.target.value })}
            placeholder="Return window, what the manual covers, anything worth finding later."
          />
        </Field>
      </div>
    </div>
  );
}

/** A small preview: the picture itself for an image, a file mark for anything else. */
export function DocumentFilePreview({
  url,
  name,
  detail,
}: {
  url: string | null;
  name: string;
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-secondary/20 p-3">
      {url ? (
        <img
          src={url}
          alt={`Preview of ${name}`}
          className="size-16 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <span className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
          <FileText aria-hidden="true" className="size-6" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium lg:text-xs">{name}</span>
        {detail && <span className="mt-0.5 block text-xs text-muted-foreground lg:text-2xs">{detail}</span>}
      </span>
    </div>
  );
}
