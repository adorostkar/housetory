import {
  BookOpen,
  ChevronRight,
  Download,
  FileText,
  Image as ImageIcon,
  ReceiptText,
  ScrollText,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { DOCUMENT_TYPE_LABELS, OCR_STATUS_LABELS } from "@/lib/labels";
import type { DocumentSummary, DocumentType } from "@/lib/types";
import { formatDate, formatFileSize, pluralize } from "@/lib/utils";

const TYPE_ICONS: Record<DocumentType, typeof FileText> = {
  receipt: ReceiptText,
  invoice: ReceiptText,
  warranty_certificate: ShieldCheck,
  manual: BookOpen,
  specification: ScrollText,
  other: FileText,
};

export function DocumentCard({
  document,
  onDelete,
  compact = false,
}: {
  document: DocumentSummary;
  onDelete?: (document: DocumentSummary) => void;
  compact?: boolean;
}) {
  const Icon = document.content_type.startsWith("image/")
    ? ImageIcon
    : TYPE_ICONS[document.document_type] ?? FileText;
  const ocrTone =
    document.ocr_status === "succeeded"
      ? "sage"
      : document.ocr_status === "failed"
        ? "destructive"
        : document.ocr_status === "queued" || document.ocr_status === "processing"
          ? "brass"
          : "outline";

  return (
    <article className={`relative group rounded-xl transition-colors focus-within:ring-2 focus-within:ring-ring/40 ${compact ? "flex items-center gap-3 py-3 hover:bg-secondary/25" : "surface p-4 hover:border-brass/40 sm:p-5"}`}>
      <span
        className={
          compact
            ? "flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary/80 text-muted-foreground"
            : "flex size-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground/55 transition-colors group-hover:text-foreground"
        }
      >
        <Icon className={compact ? "size-4" : "size-5"} strokeWidth={1.6} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            to={`/documents/${document.id}`}
            className="min-w-0 truncate text-sm font-medium underline-offset-4 after:absolute after:inset-0 after:rounded-xl hover:underline focus-visible:outline-none"
          >
            {document.title}
          </Link>
          {!compact && (
            <Badge variant="outline" className="shrink-0">
              {DOCUMENT_TYPE_LABELS[document.document_type]}
            </Badge>
          )}
          {!compact && document.page_count > 1 && (
            <Badge variant="secondary" className="shrink-0">
              {pluralize(document.page_count, "page")}
            </Badge>
          )}
          <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden />
        </div>
        <p className="mt-1 truncate text-2xs text-muted-foreground">
          {document.merchant ? `${document.merchant} · ` : ""}
          {document.document_date ? `${formatDate(document.document_date)} · ` : ""}
          {formatFileSize(document.byte_size)}
          {document.item_count > 0 ? ` · ${pluralize(document.item_count, "item")}` : ""}
        </p>
        {!compact && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <Badge variant={ocrTone}>OCR: {OCR_STATUS_LABELS[document.ocr_status]}</Badge>
            {document.items.slice(0, 2).map((item) => (
              <Link
                key={item.id}
                to={`/items/${item.id}`}
                className="relative z-10 min-w-0 max-w-full"
                title={item.name}
              >
                <Badge variant="secondary" className="max-w-full hover:bg-secondary/70">
                  <span className="truncate">{item.name}</span>
                </Badge>
              </Link>
            ))}
            {document.items.length > 2 && (
              <span className="text-2xs text-muted-foreground">
                +{document.items.length - 2}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="relative z-10 flex w-fit shrink-0 items-center gap-0.5">
        <a
          href={document.url}
          className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label={`Download ${document.title}`}
          title="Download"
        >
          <Download className="size-3.5" />
        </a>
        {onDelete && (
          <button
            type="button"
            onClick={() => onDelete(document)}
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            aria-label={`Delete ${document.title}`}
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
    </article>
  );
}
