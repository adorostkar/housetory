import {
  BookOpen,
  Download,
  FileText,
  Image as ImageIcon,
  MoreHorizontal,
  ReceiptText,
  ScrollText,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DOCUMENT_TYPE_LABELS, OCR_STATUS_LABELS } from "@/lib/labels";
import type { DocumentSummary, DocumentType } from "@/lib/types";
import { cn, formatDate, formatFileSize, pluralize } from "@/lib/utils";

const controlClass =
  "flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring coarse:size-11";

const TYPE_ICONS: Record<DocumentType, typeof FileText> = {
  receipt: ReceiptText,
  invoice: ReceiptText,
  warranty_certificate: ShieldCheck,
  manual: BookOpen,
  specification: ScrollText,
  other: FileText,
};

/**
 * One document as a short row: icon, title, one line of facts and one control.
 * It fits a 320 px screen. `compact` drops the badges for use inside other lists.
 */
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
    document.ocr_status === "failed"
      ? "destructive"
      : document.ocr_status === "queued" || document.ocr_status === "processing"
        ? "brass"
        : "outline";
  // "Extracted" is the normal state, so only the other states are shown.
  const showOcr = document.ocr_status !== "succeeded";

  return (
    <article
      className={cn(
        "group relative flex min-w-0 items-start gap-3 rounded-xl transition-colors focus-within:ring-2 focus-within:ring-ring/40",
        compact ? "py-3 hover:bg-secondary/25" : "surface p-3 hover:border-brass/40",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary/80 text-muted-foreground">
        <Icon className="size-4" strokeWidth={1.6} />
      </span>
      <div className="min-w-0 flex-1">
        <Link
          to={`/documents/${document.id}`}
          className="block truncate text-sm font-medium underline-offset-4 after:absolute after:inset-0 after:rounded-xl hover:underline focus-visible:outline-none"
        >
          {document.title}
        </Link>
        <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
          {document.merchant ? `${document.merchant} · ` : ""}
          {document.document_date ? `${formatDate(document.document_date)} · ` : ""}
          {formatFileSize(document.byte_size)}
          {document.item_count > 0 ? ` · ${pluralize(document.item_count, "item")}` : ""}
        </p>
        {!compact && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="shrink-0">
              {DOCUMENT_TYPE_LABELS[document.document_type]}
            </Badge>
            {document.page_count > 1 && (
              <Badge variant="secondary" className="shrink-0">
                {pluralize(document.page_count, "page")}
              </Badge>
            )}
            {showOcr && (
              <Badge variant={ocrTone}>OCR: {OCR_STATUS_LABELS[document.ocr_status]}</Badge>
            )}
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
      <div className="relative z-10 -my-1 -mr-1 shrink-0">
        {onDelete ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={controlClass}
                aria-label={`Options for ${document.title}`}
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <a href={document.url} aria-label={`Download ${document.title}`}>
                  <Download />
                  Download
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                destructive
                onSelect={() => onDelete(document)}
                aria-label={`Delete ${document.title}`}
              >
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <a
            href={document.url}
            className={controlClass}
            aria-label={`Download ${document.title}`}
            title="Download"
          >
            <Download className="size-4" />
          </a>
        )}
      </div>
    </article>
  );
}
