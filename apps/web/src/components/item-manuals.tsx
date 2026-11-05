import { BookOpen, Download, Globe2, MessageCircle, Paperclip, Plus, Search } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { ManualAskDialog } from "@/components/manual-ask-dialog";
import { ManualAttachDialog } from "@/components/manual-attach-dialog";
import { ManualFindDialog } from "@/components/manual-find-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DocumentUploadDialog } from "@/components/document-upload-dialog";
import { useCanWrite, useItemManuals } from "@/lib/queries";
import type { DocumentRecord, ItemDetail } from "@/lib/types";
import { formatDate, formatFileSize } from "@/lib/utils";

export function ItemManuals({ item }: { item: ItemDetail }) {
  const canWrite = useCanWrite();
  const manualsQuery = useItemManuals(item.id);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [attachOpen, setAttachOpen] = React.useState(false);
  const [askOpen, setAskOpen] = React.useState(false);
  const [findOpen, setFindOpen] = React.useState(false);

  const manuals = manualsQuery.data?.manuals ?? [];
  const profile = manualsQuery.data?.search.profile;
  const searchStatus = manualsQuery.data?.search;

  return (
    <section className="surface p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BookOpen className="size-4 text-muted-foreground" strokeWidth={1.7} />
            <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
              Manuals &amp; help
            </h2>
          </div>
          <p className="mt-1 text-[0.76rem] leading-relaxed text-muted-foreground">
            Attached manuals stay in the Manual library. Ask answers from their actual text and
            cites the source page or excerpt.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => setAskOpen(true)}>
          <MessageCircle />
          Ask about this item
        </Button>
      </div>

      <div className="mt-4">
        {manualsQuery.isPending ? (
          <div className="rounded-xl border border-dashed border-border/70 px-4 py-5 text-[0.74rem] text-muted-foreground">
            Loading attached manuals…
          </div>
        ) : manualsQuery.isError ? (
          <div className="rounded-xl border border-border/70 px-4 py-4 text-[0.74rem] text-muted-foreground">
            Manuals could not be loaded.{" "}
            <button
              type="button"
              className="underline underline-offset-4 hover:text-foreground"
              onClick={() => void manualsQuery.refetch()}
            >
              Retry
            </button>
          </div>
        ) : manuals.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-secondary/20 px-4 py-6 text-center">
            <BookOpen className="size-5 text-muted-foreground/70" strokeWidth={1.5} />
            <p className="mt-2 text-[0.8rem] font-medium">No manual attached yet</p>
            <p className="mt-1 max-w-md text-[0.7rem] leading-relaxed text-muted-foreground">
              Add a PDF or photo without entering make/model, or attach a manual already in the
              household library.
            </p>
            {canWrite && (
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
                  <Plus />
                  Add manual
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setAttachOpen(true)}>
                  <Paperclip />
                  Attach existing
                </Button>
              </div>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {manuals.map((manual) => (
              <ManualRow key={manual.id} manual={manual} />
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
        <div className="min-w-0 text-[0.68rem] leading-relaxed text-muted-foreground">
          {profile ? (
            <span>
              Confirmed identity:{" "}
              <span className="font-medium text-foreground">
                {[profile.manufacturer, profile.model_identifier, profile.variant]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
          ) : (
            <span>Exact make/model is not confirmed for online discovery.</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {canWrite && (
            <>
              <Button type="button" size="sm" variant="ghost" onClick={() => setUploadOpen(true)}>
                <Plus />
                Add manual
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAttachOpen(true)}>
                <Paperclip />
                Attach existing
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setFindOpen(true)}>
                <Globe2 />
                Find manual
              </Button>
            </>
          )}
        </div>
      </div>

      {searchStatus?.configured && !profile && canWrite && (
        <p className="mt-2 text-[0.66rem] leading-relaxed text-muted-foreground">
          Online search is configured.{" "}
          <button
            type="button"
            className="underline underline-offset-4 hover:text-foreground"
            onClick={() => setFindOpen(true)}
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
        defaultType="manual"
        manualMode
      />

      <ManualAttachDialog
        item={item}
        open={attachOpen}
        onOpenChange={setAttachOpen}
        onUploadManual={() => setUploadOpen(true)}
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
        onUploadManual={() => setUploadOpen(true)}
      />
    </section>
  );
}

function ManualRow({ manual }: { manual: DocumentRecord }) {
  const pageCount = manual.extracted_metadata.ocr_page_count as number | undefined;
  const reading = manual.ocr_status === "queued" || manual.ocr_status === "processing";
  return (
    <li className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            to={`/documents/${manual.id}`}
            className="min-w-0 break-words text-[0.83rem] font-medium underline-offset-4 hover:underline"
          >
            {manual.title}
          </Link>
          {reading ? (
            <Badge variant="secondary">Reading…</Badge>
          ) : pageCount ? (
            <Badge variant="outline">{pageCount} pages</Badge>
          ) : null}
          {manual.item_count > 1 && (
            <Badge variant="secondary">{manual.item_count} items</Badge>
          )}
        </div>
        <p className="mt-0.5 text-[0.66rem] text-muted-foreground">
          {manual.merchant ? `${manual.merchant} · ` : ""}
          {formatFileSize(manual.byte_size)} · {formatDate(manual.created_at)}
        </p>
      </div>
      <Link
        to={`/documents/${manual.id}`}
        className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        aria-label={`Read ${manual.title}`}
      >
        <Search className="size-3.5" />
      </Link>
      <a
        href={manual.url}
        className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        aria-label={`Download ${manual.title}`}
      >
        <Download className="size-3.5" />
      </a>
    </li>
  );
}
