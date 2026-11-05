import { useMutation } from "@tanstack/react-query";
import { BookOpen, Paperclip, Plus, Search } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

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
import { useCanWrite, useDocuments, useInvalidateInventory } from "@/lib/queries";
import type { DocumentRecord, ItemDetail } from "@/lib/types";
import { formatDate } from "@/lib/utils";

export function ManualAttachDialog({
  item,
  open,
  onOpenChange,
  onUploadManual,
}: {
  item: ItemDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploadManual: () => void;
}) {
  const invalidate = useInvalidateInventory();
  const canWrite = useCanWrite();
  const documentsQuery = useDocuments({ type: "manual" }, 100, open);
  const [query, setQuery] = React.useState("");
  const [attachingId, setAttachingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setQuery("");
      setAttachingId(null);
      setError(null);
    }
  }, [open]);

  const attach = useMutation({
    mutationFn: (document: DocumentRecord) =>
      api.post<DocumentRecord>(`/items/${item.id}/manuals/${document.id}`),
    onSuccess: (document) => {
      invalidate();
      toast.success("Manual attached to this item", {
        description: document.title,
      });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(getApiErrorMessage(mutationError)),
  });

  const term = query.trim().toLowerCase();
  const available = (documentsQuery.data?.items ?? []).filter((document) => {
    if (document.document_type !== "manual") return false;
    if (document.items.some((linked) => linked.id === item.id)) return false;
    if (!term) return true;
    return [document.title, document.merchant, document.notes, document.original_filename]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(term));
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Attach an existing manual</DialogTitle>
          <DialogDescription>
            Choose a document from the household Manual library. A manual can be linked to
            several compatible items without uploading another copy.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find by title, merchant or filename"
              className="pl-9"
              aria-label="Search manual library"
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
                Loading manual library…
              </div>
            ) : available.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
                <BookOpen className="size-5 text-muted-foreground/70" strokeWidth={1.5} />
                <p className="mt-3 text-[0.8rem] font-medium">
                  {term ? "No matching manuals" : "No unlinked manuals yet"}
                </p>
                <p className="mt-1 max-w-sm text-[0.72rem] leading-relaxed text-muted-foreground">
                  {term
                    ? "Try a different title, or upload the manual from a source you trust."
                    : "Upload a manual without make/model fields, then attach it here or from the Manual library."}
                </p>
                {canWrite && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={() => {
                      onOpenChange(false);
                      onUploadManual();
                    }}
                  >
                    <Plus />
                    Upload a manual
                  </Button>
                )}
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {available.map((document) => {
                  const duplicateDocuments = document.extracted_metadata
                    .duplicate_documents as Array<{ title: string }> | undefined;
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
                        {document.item_count > 0 && (
                          <Badge variant="outline">
                            <Paperclip className="mr-1 size-2.5" />
                            {document.item_count} other{" "}
                            {document.item_count === 1 ? "item" : "items"}
                          </Badge>
                        )}
                        {(document.extracted_metadata.ocr_page_count as number | undefined) ? (
                          <Badge variant="secondary">
                            {String(document.extracted_metadata.ocr_page_count)} pages
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-[0.66rem] text-muted-foreground">
                        {document.merchant ? `${document.merchant} · ` : ""}
                        {formatDate(document.created_at)}
                      </p>
                      {document.item_count > 0 && (
                        <p className="mt-1 text-[0.66rem] leading-relaxed text-brass">
                          This manual is already linked elsewhere. Attach it only if it covers
                          this exact item and variant.
                        </p>
                      )}
                      {duplicateDocuments && duplicateDocuments.length > 0 && (
                        <p className="mt-1 text-[0.66rem] leading-relaxed text-muted-foreground">
                          The same file is also stored as “{duplicateDocuments[0]?.title}”.
                          Consider using one library copy.
                        </p>
                      )}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={attach.isPending}
                      onClick={() => {
                        setError(null);
                        setAttachingId(document.id);
                        attach.mutate(document);
                      }}
                    >
                      {attach.isPending && attachingId === document.id ? (
                        <Spinner />
                      ) : (
                        <Paperclip />
                      )}
                      Attach
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
                onUploadManual();
              }}
              disabled={attach.isPending}
            >
              <Plus />
              Upload new manual
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={attach.isPending}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
