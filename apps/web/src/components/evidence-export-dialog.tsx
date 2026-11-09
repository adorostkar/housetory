import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Ban,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import * as React from "react";

import { FormError } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  queryKeys,
  useEvidenceExport,
  useEvidenceExports,
  useEvidencePreview,
} from "@/lib/queries";
import type {
  EvidenceDocumentPreview,
  EvidenceExportRecord,
  EvidenceExportStatus,
  EvidenceOptions,
  EvidenceScope,
} from "@/lib/types";
import {
  formatCurrency,
  formatDate,
  formatFileSize,
  pluralize,
} from "@/lib/utils";

const DEFAULT_OPTIONS: EvidenceOptions = {
  include_photos: true,
  include_receipts: true,
  include_warranty_documents: true,
  include_manuals: false,
  include_other_documents: false,
  include_document_originals: true,
  include_csv: true,
  include_attachments: true,
  excluded_document_ids: [],
};

const STATUS_LABELS: Record<EvidenceExportStatus, string> = {
  queued: "Queued",
  running: "Generating",
  succeeded: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
};

const STATUS_TONES: Record<
  EvidenceExportStatus,
  "sage" | "outline" | "brass" | "destructive" | "secondary"
> = {
  queued: "outline",
  running: "brass",
  succeeded: "sage",
  failed: "destructive",
  cancelled: "secondary",
  expired: "brass",
};

function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function scopeKey(scope: EvidenceScope) {
  return JSON.stringify(scope);
}

