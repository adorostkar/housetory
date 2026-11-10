import { useMutation } from "@tanstack/react-query";
import { Download, Plus, ScanLine, Search, SlidersHorizontal, X } from "lucide-react";
import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { DocumentCard } from "@/components/document-card";
import { DocumentScanDialog } from "@/components/document-scan-dialog";
import { DocumentUploadDialog } from "@/components/document-upload-dialog";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api, getApiErrorMessage } from "@/lib/api";
import { useCanWrite } from "@/lib/queries";
import { DOCUMENT_TYPE_OPTIONS } from "@/lib/labels";
import { useDocuments, useInvalidateInventory } from "@/lib/queries";
import type { DocumentSummary } from "@/lib/types";
import { pluralize } from "@/lib/utils";

export function DocumentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const invalidate = useInvalidateInventory();
  const [search, setSearch] = React.useState(searchParams.get("q") ?? "");
  const debouncedSearch = useDebouncedValue(search, 250);
  const canWrite = useCanWrite();
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [scanOpen, setScanOpen] = React.useState(false);
  const [documentToDelete, setDocumentToDelete] = React.useState<DocumentSummary | null>(null);

  const typeFilter = searchParams.get("type") ?? "";
  const merchantFilter = searchParams.get("merchant") ?? "";
  const dateFrom = searchParams.get("date_from") ?? "";
  const dateTo = searchParams.get("date_to") ?? "";
  const sort = (searchParams.get("sort") ?? "created_desc") as
    | "created_desc"
    | "created_asc"
    | "document_date_desc"
    | "title_asc";

  const documentsQuery = useDocuments({
    q: debouncedSearch.trim() || undefined,
    type: typeFilter || undefined,
    merchant: merchantFilter.trim() || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    sort,
  });

  const remove = useMutation({
    mutationFn: (documentId: string) => api.delete<void>(`/documents/${documentId}`),
    onSuccess: () => {
      invalidate();
      toast.success("Document deleted");
      setDocumentToDelete(null);
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const updateParam = (key: string, value: string) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  };

  const clearFilters = () => {
    setSearch("");
    setSearchParams({}, { replace: true });
  };

  const documents = documentsQuery.data?.items ?? [];
  const hasFilters = Boolean(
    debouncedSearch.trim() || typeFilter || merchantFilter || dateFrom || dateTo,
  );

  return (
    <PageLayout
      header={{
        eyebrow: "Library",
        title: "Documents",
        description: "Receipts, invoices, warranties, manuals and specifications — searchable and linked to the things they belong to.",
        actions: (
          <>
            {documentsQuery.data && documentsQuery.data.total > 0 && (
              <Button variant="outline" asChild>
                <a href="/api/v1/exports/documents.csv">
                  <Download />
                  Export
                </a>
              </Button>
            )}
            {canWrite && (
              <>
                <Button variant="outline" onClick={() => setScanOpen(true)}>
                  <ScanLine />
                  Scan pages
                </Button>
                <Button onClick={() => setUploadOpen(true)}>
                  <Plus />
                  Add document
                </Button>
              </>
            )}
          </>
        ),
      }}
    >
      <div className="surface p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                updateParam("q", event.target.value);
              }}
              placeholder="Search filenames, extracted text, merchants, dates or items…"
              aria-label="Search documents"
              className="h-10 pl-10"
            />
            {search && (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  updateParam("q", "");
                }}
                className="absolute right-2.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
                aria-label="Clear document search"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:w-[680px] lg:shrink-0">
            <Select
              aria-label="Filter by document type"
              value={typeFilter}
              onChange={(event) => updateParam("type", event.target.value)}
              className="h-10 rounded-lg text-xs"
            >
              <option value="">All types</option>
              {DOCUMENT_TYPE_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            <Input
              type="date"
              aria-label="Documents from date"
              value={dateFrom}
              onChange={(event) => updateParam("date_from", event.target.value)}
              className="h-10 text-xs"
            />
            <Input
              type="date"
              aria-label="Documents to date"
              value={dateTo}
              onChange={(event) => updateParam("date_to", event.target.value)}
              className="h-10 text-xs"
            />
            <Select
              aria-label="Sort documents"
              value={sort}
              onChange={(event) => updateParam("sort", event.target.value)}
              className="h-10 rounded-lg text-xs"
            >
              <option value="created_desc">Newest added</option>
              <option value="created_asc">Oldest added</option>
              <option value="document_date_desc">Document date</option>
              <option value="title_asc">Title A–Z</option>
            </Select>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="size-3.5 text-muted-foreground" />
            <Input
              value={merchantFilter}
              onChange={(event) => updateParam("merchant", event.target.value)}
              placeholder="Filter by merchant"
              aria-label="Filter by merchant"
              className="h-8 max-w-56 text-xs"
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-2xs text-muted-foreground">
              {documentsQuery.data
                ? `${pluralize(documentsQuery.data.total, "document")}${hasFilters ? " matching" : ""}`
                : "Loading…"}
            </span>
            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="text-2xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="mt-7">
        {documentsQuery.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-32 rounded-2xl" />
            ))}
          </div>
        ) : documentsQuery.isError ? (
          <ErrorState
            title="The library is out of reach"
            message="We couldn't load your documents just now."
            onRetry={() => void documentsQuery.refetch()}
          />
        ) : documents.length === 0 ? (
          <EmptyState
            title={hasFilters ? "No documents match." : "Your paper trail, in one place."}
            description={
              hasFilters
                ? "Try a broader search, another type, or clear the filters."
                : "Add a receipt, invoice, warranty certificate or manual. Housetory keeps the original file and extracts useful details locally."
            }
            actionLabel={hasFilters ? "Clear filters" : "Scan a document"}
            onAction={
              hasFilters ? clearFilters : canWrite ? () => setScanOpen(true) : undefined
            }
            secondary={
              !hasFilters && canWrite ? (
                <Button variant="ghost" onClick={() => setUploadOpen(true)}>
                  <Plus />
                  Upload a file
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="stagger grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {documents.map((document) => (
              <DocumentCard
                key={document.id}
                document={document}
                onDelete={canWrite ? setDocumentToDelete : undefined}
              />
            ))}
          </div>
        )}
      </div>

      {documentsQuery.data && documentsQuery.data.total > documents.length && (
        <p className="mt-5 text-center text-2xs text-muted-foreground">
          Showing the first {documents.length} of {documentsQuery.data.total} documents.
          Narrow the search to find the rest.
        </p>
      )}

      <DocumentUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUploaded={(document) => {
          navigate(`/documents/${document.id}`);
        }}
      />

      <DocumentScanDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        defaultType="receipt"
        onSaved={(document) => {
          navigate(`/documents/${document.id}`);
        }}
      />

      <ConfirmDialog
        open={Boolean(documentToDelete)}
        onOpenChange={(next) => {
          if (!next) setDocumentToDelete(null);
        }}
        title="Delete this document?"
        description="The original upload and its safe download copy will be removed, and it will be detached from every item. This cannot be undone."
        confirmLabel="Delete document"
        onConfirm={async () => {
          if (!documentToDelete) return;
          await remove.mutateAsync(documentToDelete.id);
        }}
      />
    </PageLayout>
  );
}
