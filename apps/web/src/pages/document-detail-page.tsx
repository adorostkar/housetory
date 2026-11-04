import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Download,
  FileText,
  Link2,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorState } from "@/components/error-state";
import { Field, FormError } from "@/components/form-field";
import { ItemMultiSelect } from "@/components/item-multi-select";
import { PageHeader } from "@/components/page-header";
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
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import {
  CURRENCIES,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPE_OPTIONS,
  OCR_STATUS_LABELS,
  isImageContentType,
} from "@/lib/labels";
import {
  queryKeys,
  useCanWrite,
  useDocument,
  useDocumentRelations,
  useInvalidateInventory,
  useItem,
} from "@/lib/queries";
import type {
  DocumentRecord,
  DocumentType,
  OcrApplyResponse,
} from "@/lib/types";
import { formatDate, formatFileSize, pluralize } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";

export function DocumentDetailPage() {
  const { documentId = "" } = useParams();
  const documentQuery = useDocument(documentId);
  const relationsQuery = useDocumentRelations(documentId);
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [suggestedToLink, setSuggestedToLink] = React.useState<string[]>([]);

  const retry = useMutation({
    mutationFn: () => api.post<DocumentRecord>(`/documents/${documentId}/ocr`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.document(documentId) });
      toast.success("OCR queued");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const linkSuggestions = useMutation({
    mutationFn: (itemIds: string[]) =>
      api.patch<DocumentRecord>(`/documents/${documentId}`, { item_ids: itemIds }),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.document(documentId),
      });
      void queryClient.invalidateQueries({
        queryKey: [...queryKeys.document(documentId), "relations"],
      });
      toast.success("Items linked");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: () => api.delete<void>(`/documents/${documentId}`),
    onSuccess: () => {
      invalidate();
      toast.success("Document deleted");
      navigate("/documents", { replace: true });
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const linkedIds = new Set(
    (documentQuery.data?.items ?? []).map((item) => item.id),
  );
  const suggestions = (relationsQuery.data?.items ?? []).filter(
    (suggestion) => !linkedIds.has(suggestion.item.id),
  );

  React.useEffect(() => {
    setSuggestedToLink(suggestions.map((suggestion) => suggestion.item.id));
    // Suggest newly detected items by default, but never overwrite a choice while
    // the user is reviewing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relationsQuery.dataUpdatedAt]);

  if (documentQuery.isPending) return <DocumentDetailSkeleton />;
  if (documentQuery.isError) {
    return (
      <ErrorState
        title="This document is out of reach"
        message="It may have been deleted, or the link may be out of date."
        onRetry={() => void documentQuery.refetch()}
      />
    );
  }
  const document = documentQuery.data;
  if (!document) return <DocumentDetailSkeleton />;
  const busy = retry.isPending || remove.isPending;

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow={DOCUMENT_TYPE_LABELS[document.document_type]}
        title={document.title}
        description={[
          document.merchant,
          document.document_date ? formatDate(document.document_date) : null,
          document.original_filename,
        ]
          .filter(Boolean)
          .join(" · ")}
        backTo="/documents"
        backLabel="Documents"
        actions={
          <>
            <Button variant="outline" asChild>
              <a href={document.url}>
                <Download />
                Download
              </a>
            </Button>
            <Button variant="outline" asChild>
              <a href={document.original_url}>
                <FileText />
                Original
              </a>
            </Button>
            {canWrite && (
              <>
                <Button variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Delete document"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 />
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="grid items-start gap-7 xl:grid-cols-[minmax(0,1.35fr)_minmax(330px,1fr)]">
        <div className="space-y-6">
          <section className="surface overflow-hidden">
            {isImageContentType(document.content_type) ? (
              <div className="flex max-h-[70vh] items-center justify-center bg-secondary/30 p-4">
                <img
                  src={document.url}
                  alt={document.title}
                  className="max-h-[65vh] max-w-full rounded-lg object-contain shadow-sm"
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                <span className="flex size-14 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                  <FileText className="size-6" strokeWidth={1.5} />
                </span>
                <p className="mt-4 font-display text-xl tracking-[-0.02em]">
                  {document.original_filename}
                </p>
                <p className="mt-1 text-[0.75rem] text-muted-foreground">
                  {formatFileSize(document.byte_size)} · {document.content_type}
                </p>
                <Button className="mt-5" asChild>
                  <a href={document.url}>
                    <Download />
                    Download document
                  </a>
                </Button>
              </div>
            )}
          </section>

          <section className="surface p-5 sm:p-6">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-brass" strokeWidth={1.7} />
              <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
                Extraction review
              </h2>
            </div>
            <p className="mt-1.5 text-[0.78rem] leading-relaxed text-muted-foreground">
              OCR proposes values only. Your inventory changes after you confirm
              them below.
            </p>
            <OcrReview document={document} />
          </section>

          {document.extracted_text && (
            <details className="surface p-5 sm:p-6">
              <summary className="cursor-pointer text-[0.8rem] font-medium">
                Extracted text
                <span className="ml-2 text-[0.7rem] font-normal text-muted-foreground">
                  {document.extracted_text.length.toLocaleString()} characters
                </span>
              </summary>
              <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-secondary/40 p-4 text-[0.72rem] leading-relaxed text-muted-foreground">
                {document.extracted_text}
              </pre>
            </details>
          )}
        </div>

        <aside className="space-y-4">
          <section className="surface p-5">
            <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              Metadata
            </h2>
            <dl className="mt-4 space-y-3 text-[0.8rem]">
              <MetadataRow label="Type" value={DOCUMENT_TYPE_LABELS[document.document_type]} />
              <MetadataRow label="Merchant" value={document.merchant ?? "—"} />
              <MetadataRow
                label="Document date"
                value={document.document_date ? formatDate(document.document_date) : "—"}
              />
              <MetadataRow label="File" value={document.original_filename} />
              <MetadataRow
                label="Size"
                value={`${formatFileSize(document.byte_size)} · original ${formatFileSize(
                  document.original_byte_size,
                )}`}
              />
              <MetadataRow label="Added" value={formatDate(document.created_at)} />
            </dl>
            {document.notes && (
              <p className="mt-4 whitespace-pre-line border-t border-border/60 pt-4 text-[0.78rem] leading-relaxed text-muted-foreground">
                {document.notes}
              </p>
            )}
            <div className="mt-4 border-t border-border/60 pt-4">
              <div className="flex items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                <Link2 className="size-3.5" />
                Linked items
              </div>
              {document.items.length === 0 ? (
                <p className="mt-2 text-[0.78rem] text-muted-foreground">
                  No items linked yet.
                </p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {document.items.map((item) => (
                    <Link key={item.id} to={`/items/${item.id}`}>
                      <Badge variant="secondary" className="hover:bg-secondary/70">
                        {item.name}
                      </Badge>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </section>

          {suggestions.length > 0 && (
            <section className="surface p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                    Suggested items
                  </h2>
                  <p className="mt-1 text-[0.68rem] text-muted-foreground">
                    Matched from extracted text, serials and merchant information.
                  </p>
                </div>
                <Badge variant="brass">{suggestions.length}</Badge>
              </div>
              <div className="mt-3 space-y-2">
                {suggestions.map((suggestion) => {
                  const selected = suggestedToLink.includes(suggestion.item.id);
                  return (
                    <label
                      key={suggestion.item.id}
                      className="flex items-start gap-2 rounded-lg border border-border/60 px-3 py-2 text-[0.75rem]"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-3.5 accent-primary"
                        checked={selected}
                        disabled={linkSuggestions.isPending}
                        onChange={(event) =>
                          setSuggestedToLink((current) =>
                            event.target.checked
                              ? [...current, suggestion.item.id]
                              : current.filter((id) => id !== suggestion.item.id),
                          )
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <Link
                          to={`/items/${suggestion.item.id}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {suggestion.item.name}
                        </Link>
                        <span className="block text-[0.66rem] text-muted-foreground">
                          {suggestion.reasons.join(" · ")} · {suggestion.score}% match
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                disabled={linkSuggestions.isPending || suggestedToLink.length === 0}
                onClick={() => {
                  linkSuggestions.mutate([
                    ...document.items.map((item) => item.id),
                    ...suggestedToLink,
                  ]);
                }}
              >
                {linkSuggestions.isPending ? <Spinner /> : <Link2 />}
                Link selected items
              </Button>
            </section>
          )}

          <section className="surface p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                Local OCR
              </h2>
              <Badge
                variant={
                  document.ocr_status === "succeeded"
                    ? "sage"
                    : document.ocr_status === "failed"
                      ? "destructive"
                      : document.ocr_status === "queued" ||
                          document.ocr_status === "processing"
                        ? "brass"
                        : "outline"
                }
              >
                {OCR_STATUS_LABELS[document.ocr_status]}
              </Badge>
            </div>
            {document.ocr_status === "queued" || document.ocr_status === "processing" ? (
              <p className="mt-3 flex items-center gap-2 text-[0.78rem] text-muted-foreground">
                <Spinner className="size-3.5" />
                The worker is reading this document on your server. This page updates
                automatically.
              </p>
            ) : document.ocr_status === "failed" ? (
              <div className="mt-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3">
                <p className="flex items-center gap-1.5 text-[0.75rem] font-medium text-destructive">
                  <AlertTriangle className="size-3.5" /> Extraction failed
                </p>
                <p className="mt-1 break-words text-[0.72rem] leading-relaxed text-muted-foreground">
                  {document.ocr_error ?? "The worker could not read this file."}
                </p>
              </div>
            ) : document.ocr_status === "succeeded" ? (
              <>
              <p className="mt-3 text-[0.78rem] leading-relaxed text-muted-foreground">
                {document.ocr_confidence != null
                  ? `${document.ocr_confidence}% mean confidence. `
                  : "Read from embedded PDF text. "}
                {document.extracted_metadata.processing_mode === "local"
                  ? "Local AI normalized supported fields. "
                  : document.extracted_metadata.processing_mode === "private" ||
                      document.extracted_metadata.processing_mode === "cloud"
                    ? "Remote AI normalized supported fields. "
                    : "Deterministic extraction only. "}
                Check the proposed values before applying them.
              </p>
              {Array.isArray(document.extracted_metadata.ai_warnings) &&
              document.extracted_metadata.ai_warnings.length > 0 ? (
                <div className="mt-2 rounded-lg border border-brass/20 bg-brass-soft/50 px-3 py-2 text-[0.7rem] leading-relaxed text-muted-foreground">
                  {document.extracted_metadata.ai_warnings
                    .slice(0, 5)
                    .map((warning) => String(warning))
                    .join(" ")}
                </div>
              ) : null}
              </>
            ) : (
              <p className="mt-3 text-[0.78rem] leading-relaxed text-muted-foreground">
                No OCR run yet. Start one to propose fields from this document.
              </p>
            )}
            {canWrite && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                disabled={
                  busy ||
                  document.ocr_status === "queued" ||
                  document.ocr_status === "processing"
                }
                onClick={() => retry.mutate()}
              >
                {retry.isPending ? <Spinner /> : <RefreshCw />}
                {document.ocr_status === "succeeded" ? "Run OCR again" : "Run OCR"}
              </Button>
            )}
          </section>

          <section className="surface p-5">
            <h2 className="flex items-center gap-2 text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              <ShieldCheck className="size-3.5" /> File safety
            </h2>
            <ul className="mt-3 space-y-2 text-[0.72rem] leading-relaxed text-muted-foreground">
              <li>Downloads are authenticated and never cached by the browser.</li>
              <li>The original upload is kept byte-for-byte for your records.</li>
              <li>Image downloads are re-encoded with metadata stripped.</li>
              <li>PDFs and text files are validated before they are stored.</li>
            </ul>
          </section>
        </aside>
      </div>

      <EditDocumentDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        document={document}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this document?"
        description="The original upload and safe download copy will be removed, and the document will be detached from every item and purchase. This cannot be undone."
        confirmLabel="Delete document"
        onConfirm={async () => {
          await remove.mutateAsync();
        }}
      />
    </div>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right">{value}</dd>
    </div>
  );
}

function EditDocumentDialog({
  open,
  onOpenChange,
  document,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: DocumentRecord;
}) {
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const [title, setTitle] = React.useState(document.title);
  const [documentType, setDocumentType] = React.useState<DocumentType>(
    document.document_type,
  );
  const [merchant, setMerchant] = React.useState(document.merchant ?? "");
  const [documentDate, setDocumentDate] = React.useState(document.document_date ?? "");
  const [notes, setNotes] = React.useState(document.notes ?? "");
  const [itemIds, setItemIds] = React.useState(document.items.map((item) => item.id));

  React.useEffect(() => {
    if (!open) return;
    setTitle(document.title);
    setDocumentType(document.document_type);
    setMerchant(document.merchant ?? "");
    setDocumentDate(document.document_date ?? "");
    setNotes(document.notes ?? "");
    setItemIds(document.items.map((item) => item.id));
    // Initialise once when the dialog opens; background OCR polling must not
    // overwrite fields the user is editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id, open]);

  const save = useMutation({
    mutationFn: () =>
      api.patch<DocumentRecord>(`/documents/${document.id}`, {
        title: title.trim(),
        document_type: documentType,
        merchant: merchant.trim() || null,
        document_date: documentDate || null,
        notes: notes.trim() || null,
        item_ids: itemIds,
      }),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.document(document.id),
      });
      toast.success("Document updated");
      onOpenChange(false);
    },
  });

  const fieldErrors = save.error instanceof ApiError ? save.error.fields : undefined;

  return (
    <Dialog open={open} onOpenChange={(next) => !save.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit document</DialogTitle>
          <DialogDescription>
            Correct its metadata or change which items it belongs to.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim()) save.mutate();
          }}
        >
          {save.error && <FormError message={getApiErrorMessage(save.error)} />}
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Title" htmlFor="edit-document-title" error={fieldErrors?.title}>
              <Input
                id="edit-document-title"
                value={title}
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field label="Type" htmlFor="edit-document-type">
              <Select
                id="edit-document-type"
                value={documentType}
                onChange={(event) => setDocumentType(event.target.value as DocumentType)}
              >
                {DOCUMENT_TYPE_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Merchant" htmlFor="edit-document-merchant" optional>
              <Input
                id="edit-document-merchant"
                value={merchant}
                maxLength={160}
                onChange={(event) => setMerchant(event.target.value)}
              />
            </Field>
            <Field label="Document date" htmlFor="edit-document-date" optional>
              <Input
                id="edit-document-date"
                type="date"
                value={documentDate}
                onChange={(event) => setDocumentDate(event.target.value)}
              />
            </Field>
          </div>
          <ItemMultiSelect
            selected={itemIds}
            onChange={setItemIds}
            label="Linked items"
            disabled={save.isPending}
          />
          <Field label="Notes" htmlFor="edit-document-notes" optional>
            <Textarea
              id="edit-document-notes"
              value={notes}
              maxLength={4000}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || save.isPending}>
              {save.isPending && <Spinner />}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OcrReview({ document }: { document: DocumentRecord }) {
  const invalidate = useInvalidateInventory();
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const metadata = document.extracted_metadata;
  const [itemIds, setItemIds] = React.useState(document.items.map((item) => item.id));
  const [merchant, setMerchant] = React.useState(
    String(metadata.merchant ?? document.merchant ?? ""),
  );
  const [purchaseDate, setPurchaseDate] = React.useState(
    String(metadata.purchase_date ?? document.document_date ?? ""),
  );
  const [price, setPrice] = React.useState(
    metadata.total_cents != null ? (Number(metadata.total_cents) / 100).toFixed(2) : "",
  );
  const [currency, setCurrency] = React.useState(
    String(metadata.currency ?? "USD"),
  );
  const [orderNumber, setOrderNumber] = React.useState(
    String(metadata.invoice_number ?? ""),
  );
  const [documentDate, setDocumentDate] = React.useState(document.document_date ?? "");
  const [createPurchase, setCreatePurchase] = React.useState(true);
  const [attachAsReceipt, setAttachAsReceipt] = React.useState(true);
  const [targetItemId, setTargetItemId] = React.useState(document.items[0]?.id ?? "");
  const [itemName, setItemName] = React.useState(
    String((metadata.product_names as string[] | undefined)?.[0] ?? ""),
  );
  const [serialNumber, setSerialNumber] = React.useState(
    String((metadata.serial_numbers as string[] | undefined)?.[0] ?? ""),
  );

  const documentItemKey = document.items.map((item) => item.id).join(",");
  React.useEffect(() => {
    setItemIds(document.items.map((item) => item.id));
    if (document.items[0]) setTargetItemId(document.items[0].id);
    // Re-run only when the linked items themselves change, not on every detail
    // refetch while OCR is polling or metadata is edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id, documentItemKey]);

  const extractionSignature = JSON.stringify(metadata);
  React.useEffect(() => {
    if (document.ocr_status !== "succeeded") return;
    const proposed = metadata;
    setMerchant((current) =>
      current || String(proposed.merchant ?? document.merchant ?? ""),
    );
    setPurchaseDate((current) =>
      current || String(proposed.purchase_date ?? document.document_date ?? ""),
    );
    setPrice((current) =>
      current ||
      (proposed.total_cents != null
        ? (Number(proposed.total_cents) / 100).toFixed(2)
        : ""),
    );
    setCurrency((current) => current || String(proposed.currency ?? "USD"));
    setOrderNumber((current) => current || String(proposed.invoice_number ?? ""));
    setDocumentDate((current) => current || document.document_date || "");
    setItemName(
      (current) => current || String((proposed.product_names as string[] | undefined)?.[0] ?? ""),
    );
    setSerialNumber(
      (current) =>
        current || String((proposed.serial_numbers as string[] | undefined)?.[0] ?? ""),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id, document.ocr_status, extractionSignature]);

  const targetItemQuery = useItem(targetItemId || undefined);

  const localPriceCents = price.trim() ? Math.round(Number(price) * 100) : null;
  const priceInvalid =
    price.trim().length > 0 &&
    (localPriceCents === null || !Number.isFinite(localPriceCents) || localPriceCents < 0);

  const apply = useMutation({
    mutationFn: () => {
      const itemUpdates = [];
      if (targetItemId && (itemName.trim() || serialNumber.trim())) {
        itemUpdates.push({
          item_id: targetItemId,
          name: itemName.trim() || null,
          serial_number: serialNumber.trim() || null,
        });
      }
      return api.post<OcrApplyResponse>(`/documents/${document.id}/ocr/apply`, {
        item_ids: itemIds,
        create_purchase: createPurchase,
        merchant: merchant.trim() || null,
        purchase_date: purchaseDate || null,
        price_cents: localPriceCents,
        currency,
        order_number: orderNumber.trim() || null,
        document_date: documentDate || null,
        attach_as_receipt: attachAsReceipt,
        item_updates: itemUpdates,
      });
    },
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.document(document.id),
      });
      toast.success("Confirmed details applied");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  if (document.ocr_status === "queued" || document.ocr_status === "processing") {
    return (
      <div className="mt-5 flex items-center gap-2 rounded-xl border border-border/70 bg-secondary/20 px-4 py-5 text-[0.8rem] text-muted-foreground">
        <Spinner /> Waiting for the local OCR worker…
      </div>
    );
  }

  if (document.ocr_status !== "succeeded" && !document.extracted_text) {
    return (
      <p className="mt-5 text-[0.8rem] leading-relaxed text-muted-foreground">
        Run OCR to propose merchant, date, total, invoice number and serial numbers.
        If the worker cannot read the file, the error and a retry action appear in the
        OCR panel.
      </p>
    );
  }

  const productNames = (metadata.product_names as string[] | undefined) ?? [];
  const serials = (metadata.serial_numbers as string[] | undefined) ?? [];
  const appliedAt =
    typeof metadata.applied_at === "string" ? new Date(metadata.applied_at) : null;
  const appliedItemCount = Array.isArray(metadata.applied_item_ids)
    ? metadata.applied_item_ids.length
    : 0;

  if (!canWrite) {
    return (
      <div className="mt-5 rounded-xl border border-border/70 bg-secondary/25 p-4 text-[0.75rem] leading-relaxed text-muted-foreground">
        Extracted fields are visible to viewers for reference. Applying OCR changes requires
        member access.
      </div>
    );
  }

  return (
    <div className="mt-5 space-y-5">
      {appliedAt && !Number.isNaN(appliedAt.getTime()) && (
        <div className="rounded-xl border border-sage/20 bg-sage-soft/60 p-3.5">
          <p className="flex items-center gap-1.5 text-[0.75rem] font-medium text-accent-foreground">
            <Check className="size-3.5" />
            Confirmed and applied
          </p>
          <p className="mt-1 text-[0.72rem] leading-relaxed text-muted-foreground">
            Reviewed on{" "}
            {new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(appliedAt)}{" "}
            for {pluralize(appliedItemCount, "item")}. Extracted values remain below for
            reference.
          </p>
        </div>
      )}
      <div className="rounded-xl border border-brass/20 bg-brass-soft/60 p-3.5">
        <p className="flex items-center gap-1.5 text-[0.75rem] font-medium text-brass">
          <AlertTriangle className="size-3.5" />
          Nothing changes until you confirm
        </p>
        <p className="mt-1 text-[0.72rem] leading-relaxed text-muted-foreground">
          Review the proposed values. Confirming creates or updates the linked
          purchase and applies any item name or serial number you choose.
        </p>
      </div>

      {(productNames.length > 0 || serials.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {productNames.length > 0 && (
            <div>
              <p className="text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Proposed products
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {productNames.map((name) => (
                  <Badge key={name} variant="outline">
                    {name}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {serials.length > 0 && (
            <div>
              <p className="text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Proposed serials
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {serials.map((serial) => (
                  <Badge key={serial} variant="brass">
                    {serial}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!priceInvalid) apply.mutate();
        }}
      >
        {priceInvalid && <FormError message="Enter a valid total, such as 129.00." />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Merchant" htmlFor="ocr-merchant" optional>
            <Input
              id="ocr-merchant"
              value={merchant}
              maxLength={160}
              onChange={(event) => setMerchant(event.target.value)}
            />
          </Field>
          <Field label="Purchase date" htmlFor="ocr-date" optional>
            <Input
              id="ocr-date"
              type="date"
              value={purchaseDate}
              onChange={(event) => setPurchaseDate(event.target.value)}
            />
          </Field>
          <Field label="Total" htmlFor="ocr-total" optional>
            <Input
              id="ocr-total"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
          </Field>
          <Field label="Currency" htmlFor="ocr-currency">
            <Select
              id="ocr-currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Order or invoice number" htmlFor="ocr-order" optional>
            <Input
              id="ocr-order"
              value={orderNumber}
              maxLength={120}
              onChange={(event) => setOrderNumber(event.target.value)}
            />
          </Field>
          <Field label="Document date" htmlFor="ocr-document-date" optional>
            <Input
              id="ocr-document-date"
              type="date"
              value={documentDate}
              onChange={(event) => setDocumentDate(event.target.value)}
            />
          </Field>
        </div>

        <div className="space-y-3 rounded-xl border border-border/70 bg-background/40 p-4">
          <label className="flex items-center justify-between gap-4 text-[0.8rem]">
            <span>
              <span className="block font-medium">Create or update purchase</span>
              <span className="mt-0.5 block text-[0.7rem] text-muted-foreground">
                Applies the confirmed amount and merchant to every selected item.
              </span>
            </span>
            <Switch
              checked={createPurchase}
              onCheckedChange={setCreatePurchase}
              aria-label="Create or update purchase"
            />
          </label>
          {createPurchase && (
            <label className="flex items-center justify-between gap-4 border-t border-border/60 pt-3 text-[0.8rem]">
              <span>
                <span className="block font-medium">Use this document as the receipt</span>
                <span className="mt-0.5 block text-[0.7rem] text-muted-foreground">
                  Links the document to the purchase for later reference.
                </span>
              </span>
              <Switch
                checked={attachAsReceipt}
                onCheckedChange={setAttachAsReceipt}
                aria-label="Use this document as the receipt"
              />
            </label>
          )}
        </div>

        <ItemMultiSelect
          selected={itemIds}
          onChange={(ids) => {
            setItemIds(ids);
            if (!ids.includes(targetItemId)) setTargetItemId(ids[0] ?? "");
          }}
          label="Apply to items"
          hint="The purchase is shared across every selected item without duplicating it."
          disabled={apply.isPending}
        />

        {itemIds.length > 0 && (
          <div className="rounded-xl border border-border/70 bg-background/40 p-4">
            <p className="text-[0.8rem] font-medium">Optional item details</p>
            <p className="mt-0.5 text-[0.7rem] text-muted-foreground">
              Apply an extracted product name or serial number to one selected item.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Item" htmlFor="ocr-target-item">
                <Select
                  id="ocr-target-item"
                  value={targetItemId}
                  onChange={(event) => setTargetItemId(event.target.value)}
                >
                  {itemIds.map((itemId) => (
                    <option key={itemId} value={itemId}>
                      {document.items.find((item) => item.id === itemId)?.name ??
                        targetItemQuery.data?.item.name ??
                        "Selected item"}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Serial number" htmlFor="ocr-serial" optional>
                <Input
                  id="ocr-serial"
                  value={serialNumber}
                  maxLength={200}
                  onChange={(event) => setSerialNumber(event.target.value)}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Item name" htmlFor="ocr-item-name" optional>
                  <Input
                    id="ocr-item-name"
                    value={itemName}
                    maxLength={200}
                    onChange={(event) => setItemName(event.target.value)}
                  />
                </Field>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-col-reverse gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[0.7rem] text-muted-foreground">
            {pluralize(itemIds.length, "item")} selected
          </p>
          <Button
            type="submit"
            disabled={
              apply.isPending ||
              priceInvalid ||
              (createPurchase && itemIds.length === 0)
            }
          >
            {apply.isPending ? <Spinner /> : <Check />}
            Confirm and apply
          </Button>
        </div>
      </form>
    </div>
  );
}

function DocumentDetailSkeleton() {
  return (
    <div>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-12 w-1/2 max-w-md" />
      <div className="mt-10 grid gap-7 xl:grid-cols-[minmax(0,1.35fr)_minmax(330px,1fr)]">
        <div className="space-y-6">
          <Skeleton className="aspect-[4/3] rounded-2xl" />
          <Skeleton className="h-80 rounded-2xl" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
