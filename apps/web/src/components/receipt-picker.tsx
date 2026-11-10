import { FileUp, ScanLine } from "lucide-react";
import * as React from "react";

import { DocumentScanDialog } from "@/components/document-scan-dialog";
import { DocumentUploadDialog } from "@/components/document-upload-dialog";
import { Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { DOCUMENT_TYPE_LABELS } from "@/lib/labels";
import { useDocument, useDocuments } from "@/lib/queries";
import type { DocumentRecord } from "@/lib/types";

/**
 * Receipt chooser for purchases. Lists only receipts and invoices by default so
 * manuals and certificates do not bury the right document, and lets the user add
 * a new receipt (upload or scan) without leaving the form.
 */
export function ReceiptPicker({
  id,
  value,
  onChange,
  canWrite = true,
}: {
  id: string;
  value: string;
  onChange: (documentId: string) => void;
  canWrite?: boolean;
}) {
  const [showAll, setShowAll] = React.useState(false);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [scanOpen, setScanOpen] = React.useState(false);
  const receipts = useDocuments({ type: "receipt" }, 100, !showAll);
  const invoices = useDocuments({ type: "invoice" }, 100, !showAll);
  const everything = useDocuments({}, 100, showAll);
  const selected = useDocument(value || undefined);

  const options = React.useMemo(() => {
    const documents: DocumentRecord[] = showAll
      ? (everything.data?.items ?? [])
      : [...(receipts.data?.items ?? []), ...(invoices.data?.items ?? [])];
    const byId = new Map(documents.map((document) => [document.id, document]));
    // A linked document must stay selectable even if it is not a receipt.
    if (value && !byId.has(value) && selected.data) byId.set(value, selected.data);
    return [...byId.values()];
  }, [everything.data, invoices.data, receipts.data, selected.data, showAll, value]);

  const choose = (document: DocumentRecord) => onChange(document.id);

  return (
    <Field label="Receipt document" htmlFor={id} optional>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">No receipt linked</option>
        {options.map((document) => (
          <option key={document.id} value={document.id}>
            {document.title} · {DOCUMENT_TYPE_LABELS[document.document_type]}
          </option>
        ))}
      </Select>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {canWrite && (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => setScanOpen(true)}>
              <ScanLine />
              Scan receipt
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
              <FileUp />
              Upload receipt
            </Button>
          </>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-2xs text-muted-foreground">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(event) => setShowAll(event.target.checked)}
          />
          Show all document types
        </label>
      </div>
      <DocumentScanDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        defaultType="receipt"
        onSaved={choose}
      />
      <DocumentUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        defaultType="receipt"
        onUploaded={choose}
      />
    </Field>
  );
}
