import { useMutation } from "@tanstack/react-query";
import { Download, Paperclip, Plus, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import * as React from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { DocumentUploadDialog } from "@/components/document-upload-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, getApiErrorMessage } from "@/lib/api";
import { DOCUMENT_TYPE_LABELS } from "@/lib/labels";
import { useInvalidateInventory } from "@/lib/queries";
import type { DocumentRecord, ItemDetail } from "@/lib/types";
import { formatDate, formatFileSize } from "@/lib/utils";

export function ItemDocuments({ item }: { item: ItemDetail }) {
  const invalidate = useInvalidateInventory();
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [documentToDelete, setDocumentToDelete] = React.useState<DocumentRecord | null>(null);

  const remove = useMutation({
    mutationFn: (documentId: string) => api.delete<void>(`/documents/${documentId}`),
    onSuccess: () => {
      invalidate();
      toast.success("Document removed");
      setDocumentToDelete(null);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  return (
    <section className="surface p-5 sm:p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
            Documents
          </h2>
          <p className="mt-1 text-[0.78rem] text-muted-foreground">
            Receipts, manuals, warranty certificates and proof of purchase.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/documents">Library</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setUploadOpen(true)}>
            <Plus />
            Attach
          </Button>
        </div>
      </div>

      <div className="mt-5">
        {item.documents.length === 0 ? (
          <button
            type="button"
            onClick={() => setUploadOpen(true)}
            className="flex w-full flex-col items-center justify-center rounded-xl border border-dashed border-border bg-secondary/20 px-4 py-8 text-center transition-colors hover:bg-secondary/40"
          >
            <Paperclip className="size-5 text-muted-foreground/70" strokeWidth={1.5} />
            <span className="mt-3 text-[0.8rem] font-medium">Attach a document</span>
            <span className="mt-1 text-[0.72rem] text-muted-foreground">
              PDF, JPEG, PNG, WebP, HEIC or plain text
            </span>
          </button>
        ) : (
          <ul className="divide-y divide-border/60">
            {item.documents.map((document) => (
              <li
                key={document.id}
                className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link
                      to={`/documents/${document.id}`}
                      className="truncate text-[0.83rem] font-medium underline-offset-4 hover:underline"
                    >
                      {document.title}
                    </Link>
                    <Badge variant="outline">
                      {DOCUMENT_TYPE_LABELS[document.document_type]}
                    </Badge>
                    {document.item_count > 1 && (
                      <Badge variant="secondary">{document.item_count} items</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-[0.68rem] text-muted-foreground">
                    {document.merchant ? `${document.merchant} · ` : ""}
                    {formatFileSize(document.byte_size)} · {formatDate(document.created_at)}
                  </p>
                </div>
                <a
                  href={document.url}
                  className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  aria-label={`Download ${document.title}`}
                >
                  <Download className="size-3.5" />
                </a>
                <button
                  type="button"
                  onClick={() => setDocumentToDelete(document)}
                  className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Delete ${document.title}`}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <DocumentUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        defaultItemIds={[item.id]}
        defaultType="other"
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
