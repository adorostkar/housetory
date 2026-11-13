import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  Download,
  FileText,
  Images,
  Link2,
  Pencil,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { DocumentExtractionReview } from "@/components/document-extraction-review";
import { DocumentProcessingStatus } from "@/components/document-processing-status";
import { DocumentScanDialog } from "@/components/document-scan-dialog";
import { ErrorState } from "@/components/error-state";
import { Field, FormError } from "@/components/form-field";
import { ItemMultiSelect } from "@/components/item-multi-select";
import { PageLayout, PageSkeleton } from "@/components/page-layout";
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { useRegisterAssistantPageContext } from "@/lib/assistant-page-context";
import {
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
} from "@/lib/queries";
import type { DocumentCaptureContext, DocumentRecord, DocumentType } from "@/lib/types";
import { formatDate, formatFileSize, versionedUrl } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";

export function DocumentDetailPage() {
  const { documentId = "" } = useParams();
  const navigation = useLocation();
  const capture = (navigation.state as { documentCapture?: DocumentCaptureContext } | null)?.documentCapture;
  const captureContext = capture?.documentId === documentId &&
    typeof capture.roomId === "string" && typeof capture.locationId === "string" ? capture : undefined;
  const documentQuery = useDocument(documentId);
  useRegisterAssistantPageContext(
    documentQuery.data && !documentQuery.isError
      ? [{ kind: "document", id: documentQuery.data.id, name: documentQuery.data.title }]
      : [],
  );
  const [extractionOpened, setExtractionOpened] = React.useState(false);
  const [manualReviewRequest, setManualReviewRequest] = React.useState({ documentId: "", revision: 0 });
  const relationsQuery = useDocumentRelations(
    documentQuery.data && extractionOpened ? documentId : undefined,
  );
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const [editOpen, setEditOpen] = React.useState(false);
  const [cleanupOpen, setCleanupOpen] = React.useState(false);
  const [cleanupRevision, setCleanupRevision] = React.useState(0);
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

  if (documentQuery.isPending) return <PageSkeleton variant="detail" />;
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
  if (!document) return <PageSkeleton variant="detail" />;
  const busy = retry.isPending || remove.isPending;
  const firstPage = document.pages[0];

  return (
    <PageLayout
      header={{
        eyebrow: DOCUMENT_TYPE_LABELS[document.document_type],
        title: document.title,
        description: [
          document.merchant,
          document.document_date ? formatDate(document.document_date) : null,
          document.original_filename,
        ]
          .filter(Boolean)
          .join(" · "),
        backTo: "/documents",
        backLabel: "Documents",
        actions: (
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
                {document.original_content_type === "application/pdf" ? "Original PDF" : "Original"}
              </a>
            </Button>
            {canWrite && (
              <>
                {(document.pages.length > 0 ||
                  isImageContentType(document.original_content_type) ||
                  isImageContentType(document.content_type)) && (
                  <Button variant="outline" onClick={() => setCleanupOpen(true)}>
                    <ScanLine />
                    Clean up scan
                  </Button>
                )}
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
        ),
      }}
    >
      <div className="grid items-start gap-7 xl:grid-cols-[minmax(0,1.35fr)_minmax(330px,1fr)]">
        <div className="space-y-6">
          <DocumentProcessingStatus documentId={document.id} onManualReview={() => {
            setManualReviewRequest((request) => ({ documentId: document.id, revision: request.revision + 1 }));
            const review = window.document.getElementById("document-extraction-review");
            review?.scrollIntoView?.({ behavior: "smooth", block: "start" });
            review?.focus({ preventScroll: true });
          }} />
          <section className="surface overflow-hidden">
            {isImageContentType(document.content_type) ? (
              <div className="flex max-h-[70vh] items-center justify-center bg-secondary/30 p-4">
                <img
                  src={versionedUrl(document.url, document.updated_at)}
                  alt={document.title}
                  className="max-h-[65vh] max-w-full rounded-lg object-contain shadow-sm"
                />
              </div>
            ) : firstPage ? (
              <div className="relative flex max-h-[70vh] items-center justify-center bg-secondary/30 p-4">
                <img
                  src={versionedUrl(firstPage.cleaned_url, firstPage.updated_at)}
                  alt={`${document.title} · page 1`}
                  className="max-h-[65vh] max-w-full rounded-lg object-contain shadow-sm"
                />
                <Badge
                  variant="secondary"
                  className="absolute left-6 top-6 bg-background/85 backdrop-blur-md"
                >
                  Page 1 of {document.page_count}
                </Badge>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                <span className="flex size-14 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                  <FileText className="size-6" strokeWidth={1.5} />
                </span>
                <p className="mt-4 font-display text-xl tracking-[-0.02em]">
                  {document.original_filename}
                </p>
                <p className="mt-1 text-2xs text-muted-foreground">
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

          {document.pages.length > 0 && (
            <section className="surface p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Images className="size-4 text-brass" strokeWidth={1.7} />
                  <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
                    Scanned pages
                  </h2>
                </div>
                <Badge variant="outline">{document.page_count} pages</Badge>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                The cleaned PDF is the default download. Exact original page files are
                preserved separately and can be downloaded below.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {document.pages.map((page) => (
                  <figure
                    key={page.id}
                    className="overflow-hidden rounded-xl border border-border/70 bg-secondary/20"
                  >
                    <a href={page.cleaned_url} target="_blank" rel="noreferrer">
                      <img
                        src={versionedUrl(page.cleaned_url, page.updated_at)}
                        alt={`Cleaned page ${page.page_number}`}
                        className="h-36 w-full object-contain p-2"
                      />
                    </a>
                    <figcaption className="flex items-center justify-between gap-2 border-t border-border/60 px-2.5 py-1.5 text-2xs text-muted-foreground">
                      <span>Page {page.page_number}</span>
                      <a
                        href={page.original_url}
                        download={page.original_filename}
                        className="font-medium underline-offset-4 hover:text-foreground hover:underline"
                      >
                        Original
                      </a>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          )}

            <section id="document-extraction-review" tabIndex={-1}
              aria-labelledby="document-extraction-heading" className="surface p-5 sm:p-6">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-brass" strokeWidth={1.7} />
                <h2 id="document-extraction-heading" className="text-sm font-medium">
                  Extraction review
                </h2>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                {document.pages.length > 0
                  ? "OCR reads the cleaned PDF; original page files remain available above. Review document fields, line items and household matches before anything changes."
                  : "Review document fields, line items and household matches before anything changes."}
              </p>
              <DocumentExtractionReview key={`${document.id}:${cleanupRevision}`} document={document}
                captureContext={captureContext}
                manualReviewRequest={manualReviewRequest.documentId === document.id ? manualReviewRequest.revision : 0}
                onOpenChange={(open) => { if (open) setExtractionOpened(true); }} />
            </section>

          {document.extracted_text && (
            <details className="surface p-5 sm:p-6">
              <summary className="cursor-pointer text-xs font-medium">
                Extracted text
                <span className="ml-2 text-2xs font-normal text-muted-foreground">
                  {document.extracted_text.length.toLocaleString()} characters
                </span>
              </summary>
              <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-secondary/40 p-4 text-2xs leading-relaxed text-muted-foreground">
                {document.extracted_text}
              </pre>
            </details>
          )}
        </div>

        <aside className="space-y-4">
          <section className="surface p-5">
            <h2 className="text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              Metadata
            </h2>
            <dl className="mt-4 space-y-3 text-xs">
              <MetadataRow label="Type" value={DOCUMENT_TYPE_LABELS[document.document_type]} />
              <MetadataRow label="Merchant" value={document.merchant ?? "—"} />
              <MetadataRow
                label="Document date"
                value={document.document_date ? formatDate(document.document_date) : "—"}
              />
              <MetadataRow label="File" value={document.original_filename} />
              {document.page_count > 0 && (
                <MetadataRow label="Pages" value={String(document.page_count)} />
              )}
              <MetadataRow
                label="Size"
                value={`${formatFileSize(document.byte_size)} · original ${formatFileSize(
                  document.original_byte_size,
                )}`}
              />
              <MetadataRow label="Added" value={formatDate(document.created_at)} />
            </dl>
            {document.notes && (
              <p className="mt-4 whitespace-pre-line border-t border-border/60 pt-4 text-xs leading-relaxed text-muted-foreground">
                {document.notes}
              </p>
            )}
            <div className="mt-4 border-t border-border/60 pt-4">
              <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                <Link2 className="size-3.5" />
                Linked items
              </div>
              {document.items.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">
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
                  <h2 className="text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                    Suggested items
                  </h2>
                  <p className="mt-1 text-2xs text-muted-foreground">
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
                      className="flex items-start gap-2 rounded-lg border border-border/60 px-3 py-2 text-2xs"
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
                        <span className="block text-2xs text-muted-foreground">
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
              <h2 className="text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
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
              <p className="mt-3 text-xs text-muted-foreground">
                Local reading is pending. See processing status above for worker
                availability, cancellation and retry.
              </p>
            ) : document.ocr_status === "failed" ? (
              <div className="mt-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3">
                <p className="flex items-center gap-1.5 text-2xs font-medium text-destructive">
                  <AlertTriangle className="size-3.5" /> Extraction failed
                </p>
                <p className="mt-1 break-words text-2xs leading-relaxed text-muted-foreground">
                  {document.ocr_error ?? "The worker could not read this file."}
                </p>
              </div>
            ) : document.ocr_status === "succeeded" ? (
              <>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
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
                <div className="mt-2 rounded-lg border border-brass/20 bg-brass-soft/50 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                  {document.extracted_metadata.ai_warnings
                    .slice(0, 5)
                    .map((warning) => String(warning))
                    .join(" ")}
                </div>
              ) : null}
              </>
            ) : (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
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
            <h2 className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              <ShieldCheck className="size-3.5" /> File safety
            </h2>
            <ul className="mt-3 space-y-2 text-2xs leading-relaxed text-muted-foreground">
              <li>Downloads are authenticated and never cached by the browser.</li>
              <li>
                {document.page_count > 0
                  ? "Each scanned source page is kept byte-for-byte; the Original PDF is assembled from those pages."
                  : "The original upload is kept byte-for-byte for your records."}
              </li>
              <li>Cleaned image pages are re-encoded derivatives with metadata stripped.</li>
              <li>PDFs and text files are validated before they are stored.</li>
            </ul>
          </section>
        </aside>
      </div>

      <DocumentScanDialog
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
        targetDocumentId={document.id}
        onSaved={(updated) => {
          queryClient.removeQueries({
            queryKey: [...queryKeys.document(document.id), "extraction"],
            exact: true,
          });
          queryClient.setQueryData(queryKeys.document(document.id), updated);
          setCleanupRevision(value => value + 1);
          setExtractionOpened(false);
        }}
      />

      <EditDocumentDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        document={document}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this document?"
        description={
          document.page_count > 0
            ? "The cleaned PDF, assembled source PDF and retained scan pages will be removed, and the document will be detached from every item and purchase. This cannot be undone."
            : "The original upload and safe download copy will be removed, and the document will be detached from every item and purchase. This cannot be undone."
        }
        confirmLabel="Delete document"
        onConfirm={async () => {
          await remove.mutateAsync();
        }}
      />
    </PageLayout>
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
