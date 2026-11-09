import { useMutation } from "@tanstack/react-query";
import {
  BookOpen,
  Download,
  FileText,
  Globe2,
  MessageCircle,
  Paperclip,
  Plus,
  ScanLine,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { DocumentLinkDialog } from "@/components/document-link-dialog";
import { DocumentScanDialog } from "@/components/document-scan-dialog";
import { DocumentUploadDialog } from "@/components/document-upload-dialog";
import { ManualAskDialog } from "@/components/manual-ask-dialog";
import { ManualFindDialog } from "@/components/manual-find-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, getApiErrorMessage } from "@/lib/api";
import { DOCUMENT_TYPE_LABELS } from "@/lib/labels";
import {
  useCanWrite,
  useInvalidateInventory,
  useItemManuals,
} from "@/lib/queries";
import type { DocumentRecord, ItemDetail } from "@/lib/types";
import { formatDate, formatFileSize } from "@/lib/utils";

export function ItemDocumentsAndManuals({ item }: { item: ItemDetail }) {
  const invalidate = useInvalidateInventory();
  const canWrite = useCanWrite();
  const manualsQuery = useItemManuals(item.id);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [manualUploadOpen, setManualUploadOpen] = React.useState(false);
  const [scanOpen, setScanOpen] = React.useState(false);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [askOpen, setAskOpen] = React.useState(false);
  const [findOpen, setFindOpen] = React.useState(false);
  const [documentToDelete, setDocumentToDelete] =
    React.useState<DocumentRecord | null>(null);

  const manuals = manualsQuery.data?.manuals ?? [];
  const manualById = new Map(manuals.map((manual) => [manual.id, manual]));
  const documents = [...item.documents];
  const documentIds = new Set(documents.map((document) => document.id));
  for (const manual of manuals) {
    if (!documentIds.has(manual.id)) documents.push(manual);
  }
  const profile = manualsQuery.data?.search.profile;
  const searchStatus = manualsQuery.data?.search;

  const remove = useMutation({
    mutationFn: (documentId: string) => api.delete<void>(`/documents/${documentId}`),
    onSuccess: () => {
      invalidate();
      toast.success("Document removed");
      setDocumentToDelete(null);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const openManualLibrary = () => {
    setFindOpen(true);
  };

  return (
    <section className="surface p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BookOpen className="size-4 text-muted-foreground" strokeWidth={1.7} />
            <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
              Documents &amp; manuals
            </h2>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            One library for receipts, warranties, manuals and other files. Attached
            manuals answer questions from their stored text and show citations.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => setAskOpen(true)}>
          <MessageCircle />
          Ask about this item
        </Button>
      </div>

      {documents.length > 0 && canWrite && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-y border-border/60 py-3">
          <Button type="button" size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
            <Plus />
            Upload document
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setScanOpen(true)}>
            <ScanLine />
            Scan pages
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setLinkOpen(true)}>
            <Paperclip />
            Link existing
          </Button>
          <Button type="button" size="sm" variant="ghost" asChild>
            <Link to="/documents">Library</Link>
          </Button>
        </div>
      )}

      <div className="mt-4">
        {documents.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-secondary/20 px-4 py-7 text-center">
            <FileText className="size-5 text-muted-foreground" strokeWidth={1.5} />
            <p className="mt-3 text-xs font-medium">
              No documents or manuals attached
            </p>
            <p className="mt-1 max-w-lg text-2xs leading-relaxed text-muted-foreground">
              Upload a receipt, warranty, manual or other file, scan pages, or link an
              existing library document. Manuals do not need make/model fields.
            </p>
            {canWrite && (
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
                  <Plus />
                  Upload document
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setManualUploadOpen(true)}>
                  <BookOpen />
                  Add manual
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setScanOpen(true)}>
                  <ScanLine />
                  Scan pages
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setLinkOpen(true)}>
                  <Paperclip />
                  Link existing
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={openManualLibrary}>
                  <Globe2 />
                  Find manual
                </Button>
              </div>
            )}
            {manualsQuery.isError && (
              <p className="mt-2 text-2xs text-muted-foreground">
                Manual-specific tools could not be loaded.{" "}
                <button
                  type="button"
                  className="underline underline-offset-4 hover:text-foreground"
                  onClick={() => void manualsQuery.refetch()}
                >
                  Retry
                </button>
              </p>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {documents.map((document) => {
              const manual = manualById.get(document.id);
              const pageCount = manual?.extracted_metadata.ocr_page_count as
                | number
                | undefined;
              const reading =
                document.ocr_status === "queued" ||
                document.ocr_status === "processing";
              return (
                <li
                  key={document.id}
                  className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Link
                        to={`/documents/${document.id}`}
                        className="min-w-0 break-words text-sm font-medium underline-offset-4 hover:underline"
                      >
                        {document.title}
                      </Link>
                      <Badge variant="outline">
                        {DOCUMENT_TYPE_LABELS[document.document_type]}
                      </Badge>
                      {manual && reading ? (
                        <Badge variant="secondary">Reading…</Badge>
                      ) : pageCount ? (
                        <Badge variant="outline">
                          {pageCount} {pageCount === 1 ? "page" : "pages"}
                        </Badge>
                      ) : null}
                      {document.item_count > 1 && (
                        <Badge variant="secondary">
                          {document.item_count} items
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-2xs text-muted-foreground">
                      {document.merchant ? `${document.merchant} · ` : ""}
                      {formatFileSize(document.byte_size)} ·{" "}
                      {formatDate(document.created_at)}
                    </p>
                  </div>
                  <Link
                    to={`/documents/${document.id}`}
                    className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    aria-label={`Open ${document.title}`}
                  >
                    <FileText className="size-3.5" />
                  </Link>
                  <a
                    href={document.url}
                    className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    aria-label={`Download ${document.title}`}
                  >
                    <Download className="size-3.5" />
                  </a>
                  {canWrite && (
                    <button
                      type="button"
                      onClick={() => setDocumentToDelete(document)}
                      className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Delete ${document.title}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {documents.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <div className="min-w-0 text-2xs leading-relaxed text-muted-foreground">
            {manualsQuery.isPending ? (
              <span>Loading manual details…</span>
            ) : manualsQuery.isError ? (
              <span>
                Manual-specific details could not be loaded.{" "}
                <button
                  type="button"
                  className="underline underline-offset-4 hover:text-foreground"
                  onClick={() => void manualsQuery.refetch()}
                >
                  Retry
                </button>
              </span>
            ) : profile ? (
              <span>
                Manual identity:{" "}
                <span className="font-medium text-foreground">
                  {[profile.manufacturer, profile.model_identifier, profile.variant]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            ) : (
              <span>
                Exact make/model is not confirmed. Online manual discovery requires it.
              </span>
            )}
          </div>
          {canWrite && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setManualUploadOpen(true)}
              >
                <Plus />
                Add manual
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={openManualLibrary}>
                <Globe2 />
                Find manual
              </Button>
            </div>
          )}
        </div>
      )}

      {searchStatus?.configured && !profile && canWrite && documents.length > 0 && (
        <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
          Online manual search is configured.{" "}
          <button
            type="button"
            className="underline underline-offset-4 hover:text-foreground"
            onClick={openManualLibrary}
          >
            Confirm the exact model to unlock it
          </button>
          .
        </p>
      )}

      <DocumentUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        defaultItemIds={[item.id]}
        defaultType="other"
      />
      <DocumentUploadDialog
        open={manualUploadOpen}
        onOpenChange={setManualUploadOpen}
        defaultItemIds={[item.id]}
        defaultType="manual"
        manualMode
      />
      <DocumentScanDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        defaultItemIds={[item.id]}
        defaultType="other"
      />
      <DocumentLinkDialog
        item={item}
        open={linkOpen}
        onOpenChange={setLinkOpen}
        onUpload={() => setUploadOpen(true)}
      />
      <ManualAskDialog
        item={item}
        manuals={manualsQuery.data}
        open={askOpen}
        onOpenChange={setAskOpen}
      />
      <ManualFindDialog
        item={item}
        open={findOpen}
        onOpenChange={setFindOpen}
        onUploadManual={() => setManualUploadOpen(true)}
      />

      <ConfirmDialog
        open={Boolean(documentToDelete)}
        onOpenChange={(next) => {
          if (!next) setDocumentToDelete(null);
        }}
        title="Delete this document?"
        description="The original and download copy will be removed from every item it is attached to. This cannot be undone."
        confirmLabel="Delete document"
        onConfirm={async () => {
          if (!documentToDelete) return;
          await remove.mutateAsync(documentToDelete.id);
        }}
      />
    </section>
  );
}
