import * as React from "react";
import { Link } from "react-router-dom";

import { DocumentExtractionReview } from "@/components/document-extraction-review";
import { DocumentProcessingStatus } from "@/components/document-processing-status";
import { useDocument } from "@/lib/queries";

export function AssistantDocumentReview({ id, enabled }: { id: string; enabled: boolean }) {
  const documentQuery = useDocument(id, enabled);
  const [manualRequest, setManualRequest] = React.useState(0);
  const document = documentQuery.data;
  if (documentQuery.isError) {
    return <p role="alert" className="text-xs">Document review is unavailable. Check your access and try again.</p>;
  }
  if (!document) return <p role="status" className="text-xs">Loading document review…</p>;
  return (
    <section className="space-y-3" aria-label="Assistant document review">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="min-w-0 break-words text-sm font-medium">Document review: {document.title}</h2>
        <Link to={`/documents/${document.id}`} className="text-xs underline underline-offset-4">Open document</Link>
      </div>
      <DocumentProcessingStatus documentId={document.id} enabled={enabled} onManualReview={() => setManualRequest((value) => value + 1)} />
      <div className="surface p-4">
        <DocumentExtractionReview document={document} enabled={enabled} manualReviewRequest={manualRequest} />
      </div>
    </section>
  );
}
