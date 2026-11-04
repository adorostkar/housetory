import { useMutation } from "@tanstack/react-query";
import {
  ArrowRight,
  FileArchive,
  FileText,
  Loader2,
  Plus,
  Sparkles,
  Upload,
} from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
import { Field, FormError } from "@/components/form-field";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  IMPORT_SOURCE_LABELS,
  IMPORT_STATUS_LABELS,
  IMPORT_STATUS_TONE,
} from "@/lib/labels";
import { useImports } from "@/lib/queries";
import type { ImportBatch, ImportBatchDetail } from "@/lib/types";
import { formatDate, formatFileSize, pluralize } from "@/lib/utils";

const MODES = [
  { id: "paste", label: "Paste notes", icon: FileText },
  { id: "file", label: "Upload file", icon: Upload },
  { id: "vault", label: "Obsidian vault", icon: FileArchive },
] as const;

type Mode = (typeof MODES)[number]["id"];

export function ImportsPage() {
  const navigate = useNavigate();
  const importsQuery = useImports();
  const [mode, setMode] = React.useState<Mode>("paste");
  const [title, setTitle] = React.useState("");
  const [text, setText] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);

  const createImport = useMutation({
    mutationFn: () => {
      const formData = new FormData();
      if (title.trim()) formData.append("title", title.trim());
      if (mode === "paste") {
        if (!text.trim()) throw new Error("Paste some notes first.");
        formData.append("text", text);
      } else {
        if (!file) throw new Error("Choose a file first.");
        formData.append("file", file);
      }
      return api.postForm<ImportBatchDetail>("/imports", formData);
    },
    onSuccess: (batch) => {
      toast.success("Import queued");
      navigate(`/imports/${batch.id}`);
    },
  });

  const imports = importsQuery.data?.items ?? [];

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Intelligence"
        title="Import"
        description="Turn notes, spreadsheets, documents, images or an Obsidian vault into proposed inventory entries for review."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/items/new">
                <Plus />
                Add manually
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/assistant">
                <Sparkles />
                Ask Housetory
              </Link>
            </Button>
          </>
        }
      />

      <section className="surface overflow-hidden">
        <div className="flex flex-wrap gap-1.5 border-b border-border/60 p-3 sm:p-4">
          {MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                setMode(entry.id);
                setFile(null);
                createImport.reset();
              }}
              aria-pressed={mode === entry.id}
              className={
                mode === entry.id
                  ? "inline-flex items-center gap-2 rounded-full bg-primary px-3.5 py-2 text-[0.75rem] font-medium text-primary-foreground"
                  : "inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-[0.75rem] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              }
            >
              <entry.icon className="size-3.5" />
              {entry.label}
            </button>
          ))}
        </div>
        <form
          className="space-y-5 p-5 sm:p-6"
          onSubmit={(event) => {
            event.preventDefault();
            createImport.mutate();
          }}
        >
          {createImport.error && (
            <FormError message={getApiErrorMessage(createImport.error)} />
          )}
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div>
              {mode === "paste" ? (
                <Field
                  label="Notes"
                  htmlFor="import-text"
                  hint="Natural language, bullet lists, Markdown tables and pasted notes are supported."
                >
                  <Textarea
                    id="import-text"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    placeholder={
                      "Winter clothes are in the blue boxes in the attic.\\nTwo suitcases are stored under the guest bed.\\nCamera equipment is in the office cupboard."
                    }
                    className="min-h-44 font-mono text-[0.78rem] leading-relaxed"
                  />
                </Field>
              ) : (
                <Field
                  label={mode === "vault" ? "Obsidian vault ZIP" : "Source file"}
                  htmlFor="import-file"
                  hint={
                    mode === "vault"
                      ? "ZIP containing Markdown notes and attachments. Path traversal, symlinks, file-count and size limits are enforced."
                      : "TXT, Markdown, CSV, XLSX, DOCX, PDF or an image of a list."
                  }
                >
                  <label
                    htmlFor="import-file"
                    className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-border bg-secondary/20 px-4 py-8 transition-colors hover:bg-secondary/40"
                  >
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                      {mode === "vault" ? (
                        <FileArchive className="size-5" />
                      ) : (
                        <Upload className="size-5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.85rem] font-medium">
                        {file ? file.name : "Choose a file"}
                      </span>
                      <span className="mt-1 block text-[0.7rem] text-muted-foreground">
                        {file
                          ? formatFileSize(file.size)
                          : mode === "vault"
                            ? "Select the .zip vault archive"
                            : "Tap to browse or take a photo"}
                      </span>
                    </span>
                  </label>
                  <input
                    id="import-file"
                    type="file"
                    className="sr-only"
                    accept={
                      mode === "vault"
                        ? ".zip,application/zip"
                        : ".txt,.md,.markdown,.csv,.xlsx,.docx,.pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
                    }
                    onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  />
                </Field>
              )}
            </div>
            <div className="space-y-4">
              <Field label="Import name" htmlFor="import-title" optional>
                <Input
                  id="import-title"
                  value={title}
                  maxLength={200}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={mode === "vault" ? "Obsidian vault" : "Household notes"}
                />
              </Field>
              <div className="rounded-xl border border-border/70 bg-secondary/25 p-4 text-[0.72rem] leading-relaxed text-muted-foreground">
                <p className="flex items-center gap-1.5 font-medium text-foreground/80">
                  <Sparkles className="size-3.5 text-brass" />
                  Nothing is created automatically
                </p>
                <p className="mt-2">
                  Processing runs in the background. You will review every proposed
                  entry, resolve duplicates and missing locations, then approve what
                  gets created.
                </p>
                <p className="mt-2">
                  AI is optional. Deterministic extraction works without a model; local
                  Ollama can improve difficult notes when configured.
                </p>
              </div>
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={
                  createImport.isPending ||
                  (mode === "paste" ? !text.trim() : !file)
                }
              >
                {createImport.isPending ? <Spinner /> : <Sparkles />}
                Process import
              </Button>
            </div>
          </div>
        </form>
      </section>

      <section className="mt-10">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-[1.55rem] tracking-[-0.025em]">Import history</h2>
            <p className="mt-1 text-[0.78rem] text-muted-foreground">
              Sources, processing state and approved records.
            </p>
          </div>
        </div>
        {importsQuery.isPending ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-24 rounded-2xl" />
            ))}
          </div>
        ) : imports.length === 0 ? (
          <EmptyState
            title="No imports yet."
            description="Start with a few sentences about where things live, or upload an existing inventory spreadsheet."
            actionLabel="Paste your first notes"
            onAction={() => {
              setMode("paste");
              document.getElementById("import-text")?.focus();
            }}
          />
        ) : (
          <div className="stagger space-y-3">
            {imports.map((batch) => (
              <ImportHistoryCard key={batch.id} batch={batch} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ImportHistoryCard({ batch }: { batch: ImportBatch }) {
  return (
    <Link
      to={`/imports/${batch.id}`}
      className="surface group flex flex-col gap-3 p-4 transition-[border-color,transform,box-shadow] hover:-translate-y-0.5 hover:border-border hover:shadow-lift sm:flex-row sm:items-center sm:p-5"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
        {batch.status === "processing" || batch.status === "queued" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <FileText className="size-4" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-[0.88rem] font-medium">{batch.title}</h3>
          <Badge variant={IMPORT_STATUS_TONE[batch.status] ?? "outline"}>
            {IMPORT_STATUS_LABELS[batch.status] ?? batch.status}
          </Badge>
          <Badge variant="outline">
            {IMPORT_SOURCE_LABELS[batch.source_type] ?? batch.source_type}
          </Badge>
        </div>
        <p className="mt-1 truncate text-[0.7rem] text-muted-foreground">
          {formatDate(batch.created_at)}
          {batch.original_filename ? ` · ${batch.original_filename}` : ""}
          {batch.total_entries ? ` · ${pluralize(batch.total_entries, "proposal")}` : ""}
        </p>
        {batch.error && (
          <p className="mt-1 line-clamp-1 text-[0.7rem] text-destructive">{batch.error}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-4 text-[0.7rem] text-muted-foreground">
        <span>{batch.imported_entries} imported</span>
        <span>{batch.skipped_entries} skipped</span>
        <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}
