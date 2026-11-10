import { ScanLine, Upload } from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router-dom";

import { DocumentScanDialog } from "@/components/document-scan-dialog";
import { DocumentUploadDialog } from "@/components/document-upload-dialog";
import { Button } from "@/components/ui/button";

/**
 * Entry point for "create items from an invoice": scan or upload a receipt, then
 * land on the document's extraction review where items, purchase and receipt link
 * are confirmed.
 */
export function InvoiceImportButtons() {
  const navigate = useNavigate();
  const [scanOpen, setScanOpen] = React.useState(false);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const open = (id: string) => navigate(`/documents/${id}`);
  return (
    <>
      <Button variant="outline" onClick={() => setScanOpen(true)}>
        <ScanLine />
        Scan invoice
      </Button>
      <Button variant="outline" onClick={() => setUploadOpen(true)}>
        <Upload />
        Upload invoice
      </Button>
      <DocumentScanDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        defaultType="receipt"
        onSaved={(document) => open(document.id)}
      />
      <DocumentUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        defaultType="receipt"
        onUploaded={(document) => open(document.id)}
      />
    </>
  );
}