export function EvidenceExportDialog({
  open,
  onOpenChange,
  scope,
  title = "Export inventory with evidence",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: EvidenceScope;
  title?: string;
}) {
  const queryClient = useQueryClient();
  const [options, setOptions] = React.useState<EvidenceOptions>(DEFAULT_OPTIONS);
  const [includeArchived, setIncludeArchived] = React.useState(false);
  const [activeExportId, setActiveExportId] = React.useState<string | null>(null);
  const requestId = React.useRef(newRequestId());
  const lastPreviewFingerprint = React.useRef<string | null>(null);
  const currentScopeKey = scopeKey(scope);

  React.useEffect(() => {
    if (!open) {
      setActiveExportId(null);
      setIncludeArchived(false);
      setOptions(DEFAULT_OPTIONS);
      requestId.current = newRequestId();
      lastPreviewFingerprint.current = null;
    }
    // Reset only when the dialog opens or the requested scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentScopeKey]);

  const previewQuery = useEvidencePreview(scope, includeArchived, options, open);
  const preview = previewQuery.data;

  React.useEffect(() => {
    if (!preview?.fingerprint) return;
    if (lastPreviewFingerprint.current === preview.fingerprint) return;
    lastPreviewFingerprint.current = preview.fingerprint;
    requestId.current = newRequestId();
  }, [preview?.fingerprint]);
  const activeQuery = useEvidenceExport(activeExportId ?? undefined, open);
  const recentQuery = useEvidenceExports(open);
  const active = activeQuery.data ?? null;

  React.useEffect(() => {
    if (
      active &&
      ["succeeded", "failed", "cancelled", "expired"].includes(active.status)
    ) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.evidenceExports });
    }
  }, [active?.id, active?.status, queryClient]);

  const create = useMutation({
    mutationFn: () =>
      api.post<EvidenceExportRecord>("/evidence-exports", {
        scope,
        include_archived: includeArchived,
        options,
        fingerprint: preview?.fingerprint,
        request_id: requestId.current,
      }),
    onSuccess: (record) => {
      setActiveExportId(record.id);
      queryClient.setQueryData(queryKeys.evidenceExport(record.id), record);
      void queryClient.invalidateQueries({ queryKey: queryKeys.evidenceExports });
    },
    onError: () => {
      void previewQuery.refetch();
    },
  });

  const cancel = useMutation({
    mutationFn: (exportId: string) =>
      api.post<EvidenceExportRecord>(`/evidence-exports/${exportId}/cancel`),
    onSuccess: (record) => {
      queryClient.setQueryData(queryKeys.evidenceExport(record.id), record);
      void queryClient.invalidateQueries({ queryKey: queryKeys.evidenceExports });
    },
  });

  const retry = useMutation({
    mutationFn: (exportId: string) =>
      api.post<EvidenceExportRecord>(`/evidence-exports/${exportId}/retry`),
    onSuccess: (record) => {
      queryClient.setQueryData(queryKeys.evidenceExport(record.id), record);
      setActiveExportId(record.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.evidenceExports });
    },
  });

  const updateOption = <K extends keyof EvidenceOptions>(
    key: K,
    value: EvidenceOptions[K],
  ) => {
    setOptions((current) => ({ ...current, [key]: value }));
  };

  const toggleDocument = (document: EvidenceDocumentPreview) => {
    setOptions((current) => {
      const excluded = new Set(current.excluded_document_ids);
      if (document.included) excluded.add(document.id);
      else excluded.delete(document.id);
      return { ...current, excluded_document_ids: [...excluded] };
    });
  };

  const categoryEnabled = (document: EvidenceDocumentPreview) => {
    if (document.evidence_kind === "receipt") return options.include_receipts;
    if (document.evidence_kind === "warranty") return options.include_warranty_documents;
    if (document.evidence_kind === "manual") return options.include_manuals;
    return options.include_other_documents;
  };

  const previewBusy = previewQuery.isFetching;
  const canGenerate =
    Boolean(preview?.can_generate) &&
    !previewBusy &&
    !create.isPending &&
    Boolean(preview?.fingerprint);

  const record = active ?? null;
  const downloadBase = record ? `/api/v1/evidence-exports/${record.id}` : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Build a standalone PDF report, optional CSV and an optional originals bundle from
            the current recorded facts. This is not a stocktake, appraisal or insurance
            guarantee.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto overscroll-contain pr-1">
          <section className="rounded-xl border border-border/70 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Scope preview
                </p>
                <p className="mt-1 break-words text-sm font-medium">
                  {preview?.scope_label ?? "Preparing scope…"}
                </p>
                {preview && (
                  <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
                    {pluralize(preview.item_count, "item")} ·{" "}
                    {pluralize(preview.unit_count, "unit")} · at home{" "}
                    {preview.at_home_unit_count} · recorded on loan{" "}
                    {preview.on_loan_unit_count}
                  </p>
                )}
                <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
                  Borrowed-from-others records and their private photos are excluded. This
                  package covers household-owned inventory only.
                </p>
              </div>
              <label className="flex items-center gap-2 text-2xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-4 accent-[hsl(var(--primary))]"
                  checked={includeArchived}
                  onChange={(event) => setIncludeArchived(event.target.checked)}
                />
                Include archived items
              </label>
            </div>
            {previewQuery.isPending && (
              <div className="mt-3 flex items-center gap-2 text-2xs text-muted-foreground">
                <Spinner />
                Reading recorded inventory and evidence…
              </div>
            )}
            {previewQuery.error && <FormError message={getApiErrorMessage(previewQuery.error)} />}
            {preview && preview.items.length > 0 && (
              <ul className="mt-3 max-h-32 space-y-1 overflow-y-auto rounded-lg border border-border/60 bg-secondary/15 px-3 py-2 text-2xs">
                {preview.items.slice(0, 12).map((entry) => (
                  <li key={entry.id} className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
                    <span className="min-w-0 break-words">
                      {entry.name}
                      {entry.is_archived ? " (archived)" : ""}
                    </span>
                    <span className="text-muted-foreground">
                      {entry.quantity} unit{entry.quantity === 1 ? "" : "s"} ·{" "}
                      {entry.full_location_path}
                    </span>
                  </li>
                ))}
                {preview.items.length > 12 && (
                  <li className="text-muted-foreground">
                    + {preview.items.length - 12} more item(s)
                  </li>
                )}
              </ul>
            )}
            {preview && preview.item_count === 0 && (
              <p className="mt-3 rounded-lg border border-dashed border-border/70 px-3 py-4 text-center text-2xs text-muted-foreground">
                No items are in this selection. Choose another room, container or item.
              </p>
            )}
          </section>

          {preview && (
            <section className="rounded-xl border border-border/70 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    Evidence and formats
                  </p>
                  <p className="mt-1 text-2xs text-muted-foreground">
                    PDF is always included. Supporting originals are optional and may be large.
                  </p>
                </div>
                {previewBusy && (
                  <span className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    Updating preview
                  </span>
                )}
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <OptionCheck
                  label="Item photos"
                  hint={`${pluralize(preview.photo_count, "stored photo")}`}
                  checked={options.include_photos}
                  onChange={(value) => updateOption("include_photos", value)}
                />
                <OptionCheck
                  label="Receipts and invoices"
                  hint={
                    preview.documents.filter((entry) => entry.evidence_kind === "receipt")
                      .length + " found"
                  }
                  checked={options.include_receipts}
                  onChange={(value) => updateOption("include_receipts", value)}
                />
                <OptionCheck
                  label="Warranty documents"
                  hint={
                    preview.documents.filter((entry) => entry.evidence_kind === "warranty")
                      .length + " found"
                  }
                  checked={options.include_warranty_documents}
                  onChange={(value) => updateOption("include_warranty_documents", value)}
                />
                <OptionCheck
                  label="Manuals and specifications"
                  hint="Excluded by default to avoid huge bundles"
                  checked={options.include_manuals}
                  onChange={(value) => updateOption("include_manuals", value)}
                />
                <OptionCheck
                  label="Other documents"
                  hint="Supporting files not classified above"
                  checked={options.include_other_documents}
                  onChange={(value) => updateOption("include_other_documents", value)}
                />
                <OptionCheck
                  label="Spreadsheet CSV"
                  hint="UTF-8, formula-safe, item rows"
                  checked={options.include_csv}
                  onChange={(value) => updateOption("include_csv", value)}
                />
                <OptionCheck
                  label="Attachment ZIP"
                  hint="PDF, CSV, evidence and manifest"
                  checked={options.include_attachments}
                  onChange={(value) => updateOption("include_attachments", value)}
                />
                <OptionCheck
                  label="Exact originals"
                  hint="Original upload bytes when available"
                  checked={options.include_document_originals}
                  onChange={(value) => updateOption("include_document_originals", value)}
                  disabled={!options.include_attachments}
                />
              </div>

              {preview.documents.length > 0 && (
                <div className="mt-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-2xs font-medium">Supporting documents</p>
                    <p className="text-2xs text-muted-foreground">
                      {preview.included_document_count} of {preview.document_count} included
                    </p>
                  </div>
                  <ul className="mt-2 max-h-56 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border/60">
                    {preview.documents.map((document) => {
                      const categoryOn = categoryEnabled(document);
                      return (
                        <li
                          key={document.id}
                          className="flex items-start gap-3 px-3 py-2.5 text-2xs"
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
                            checked={document.included}
                            disabled={!categoryOn}
                            onChange={() => toggleDocument(document)}
                            aria-label={`Include ${document.title}`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="break-words font-medium">{document.title}</span>
                              <Badge variant="outline">
                                {document.evidence_kind === "receipt"
                                  ? "Receipt"
                                  : document.evidence_kind === "warranty"
                                    ? "Warranty"
                                    : document.evidence_kind === "manual"
                                      ? "Manual"
                                      : "Document"}
                              </Badge>
                              {document.shared_with_unselected && (
                                <Badge variant="brass">Also linked elsewhere</Badge>
                              )}
                              {document.scan_page_count > 0 && (
                                <Badge variant="secondary">
                                  {document.scan_page_count} scan pages
                                </Badge>
                              )}
                            </div>
                            <p className="mt-0.5 text-2xs text-muted-foreground">
                              {document.merchant ? `${document.merchant} · ` : ""}
                              {formatFileSize(document.original_byte_size)} original ·{" "}
                              {categoryOn ? "category included" : "category excluded"}
                              {document.evidence_kind === "receipt"
                                ? " · receipts may contain other products or personal information"
                                : ""}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border/60 bg-secondary/15 px-3 py-2 text-2xs">
                  <p className="font-medium">Package estimate</p>
                  <p className="mt-1 text-muted-foreground">
                    Evidence files about {formatFileSize(preview.bundle_estimated_bytes)} ·
                    limit {formatFileSize(preview.max_bundle_bytes)}
                  </p>
                  {!preview.bundle_within_limit && (
                    <p className="mt-1 text-brass">
                      Exclude manuals, originals or photos to stay within the limit.
                    </p>
                  )}
                </div>
                <div className="rounded-lg border border-border/60 bg-secondary/15 px-3 py-2 text-2xs">
                  <p className="font-medium">Value semantics</p>
                  <p className="mt-1 text-muted-foreground">
                    Currencies stay separate. Current estimate totals multiply per-unit
                    estimates by owned quantity; legacy record totals count once. Selected
                    allocations are not shared purchase transaction totals.
                  </p>
                </div>
              </div>

              {preview.currency_totals.length > 0 && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[420px] text-2xs">
                    <thead>
                      <tr className="border-b border-border/60 text-left text-muted-foreground">
                        <th className="py-1.5 pr-3 font-medium">Currency</th>
                        <th className="py-1.5 pr-3 font-medium">Selected allocations</th>
                        <th className="py-1.5 font-medium">Current estimate totals</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.currency_totals.map((entry) => (
                        <tr key={entry.currency} className="border-b border-border/40">
                          <td className="py-1.5 pr-3">{entry.currency}</td>
                          <td className="py-1.5 pr-3 tabular-nums">
                            {formatCurrency(
                              entry.selected_allocated_purchase_cents,
                              entry.currency,
                            )}{" "}
                            <span className="text-muted-foreground">
                              ({pluralize(entry.allocated_item_count, "item")})
                            </span>
                          </td>
                          <td className="py-1.5 tabular-nums">
                            {formatCurrency(entry.current_value_total_cents, entry.currency)}{" "}
                            <span className="text-muted-foreground">
                              ({pluralize(entry.current_value_item_count, "item")})
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {preview.warnings.length > 0 && (
                <ul className="mt-3 space-y-1 rounded-lg border border-brass/20 bg-brass-soft/25 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                  {preview.warnings.map((warning, index) => (
                    <li key={`${warning}-${index}`} className="flex gap-1.5">
                      <ShieldCheck className="mt-0.5 size-3 shrink-0" />
                      <span>{warning}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {(create.error || cancel.error || retry.error) && (
            <FormError
              message={getApiErrorMessage(create.error ?? cancel.error ?? retry.error)}
            />
          )}

          {record && (
            <section className="rounded-xl border border-border/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-2xs font-semibold">Evidence package</p>
                    <Badge variant={STATUS_TONES[record.status]}>
                      {STATUS_LABELS[record.status]}
                    </Badge>
                  </div>
                  <p className="mt-1 break-all text-2xs text-muted-foreground">
                    {record.id}
                  </p>
                  <p className="mt-1 text-2xs text-muted-foreground">
                    {pluralize(record.item_count, "item")} ·{" "}
                    {pluralize(record.unit_count, "unit")} · generated{" "}
                    {formatDate(record.created_at)}
                  </p>
                  {record.expires_at && (
                    <p className="mt-0.5 text-2xs text-muted-foreground">
                      Private download expires {formatDate(record.expires_at)}
                    </p>
                  )}
                </div>
                {record.can_manage &&
                  (record.status === "queued" || record.status === "running") && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => cancel.mutate(record.id)}
                      disabled={cancel.isPending}
                    >
                      {cancel.isPending ? <Spinner /> : <Ban />}
                      Cancel
                    </Button>
                  )}
              </div>

              {(record.status === "queued" || record.status === "running") && (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/15 px-3 py-2 text-2xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Preparing the PDF, CSV and evidence bundle. This runs in the background.
                </div>
              )}

              {record.status === "failed" && (
                <div className="mt-3 space-y-2">
                  <p className="rounded-lg border border-destructive/20 bg-destructive/[0.06] px-3 py-2 text-2xs text-destructive">
                    {record.error ?? "The evidence package could not be generated."}
                  </p>
                  {record.can_manage && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => retry.mutate(record.id)}
                      disabled={retry.isPending}
                    >
                      {retry.isPending ? <Spinner /> : <RefreshCw />}
                      Retry generation
                    </Button>
                  )}
                </div>
              )}

              {record.status === "cancelled" && record.can_manage && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => retry.mutate(record.id)}
                  disabled={retry.isPending}
                >
                  {retry.isPending ? <Spinner /> : <RefreshCw />}
                  Generate again
                </Button>
              )}

              {record.status === "expired" && (
                <div className="mt-3 space-y-2">
                  <p className="text-2xs text-muted-foreground">
                    This private package expired and its generated files were removed. The
                    source inventory and evidence were not changed.
                  </p>
                  {record.can_manage && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => retry.mutate(record.id)}
                      disabled={retry.isPending}
                    >
                      {retry.isPending ? <Spinner /> : <RefreshCw />}
                      Generate again
                    </Button>
                  )}
                </div>
              )}

              {record.status === "succeeded" && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {record.pdf_available && (
                    <Button type="button" size="sm" variant="outline" asChild>
                      <a href={`${downloadBase}/pdf`}>
                        <FileText />
                        Download PDF
                      </a>
                    </Button>
                  )}
                  {record.csv_available && (
                    <Button type="button" size="sm" variant="outline" asChild>
                      <a href={`${downloadBase}/csv`}>
                        <FileSpreadsheet />
                        Download CSV
                      </a>
                    </Button>
                  )}
                  {record.bundle_available && (
                    <Button type="button" size="sm" variant="outline" asChild>
                      <a href={`${downloadBase}/bundle`}>
                        <Archive />
                        Download evidence ZIP
                      </a>
                    </Button>
                  )}
                </div>
              )}

              {record.warnings.length > 0 && (
                <ul className="mt-3 space-y-1 rounded-lg border border-brass/20 bg-brass-soft/25 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                  {record.warnings.map((warning, index) => (
                    <li key={`${warning}-${index}`}>{warning}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {recentQuery.data && recentQuery.data.items.length > 0 && (
            <section className="rounded-xl border border-border/70 p-4">
              <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Recent evidence packages
              </p>
              <ul className="mt-2 divide-y divide-border/40">
                {recentQuery.data.items.slice(0, 6).map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-2 py-2 text-2xs">
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setActiveExportId(entry.id)}
                    >
                      <span className="break-words font-medium">{entry.scope_label}</span>
                      <span className="mt-0.5 block text-2xs text-muted-foreground">
                        {pluralize(entry.item_count, "item")} ·{" "}
                        {formatDate(entry.created_at)} · {STATUS_LABELS[entry.status]}
                      </span>
                    </button>
                    <Badge variant={STATUS_TONES[entry.status]}>
                      {STATUS_LABELS[entry.status]}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          )}

        </div>

        <DialogFooter>
          <div className="mr-auto flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            Private, signed-in download only. No automatic sharing.
          </div>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            type="button"
            onClick={() => create.mutate()}
            disabled={!canGenerate}
          >
            {create.isPending ? <Spinner /> : <Download />}
            Generate package
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OptionCheck({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-2.5 rounded-lg border border-border/60 px-3 py-2.5 text-2xs ${
        disabled ? "opacity-55" : "cursor-pointer"
      }`}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        {hint && (
          <span className="mt-0.5 block text-2xs leading-relaxed text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}
