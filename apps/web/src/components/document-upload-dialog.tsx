import { useMutation } from "@tanstack/react-query";
import { FileUp, Plus } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
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
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, getApiErrorMessage } from "@/lib/api";
import { DOCUMENT_FILE_ACCEPT, documentFileError, documentUploadFile } from "@/lib/document-files";
import { DOCUMENT_TYPE_OPTIONS } from "@/lib/labels";
import { useInvalidateInventory } from "@/lib/queries";
import type { DocumentRecord, DocumentType } from "@/lib/types";

export function DocumentUploadDialog({
  open,
  onOpenChange,
  defaultItemIds = [],
  defaultType = "receipt",
  manualMode = false,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultItemIds?: string[];
  defaultType?: DocumentType;
  manualMode?: boolean;
  onUploaded?: (document: DocumentRecord) => void;
}) {
  const invalidate = useInvalidateInventory();
  const [file, setFile] = React.useState<File | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [title, setTitle] = React.useState("");
  const [documentType, setDocumentType] = React.useState<DocumentType>(defaultType);
  const [merchant, setMerchant] = React.useState("");
  const [documentDate, setDocumentDate] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [itemIds, setItemIds] = React.useState<string[]>(defaultItemIds);
  const defaultItemKey = defaultItemIds.join(",");
  const fixedItemManual = manualMode && defaultItemIds.length > 0;

  React.useEffect(() => {
    if (open) {
      setDocumentType(manualMode ? "manual" : defaultType);
      setItemIds(defaultItemIds);
    }
    // The key intentionally captures the selection without re-running on every
    // parent render where the array has a new identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultItemKey, defaultType, manualMode, open]);

  const upload = useMutation({
    mutationFn: () => {
      if (!file) throw new Error("Choose a file first.");
      const error = documentFileError(file);
      if (error) throw new Error(error);
      const formData = new FormData();
      formData.append("file", file);
      if (title.trim()) formData.append("title", title.trim());
      formData.append("document_type", manualMode ? "manual" : documentType);
      if (merchant.trim()) formData.append("merchant", merchant.trim());
      if (documentDate) formData.append("document_date", documentDate);
      if (notes.trim()) formData.append("notes", notes.trim());
      const uploadItemIds = fixedItemManual ? defaultItemIds : itemIds;
      uploadItemIds.forEach((itemId) => formData.append("item_ids", itemId));
      return api.postForm<DocumentRecord>("/documents", formData);
    },
    onSuccess: (document) => {
      invalidate();
      const duplicates = document.extracted_metadata.duplicate_documents as
        | Array<{ title: string }>
        | undefined;
      if (duplicates && duplicates.length > 0) {
        toast.warning("Manual added with a duplicate warning", {
          description: `The same file is already stored as “${duplicates[0]?.title ?? "an existing document"}”. Use the existing library copy if possible.`,
        });
      } else {
        toast.success(manualMode ? "Manual added to the library" : "Document added to the library");
      }
      setFile(null);
      setFileError(null);
      setTitle("");
      setMerchant("");
      setDocumentDate("");
      setNotes("");
      setItemIds([]);
      onOpenChange(false);
      onUploaded?.(document);
    },
  });

  const reset = () => {
    if (upload.isPending) return;
    setFile(null);
    setFileError(null);
    setTitle("");
    setMerchant("");
    setDocumentDate("");
    setNotes("");
    setItemIds(defaultItemIds);
    upload.reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{manualMode ? "Add a manual" : "Add a document"}</DialogTitle>
          <DialogDescription>
            {manualMode
              ? fixedItemManual
                ? "Upload a manual or a clear photo/scan of one. It will be attached to this item automatically; no make or model is required."
                : "Upload a manual or a clear photo/scan of one. No make or model is required, and the exact original is preserved in the Manual library."
              : "Receipts, invoices, warranty certificates, manuals and specifications. The original upload is preserved alongside a safe download copy."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            upload.mutate();
          }}
        >
          {upload.error && <FormError message={getApiErrorMessage(upload.error)} />}
          {fileError && <FormError message={fileError} />}

          <Field
            label={manualMode ? "Manual file" : "File"}
            htmlFor="document-file"
            hint={
              manualMode
                ? "PDF or image · up to 25 MB. Multi-page PDFs are attached unchanged."
                : "PDF, JPEG, PNG, WebP or plain text · up to 25 MB. Multi-page PDFs are attached unchanged."
            }
          >
            <label
              htmlFor="document-file"
              className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-border bg-secondary/20 px-4 py-4 transition-colors hover:bg-secondary/40"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                <FileUp className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">
                  {file ? file.name : "Choose a file"}
                </span>
                <span className="mt-0.5 block text-2xs text-muted-foreground">
                  {file ? `${Math.ceil(file.size / 1024)} KB` : "Tap to browse"}
                </span>
              </span>
              <Plus className="size-4 shrink-0 text-muted-foreground" />
            </label>
            <input
              id="document-file"
              type="file"
              required
              accept={DOCUMENT_FILE_ACCEPT}
              className="sr-only"
              disabled={upload.isPending}
              onChange={(event) => {
                const selected = event.target.files?.[0] ?? null;
                const error = selected ? documentFileError(selected) : null;
                setFileError(error);
                if (error) {
                  event.target.value = "";
                  return;
                }
                setFile(selected ? documentUploadFile(selected) : null);
                if (selected && !title.trim()) {
                  setTitle(selected.name.replace(/\.[^.]+$/, ""));
                }
              }}
            />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Title"
              htmlFor="document-title"
              optional
            >
              <Input
                id="document-title"
                maxLength={200}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={manualMode ? "Cordless drill manual" : "Purchase receipt"}
              />
            </Field>
            {!manualMode && (
              <Field label="Type" htmlFor="document-type">
                <Select
                  id="document-type"
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
            )}
            {!manualMode && (
              <Field label="Merchant" htmlFor="document-merchant" optional>
                <Input
                  id="document-merchant"
                  maxLength={160}
                  value={merchant}
                  onChange={(event) => setMerchant(event.target.value)}
                  placeholder="Where it came from"
                />
              </Field>
            )}
            {!manualMode && (
              <Field label="Document date" htmlFor="document-date" optional>
                <Input
                  id="document-date"
                  type="date"
                  value={documentDate}
                  onChange={(event) => setDocumentDate(event.target.value)}
                />
              </Field>
            )}
          </div>

          {!fixedItemManual && (
            <ItemMultiSelect
              selected={itemIds}
              onChange={setItemIds}
              label={manualMode ? "Compatible items" : "Linked items"}
              hint={
                manualMode
                  ? "A manual can cover one item, several compatible items, or stay in the library. Only link items this manual actually covers."
                  : "A document can belong to one item, several items, or the household library."
              }
              disabled={upload.isPending}
            />
          )}

          <Field label="Notes" htmlFor="document-notes" optional>
            <Textarea
              id="document-notes"
              maxLength={4000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Return window, what the manual covers, anything worth finding later."
            />
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={upload.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!file || upload.isPending}>
              {upload.isPending && <Spinner />}
              {manualMode ? "Add manual" : "Add document"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
