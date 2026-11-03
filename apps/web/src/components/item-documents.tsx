import { useMutation } from "@tanstack/react-query";
import { FileText, ImageIcon, Paperclip, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, FormError } from "@/components/form-field";
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
import { useInvalidateInventory } from "@/lib/queries";
import type { ItemDetail, ItemDocument } from "@/lib/types";
import { formatDate, formatFileSize } from "@/lib/utils";

export function ItemDocuments({ item }: { item: ItemDetail }) {
  const invalidate = useInvalidateInventory();
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [documentToDelete, setDocumentToDelete] = React.useState<ItemDocument | null>(null);

  const upload = useMutation({
    mutationFn: () => {
      if (!file) throw new Error("Choose a file first.");
      const formData = new FormData();
      formData.append("file", file);
      if (title.trim()) formData.append("title", title.trim());
      return api.postForm<ItemDocument>(`/items/${item.id}/documents`, formData);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Document attached");
      setOpen(false);
      setTitle("");
      setFile(null);
    },
  });

  const remove = useMutation({
    mutationFn: (documentId: string) => api.delete<void>(`/documents/${documentId}`),
    onSuccess: () => {
      invalidate();
      toast.success("Document removed");
    },
  });

  const generalError = upload.error ? getApiErrorMessage(upload.error) : null;

  return (
    <section className="surface p-5 sm:p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">Documents</h2>
          <p className="mt-1 text-[0.78rem] text-muted-foreground">
            Receipts, manuals and proof of purchase.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Plus />
          Attach
        </Button>
      </div>

      <div className="mt-5">
        {item.documents.length === 0 ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex w-full flex-col items-center justify-center rounded-xl border border-dashed border-border bg-secondary/20 px-4 py-8 text-center transition-colors hover:bg-secondary/40"
          >
            <Paperclip className="size-5 text-muted-foreground/70" strokeWidth={1.5} />
            <span className="mt-3 text-[0.8rem] font-medium">Attach a document</span>
            <span className="mt-1 text-[0.72rem] text-muted-foreground">
              PDF, JPEG, PNG, WebP or plain text
            </span>
          </button>
        ) : (
          <ul className="divide-y divide-border/60">
            {item.documents.map((document) => (
              <li key={document.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary/80 text-muted-foreground">
                  {document.content_type.startsWith("image/") ? (
                    <ImageIcon className="size-4" />
                  ) : (
                    <FileText className="size-4" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <a
                    href={document.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate text-[0.83rem] font-medium hover:underline"
                  >
                    {document.title}
                  </a>
                  <p className="mt-0.5 truncate text-[0.68rem] text-muted-foreground">
                    {formatFileSize(document.byte_size)} · {formatDate(document.created_at)}
                  </p>
                </div>
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

      <Dialog open={open} onOpenChange={(next) => !upload.isPending && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Attach a document</DialogTitle>
            <DialogDescription>
              Keep the receipt, manual or warranty paperwork alongside the item.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              upload.mutate();
            }}
          >
            {generalError && <FormError message={generalError} />}
            <Field label="Document title" htmlFor="document-title" optional>
              <Input
                id="document-title"
                maxLength={200}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Purchase receipt"
              />
            </Field>
            <Field label="File" htmlFor="document-file" hint="Up to 25 MB">
              <Input
                id="document-file"
                type="file"
                required
                accept="application/pdf,image/jpeg,image/png,image/webp,text/plain"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                className="h-auto py-2.5 file:mr-3 file:rounded-full file:bg-secondary file:px-3 file:py-1.5"
              />
            </Field>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={upload.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={!file || upload.isPending}>
                {upload.isPending && <Spinner />}
                Attach document
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(documentToDelete)}
        onOpenChange={(next) => {
          if (!next) setDocumentToDelete(null);
        }}
        title="Delete this document?"
        description="The file will be removed from every item it is attached to. This cannot be undone."
        confirmLabel="Delete document"
        onConfirm={async () => {
          if (!documentToDelete) return;
          await remove.mutateAsync(documentToDelete.id);
          setDocumentToDelete(null);
        }}
      />
    </section>
  );
}
