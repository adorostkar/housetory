import { useMutation } from "@tanstack/react-query";
import { FileText, Paperclip, Plus, Search } from "lucide-react";
import * as React from "react";

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
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import { DOCUMENT_TYPE_LABELS } from "@/lib/labels";
import { useCanWrite, useDocuments, useInvalidateInventory } from "@/lib/queries";
import type { DocumentRecord, ItemDetail } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";

export function DocumentLinkDialog({
  item,
  open,
  onOpenChange,
  onUpload,
}: {
  item: ItemDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpload: () => void;
}) {
  const invalidate = useInvalidateInventory();
  const canWrite = useCanWrite();
  const documentsQuery = useDocuments({}, 100, open);
  const [query, setQuery] = React.useState("");
  const [linkingId, setLinkingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setQuery("");
      setLinkingId(null);
      setError(null);
    }
  }, [open]);

  const link = useMutation({
    mutationFn: (document: DocumentRecord) =>
      api.post<DocumentRecord>(`/documents/${document.id}/items`, {
        item_ids: [item.id],
      }),
    onSuccess: (document) => {
      invalidate();
      toast.success("Document linked to this item", {
        description: document.title,
      });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(getApiErrorMessage(mutationError)),
  });

  const term = query.trim().toLowerCase();
  const available = (documentsQuery.data?.items ?? []).filter((document) => {
    if (document.items.some((linked) => linked.id === item.id)) return false;
    if (!term) return true;
    return [
      document.title,
      document.merchant,
      document.notes,
      document.original_filename,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(term));
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Link an existing document</DialogTitle>
          <DialogDescription>
            Choose a receipt, warranty certificate, manual or other document from
            this household. One library copy can be linked to several items
            without uploading it again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find by title, merchant, type or filename"
              className="pl-9"
              aria-label="Search document library"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/[0.06] px-3 py-2 text-[0.74rem] text-destructive">
              {error}
            </div>
          )}

          <div className="max-h-[52vh] overflow-y-auto overscroll-contain rounded-xl border border-border/60">
            {documentsQuery.isPending ? (
              <div className="flex items-center justify-center gap-2 px-4 py-10 text-[0.76rem] text-muted-foreground">
                <Spinner />
                Loading document library…
              </div>
            ) : documentsQuery.isError ? (
              <div className="flex flex-col items-center justify-center px-4 py-10 text-center text-[0.76rem] text-muted-foreground">
                <p>Document library could not be loaded.</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => void documentsQuery.refetch()}
                >
                  Retry
                </Button>
              </div>
            ) : available.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
                <FileText className="size-5 text-muted-foreground/70" strokeWidth={1.5} />
                <p className="mt-3 text-[0.8rem] font-medium">
                  {term ? "No matching unlinked documents" : "No unlinked documents"}
                </p>
                <p className="mt-1 max-w-sm text-[0.72rem] leading-relaxed text-muted-foreground">
                  {term
                    ? "Try a different title or merchant."
                    : "Upload a new document, then link it here or from the library."}
                </p>
                {canWrite && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={() => {
                      onOpenChange(false);
                      onUpload();
                    }}
                  >
                    <Plus />
                    Upload a document
                  </Button>
                )}
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {available.map((document) => {
                  const pageCount = document.extracted_metadata.ocr_page_count as
                    | number
                    | undefined;
                  return (
                    <li
                      key={document.id}
                      className="flex flex-wrap items-center gap-3 px-3 py-3 sm:flex-nowrap"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="min-w-0 break-words text-[0.8rem] font-medium">
                            {document.title}
                          </span>
                          <Badge variant="outline">
                            {DOCUMENT_TYPE_LABELS[document.document_type]}
                          </Badge>
                          {pageCount ? (
                            <Badge variant="secondary">
                              {pageCount} {pageCount === 1 ? "page" : "pages"}
                            </Badge>
                          ) : null}
                          {document.item_count > 0 && (
                            <Badge variant="secondary">
                              <Paperclip className="mr-1 size-2.5" />
                              {document.item_count} other{" "}
                              {document.item_count === 1 ? "item" : "items"}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-[0.66rem] text-muted-foreground">
                          {document.merchant ? `${document.merchant} · ` : ""}
                          {formatDate(document.created_at)}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={link.isPending}
                        onClick={() => {
                          setError(null);
                          setLinkingId(document.id);
                          link.mutate(document);
                        }}
                      >
                        {link.isPending && linkingId === document.id ? (
                          <Spinner />
                        ) : (
                          <Paperclip />
                        )}
                        Link
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter>
          {canWrite && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
                onUpload();
              }}
              disabled={link.isPending}
            >
              <Plus />
              Upload new document
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
