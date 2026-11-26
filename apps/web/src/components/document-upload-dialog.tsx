import { useMutation, useQuery } from "@tanstack/react-query";
import { Camera, Check, FileUp, Undo2 } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import {
  AttachedItemChip,
  DocumentDetailsFields,
  DocumentFilePreview,
  OptionalStep,
  useObjectUrl,
  type DocumentDetailsDraft,
} from "@/components/document-add-steps";
import { countExtractedDetails } from "@/components/document-extraction-helpers";
import { DocumentProcessingStatus } from "@/components/document-processing-status";
import { FormError } from "@/components/form-field";
import { ItemMultiSelect } from "@/components/item-multi-select";
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
  DOCUMENT_FILE_ACCEPT,
  documentFileError,
  documentFileType,
  documentUploadFile,
} from "@/lib/document-files";
import { DOCUMENT_TYPE_LABELS } from "@/lib/labels";
import { queryKeys, useDocument, useInvalidateInventory } from "@/lib/queries";
import type { DocumentRecord, DocumentType, ExtractionReview } from "@/lib/types";
import { cn, pluralize } from "@/lib/utils";

function detailsOf(document: DocumentRecord): DocumentDetailsDraft {
  return {
    title: document.title,
    documentType: document.document_type,
    merchant: document.merchant ?? "",
    documentDate: document.document_date ?? "",
    notes: document.notes ?? "",
  };
}

/**
 * Adds a document. The file is saved as soon as it is chosen; nothing else is
 * required. Details, items and the check of what was read are optional steps after
 * that. Undo removes the document that was just saved.
 */
