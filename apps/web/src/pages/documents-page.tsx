import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Download, Plus, ScanLine, Search, SlidersHorizontal, X } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
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
import { formatDate, pluralize } from "@/lib/utils";

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
  const [filtersOpen, setFiltersOpen] = React.useState(false);

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
  // The search stays in view, so it is not counted as a filter.
  const filterChips = [
    typeFilter
      ? {
          key: "type",
          label:
            DOCUMENT_TYPE_OPTIONS.find(([value]) => value === typeFilter)?.[1] ?? typeFilter,
        }
      : null,
    merchantFilter ? { key: "merchant", label: `Merchant: ${merchantFilter}` } : null,
    dateFrom ? { key: "date_from", label: `From ${formatDate(dateFrom)}` } : null,
    dateTo ? { key: "date_to", label: `To ${formatDate(dateTo)}` } : null,
  ].filter((chip): chip is NonNullable<typeof chip> => chip !== null);
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
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[10rem] flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              updateParam("q", event.target.value);
            }}
            placeholder="Search documents"
            aria-label="Search documents"
            className={search ? "pl-10 pr-11" : "pl-10"}
          />
          {search && (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                updateParam("q", "");
              }}
              className="absolute right-0 top-0 flex size-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              aria-label="Clear document search"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <button
          type="button"
          className="flex h-11 shrink-0 items-center gap-2 rounded-lg border border-input/90 bg-card/65 px-3 text-sm text-foreground transition-colors hover:bg-secondary/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-expanded={filtersOpen}
          aria-controls="document-filters"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden="true" />
          <span>Filters</span>
          {filterChips.length > 0 && (
            <Badge variant="secondary" className="px-1.5 py-0 text-2xs">
              <span className="sr-only">Active filters: </span>
              {filterChips.length}
            </Badge>
          )}
          <ChevronDown
            aria-hidden="true"
            className={
              filtersOpen
                ? "size-4 rotate-180 text-muted-foreground transition-transform"
                : "size-4 text-muted-foreground transition-transform"
            }
          />
        </button>
      </div>

      {(filtersOpen || filterChips.length > 0) && (
        <div className="surface mb-2 p-3.5">
          {filtersOpen && (
            <div
              id="document-filters"
              className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] items-end gap-2"
            >
              <Select
                aria-label="Filter by document type"
                value={typeFilter}
                onChange={(event) => updateParam("type", event.target.value)}
                className="rounded-lg text-sm"
              >
                <option value="">All types</option>
                {DOCUMENT_TYPE_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
              <Input
                value={merchantFilter}
                onChange={(event) => updateParam("merchant", event.target.value)}
                placeholder="Merchant"
                aria-label="Filter by merchant"
                className="rounded-lg text-sm"
              />
              <label className="block min-w-0 text-2xs text-muted-foreground">
                From
                <Input
                  type="date"
                  aria-label="Documents from date"
                  value={dateFrom}
                  onChange={(event) => updateParam("date_from", event.target.value)}
                  className="mt-0.5 rounded-lg text-sm"
                />
              </label>
              <label className="block min-w-0 text-2xs text-muted-foreground">
                To
                <Input
                  type="date"
                  aria-label="Documents to date"
                  value={dateTo}
                  onChange={(event) => updateParam("date_to", event.target.value)}
                  className="mt-0.5 rounded-lg text-sm"
                />
              </label>
              <Select
                aria-label="Sort documents"
                value={sort}
                onChange={(event) => updateParam("sort", event.target.value)}
                className="rounded-lg text-sm"
              >
                <option value="created_desc">Newest added</option>
                <option value="created_asc">Oldest added</option>
                <option value="document_date_desc">Document date</option>
                <option value="title_asc">Title A–Z</option>
              </Select>
            </div>
          )}
          {filterChips.length > 0 && (
            <div
              className={
                filtersOpen
                  ? "mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-3"
                  : "flex flex-wrap items-center gap-1.5"
              }
            >
              {filterChips.map((chip) => (
                <Badge key={chip.key} variant="secondary" className="gap-1 py-0 pl-2.5 pr-0 text-2xs">
                  <span className="max-w-56 truncate">{chip.label}</span>
                  <button
                    type="button"
                    onClick={() => updateParam(chip.key, "")}
                    className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground sm:size-7"
                    aria-label={`Remove ${chip.label}`}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mb-3 flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-2xs text-muted-foreground">
          {documentsQuery.data
            ? `${pluralize(documentsQuery.data.total, "document")}${hasFilters ? " matching" : ""}`
            : "Loading…"}
        </span>
        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="min-h-9 text-2xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline coarse:min-h-11"
          >
            Clear filters
          </button>
        )}
      </div>

      <div>
        {documentsQuery.isPending ? (
          <div className="grid gap-2 md:grid-cols-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-20 rounded-xl" />
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
          <div className="grid gap-2 md:grid-cols-2">
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

      {/* The file is saved as soon as it is chosen; the dialog offers the optional steps. */}
      <DocumentUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />

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
