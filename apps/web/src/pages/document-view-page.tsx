import { useQuery } from "@tanstack/react-query";
import { Download, FileText } from "lucide-react";
import * as React from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { ErrorState } from "@/components/error-state";
import { PageLayout, PageSkeleton } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { DOCUMENT_TYPE_LABELS, isImageContentType } from "@/lib/labels";
import { queryKeys, useDocument } from "@/lib/queries";
import { versionedUrl } from "@/lib/utils";

// pdf.js is large, so it is loaded only when a PDF is opened.
const PdfPages = React.lazy(() =>
  import("@/components/pdf-pages").then((module) => ({ default: module.PdfPages })),
);

const MAX_TEXT_CHARACTERS = 500_000;

/**
 * Shows the file of a document, and nothing else: no extraction review, no
 * processing status and no editing. Those stay on the document's details page.
 */
export function DocumentViewPage() {
  const { documentId = "" } = useParams();
  const [searchParams] = useSearchParams();
  // A link from another household's conversation names that household. The app
  // switches to it first (see App.tsx); nothing is requested before that.
  const switching = searchParams.has("household_id");
  const documentQuery = useDocument(documentId, !switching);
  const document = documentQuery.data;
  const kind = !document
    ? null
    : document.content_type === "application/pdf"
      ? "pdf"
      : isImageContentType(document.content_type)
        ? "image"
        : document.content_type.startsWith("text/")
          ? "text"
          : "other";
  const fileQuery = useQuery({
    queryKey: queryKeys.documentFile(documentId),
    queryFn: async () => {
      const blob = await api.getBlob(`/documents/${documentId}/file`);
      return { blob, text: kind === "text" ? await blob.text() : null };
    },
    enabled: kind === "pdf" || kind === "text",
    // The file is read once per visit and dropped when the page closes.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });

  if (!document) {
    if (switching || documentQuery.isPending) return <PageSkeleton variant="detail" />;
    return (
      <ErrorState
        title="This document is out of reach"
        message="It may have been deleted, or the link may be out of date."
        onRetry={() => void documentQuery.refetch()}
      />
    );
  }
  const page = Number.parseInt(searchParams.get("page") ?? "", 10);
  const text = fileQuery.data?.text;
  return (
    <PageLayout
      header={{
        eyebrow: DOCUMENT_TYPE_LABELS[document.document_type],
        title: document.title,
        description: document.original_filename,
        backTo: "/documents",
        backLabel: "Documents",
        actions: (
          <>
            <Button variant="outline" asChild>
              <a href={document.url}>
                <Download />
                Download
              </a>
            </Button>
            <Button variant="outline" asChild>
              <Link to={`/documents/${document.id}`}>
                <FileText />
                Details
              </Link>
            </Button>
          </>
        ),
      }}
    >
      {kind === "image" ? (
        <div className="flex justify-center rounded-xl bg-secondary/30 p-3">
          <img
            src={versionedUrl(document.url, document.updated_at)}
            alt={document.title}
            className="max-w-full rounded-lg shadow-sm"
          />
        </div>
      ) : kind === "other" || fileQuery.isError ? (
        <p role="alert" className="surface px-5 py-10 text-center text-sm text-muted-foreground">
          This file cannot be shown here. Download it to open it in another app.
        </p>
      ) : !fileQuery.data ? (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner /> Opening the file…
        </p>
      ) : typeof text === "string" ? (
        <section aria-label={`Text of ${document.title}`} className="surface p-5">
          <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed">
            {text.slice(0, MAX_TEXT_CHARACTERS)}
          </pre>
          {text.length > MAX_TEXT_CHARACTERS && (
            <p className="mt-4 text-xs text-muted-foreground">
              Only the first part is shown. Download the file to read all of it.
            </p>
          )}
        </section>
      ) : (
        <React.Suspense
          fallback={
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner /> Opening the file…
            </p>
          }
        >
          <PdfPages
            file={fileQuery.data.blob}
            title={document.title}
            initialPage={Number.isFinite(page) ? page : 1}
          />
        </React.Suspense>
      )}
    </PageLayout>
  );
}