export function DocumentUploadDialog({
  open,
  onOpenChange,
  defaultItemIds = [],
  defaultType = "other",
  manualMode = false,
  itemName,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultItemIds?: string[];
  defaultType?: DocumentType;
  manualMode?: boolean;
  /** The name of the item the user started from. It is shown as "Attached to". */
  itemName?: string;
  /** Called when the dialog closes with a saved document. */
  onUploaded?: (document: DocumentRecord) => void;
}) {
  const invalidate = useInvalidateInventory();
  const ids = React.useId();
  const [file, setFile] = React.useState<File | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [saved, setSaved] = React.useState<DocumentRecord | null>(null);
  const [details, setDetails] = React.useState<DocumentDetailsDraft | null>(null);
  const [itemIds, setItemIds] = React.useState<string[]>(defaultItemIds);
  const fromItem = defaultItemIds.length > 0;
  const fixedItemManual = manualMode && fromItem;
  const type: DocumentType = manualMode ? "manual" : defaultType;
  const previewUrl = useObjectUrl(file && documentFileType(file).startsWith("image/") ? file : null);

  const live = useDocument(saved?.id, Boolean(saved));
  const current = live.data ?? saved;
  const isManual = (current?.document_type ?? type) === "manual";
  const extraction = useQuery({
    queryKey: [...queryKeys.document(saved?.id ?? ""), "extraction"],
    queryFn: () => api.get<ExtractionReview>(`/documents/${saved?.id}/extraction`),
    enabled: Boolean(saved) && !isManual && current?.ocr_status === "succeeded"
      && Boolean(current?.extracted_text),
    retry: false,
  });
  const found = extraction.data ? countExtractedDetails(extraction.data) : 0;

  const upload = useMutation({
    mutationFn: (chosen: File) => {
      const formData = new FormData();
      formData.append("file", chosen);
      formData.append("document_type", type);
      defaultItemIds.forEach((itemId) => formData.append("item_ids", itemId));
      return api.postForm<DocumentRecord>("/documents", formData);
    },
    onSuccess: (document) => {
      invalidate();
      setSaved(document);
      setDetails(detailsOf(document));
      setItemIds(document.items.map((item) => item.id));
      const duplicates = document.extracted_metadata.duplicate_documents as
        | Array<{ title: string }>
        | undefined;
      if (duplicates && duplicates.length > 0) {
        toast.warning(manualMode ? "Manual added with a duplicate warning" : "Document added with a duplicate warning", {
          description: `The same file is already stored as “${duplicates[0]?.title ?? "an existing document"}”. Use the existing library copy if possible.`,
        });
      } else {
        toast.success(manualMode ? "Manual added to the library" : "Document added to the library");
      }
    },
  });

  const undo = useMutation({
    mutationFn: (document: DocumentRecord) => api.delete<void>(`/documents/${document.id}`),
    onSuccess: () => {
      invalidate();
      setSaved(null);
      setDetails(null);
      setFile(null);
      setItemIds(defaultItemIds);
      upload.reset();
      toast.success("Removed. Nothing was kept.");
    },
  });

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => {
      if (!saved) throw new Error("Choose a file first.");
      return api.patch<DocumentRecord>(`/documents/${saved.id}`, body);
    },
    onSuccess: (document) => {
      invalidate();
      setSaved(document);
    },
  });

  const start = (chosen: File | null | undefined) => {
    if (!chosen || upload.isPending || saved) return;
    const error = documentFileError(chosen);
    setFileError(error);
    if (error) return;
    const prepared = documentUploadFile(chosen);
    setFile(prepared);
    upload.mutate(prepared);
  };

  const savedDetails = saved ? detailsOf(saved) : null;
  const detailsDirty = Boolean(details && savedDetails && (
    details.title.trim() !== savedDetails.title ||
    details.documentType !== savedDetails.documentType ||
    details.merchant.trim() !== savedDetails.merchant ||
    details.documentDate !== savedDetails.documentDate ||
    details.notes.trim() !== savedDetails.notes
  ));
  const detailsBody = () => details && {
    // An empty title keeps the saved one; the server does not accept a blank title.
    ...(details.title.trim() ? { title: details.title.trim() } : {}),
    ...(manualMode ? {} : { document_type: details.documentType }),
    merchant: details.merchant.trim() || null,
    document_date: details.documentDate || null,
    notes: details.notes.trim() || null,
  };

  const changeItems = (next: string[]) => {
    const previous = itemIds;
    setItemIds(next);
    patch.mutate({ item_ids: next }, { onError: () => setItemIds(previous) });
  };

  const reset = () => {
    setFile(null);
    setFileError(null);
    setDragging(false);
    setSaved(null);
    setDetails(null);
    setItemIds(defaultItemIds);
    upload.reset();
    undo.reset();
    patch.reset();
  };

  // Closing never loses the document: it is already saved. Details that were typed
  // but not saved yet are saved on the way out.
  const close = () => {
    if (upload.isPending || undo.isPending) return;
    const document = saved;
    const body = detailsDirty ? detailsBody() : null;
    if (document && body) {
      api.patch<DocumentRecord>(`/documents/${document.id}`, body)
        .then(() => invalidate())
        .catch((error: unknown) => toast.error(getApiErrorMessage(error)));
    }
    reset();
    onOpenChange(false);
    if (document) onUploaded?.(document);
  };

  const attachedNames = current?.items.length
    ? current.items.map((item) => item.name)
    : itemName ? [itemName] : [];
  const noun = manualMode ? "manual" : "document";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{manualMode ? "Add a manual" : "Add a document"}</DialogTitle>
          <DialogDescription>
            {saved
              ? `The ${noun} is saved. Everything below is optional.`
              : manualMode
                ? "Choose a manual or a clear photo of one. It is saved at once; no make or model is needed."
                : "Choose a file or take a photo. It is saved at once; details can follow."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {upload.error && <FormError message={getApiErrorMessage(upload.error)} />}
          {undo.error && <FormError message={getApiErrorMessage(undo.error)} />}
          {fileError && <FormError message={fileError} />}

          {!saved && (
            <div
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                if (!event.dataTransfer.files.length) return;
                event.preventDefault();
                setDragging(false);
                if (event.dataTransfer.files.length > 1) {
                  setFileError("Add one file at a time.");
                  return;
                }
                start(event.dataTransfer.files[0]);
              }}
              className={cn(
                "rounded-xl border border-dashed border-border bg-secondary/20 p-4 transition-colors",
                dragging && "border-ring bg-secondary/50",
              )}
            >
              {upload.isPending && file ? (
                <div className="space-y-3">
                  <DocumentFilePreview url={previewUrl} name={file.name}
                    detail={`${Math.ceil(file.size / 1024)} KB`} />
                  <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Spinner /> Saving the original…
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    {manualMode
                      ? "PDF or image, up to 25 MB. Drop a file here, or:"
                      : "PDF, image or plain text, up to 25 MB. Drop a file here, or:"}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <label
                      htmlFor={`${ids}-file`}
                      className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-within:ring-2 focus-within:ring-ring/40 lg:text-xs"
                    >
                      <FileUp aria-hidden="true" className="size-4" />
                      {upload.error ? "Choose again" : "Choose a file"}
                    </label>
                    <label
                      htmlFor={`${ids}-camera`}
                      className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-border bg-card px-4 text-sm font-medium transition-colors hover:bg-secondary focus-within:ring-2 focus-within:ring-ring/40 lg:text-xs"
                    >
                      <Camera aria-hidden="true" className="size-4" />
                      Take a photo
                    </label>
                    {upload.error && file && (
                      <Button type="button" variant="outline" className="min-h-11"
                        onClick={() => upload.mutate(file)}>
                        Try again
                      </Button>
                    )}
                  </div>
                  <input
                    id={`${ids}-file`}
                    data-testid="document-file"
                    type="file"
                    accept={DOCUMENT_FILE_ACCEPT}
                    className="sr-only"
                    aria-label={manualMode ? "Manual file" : "File"}
                    onChange={(event) => {
                      start(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                  <input
                    id={`${ids}-camera`}
                    data-testid="document-camera"
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="sr-only"
                    aria-label="Take a photo"
                    onChange={(event) => {
                      start(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {saved && current && details && (
            <>
              <DocumentFilePreview
                url={previewUrl}
                name={current.title}
                detail={`${DOCUMENT_TYPE_LABELS[current.document_type]} · saved to the library`}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Check aria-hidden="true" className="size-3.5 text-sage" /> Saved
                </p>
                <Button type="button" size="sm" variant="ghost" className="min-h-11"
                  disabled={undo.isPending} onClick={() => undo.mutate(saved)}>
                  {undo.isPending ? <Spinner /> : <Undo2 />}
                  Undo
                </Button>
              </div>

              <DocumentProcessingStatus documentId={saved.id} compact
                documentType={current.document_type} onManualReview={() => undefined} />

              {patch.error && <FormError message={getApiErrorMessage(patch.error)} />}

              {fromItem && <AttachedItemChip names={attachedNames} />}
              {!fixedItemManual && (
                <OptionalStep
                  title={fromItem ? "Attach to more items" : manualMode ? "Attach to items it covers" : "Attach to an item"}
                  summary={itemIds.length ? `${pluralize(itemIds.length, "item")} attached` : "Not attached. It stays in the library."}
                >
                  <ItemMultiSelect
                    selected={itemIds}
                    onChange={changeItems}
                    hint={manualMode
                      ? "Only link items this manual actually covers."
                      : "A document can belong to one item, several items, or only the library."}
                    disabled={patch.isPending}
                  />
                </OptionalStep>
              )}

              <OptionalStep
                title="Add details"
                summary={manualMode ? "Title and notes" : "Type, title, merchant, date and notes"}
              >
                <DocumentDetailsFields idPrefix={`${ids}-details`} value={details}
                  onChange={setDetails} manualMode={manualMode} disabled={patch.isPending} />
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="button" size="sm" variant="outline" className="min-h-11"
                    disabled={!detailsDirty || patch.isPending}
                    onClick={() => {
                      const body = detailsBody();
                      if (body) patch.mutate(body, { onSuccess: (document) => setDetails(detailsOf(document)) });
                    }}>
                    {patch.isPending && <Spinner />}
                    Save details
                  </Button>
                  {!detailsDirty && <span className="text-xs text-muted-foreground lg:text-2xs">Nothing to save.</span>}
                </div>
              </OptionalStep>

              {found > 0 && (
                <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-card/40 px-3.5 py-2">
                  <p className="text-sm lg:text-xs">
                    <span className="font-medium">Check what was read</span>
                    <span className="block text-xs text-muted-foreground lg:text-2xs">
                      {pluralize(found, "detail")} found. Nothing changes until you apply it.
                    </span>
                  </p>
                  <Button size="sm" variant="outline" className="min-h-11" asChild>
                    <Link to={`/documents/${saved.id}`} onClick={close}>View</Link>
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
        {saved && (
          <DialogFooter>
            <Button type="button" className="min-h-11" onClick={close} disabled={undo.isPending}>
              Done
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
