import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ImagePlus,
  Loader2,
  RotateCcw,
  RotateCw,
  ScanLine,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
import { ItemMultiSelect } from "@/components/item-multi-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import { DOCUMENT_TYPE_OPTIONS } from "@/lib/labels";
import { useInvalidateInventory } from "@/lib/queries";
import type {
  DocumentPage,
  DocumentRecord,
  DocumentScan,
  DocumentType,
} from "@/lib/types";
import { cn, versionedUrl } from "@/lib/utils";

type Corner = { x: number; y: number };
type CornerIndex = 0 | 1 | 2 | 3;
type ColorMode = "color" | "grayscale" | "document";

const FULL_CORNERS: Corner[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

const CORNER_LABELS = ["Top left", "Top right", "Bottom right", "Bottom left"];

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function nextRotation(current: number, delta: number): 0 | 90 | 180 | 270 {
  return (((current + delta + 360) % 360) as 0 | 90 | 180 | 270);
}

function rotatedPoint(point: Corner, rotation: number): Corner {
  switch ((rotation + 360) % 360) {
    case 90: return { x: 1 - point.y, y: point.x };
    case 180: return { x: 1 - point.x, y: 1 - point.y };
    case 270: return { x: point.y, y: 1 - point.x };
    default: return point;
  }
}

export function DocumentScanDialog({
  open,
  onOpenChange,
  defaultItemIds = [],
  defaultType = "other",
  targetDocumentId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultItemIds?: string[];
  defaultType?: DocumentType;
  targetDocumentId?: string;
  onSaved?: (document: DocumentRecord) => void;
}) {
  const invalidate = useInvalidateInventory();
  const [scanId, setScanId] = React.useState<string | null>(null);
  const scanIdRef = React.useRef<string | null>(null);
  const committedRef = React.useRef(false);
  const [pages, setPages] = React.useState<DocumentPage[]>([]);
  const pagesRef = React.useRef<DocumentPage[]>(pages);
  pagesRef.current = pages;
  const [activePageId, setActivePageId] = React.useState<string | null>(null);
  const [originalUnavailable, setOriginalUnavailable] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [documentType, setDocumentType] = React.useState<DocumentType>(defaultType);
  const [documentDate, setDocumentDate] = React.useState("");
  const [merchant, setMerchant] = React.useState("");
  const [itemIds, setItemIds] = React.useState<string[]>(defaultItemIds);
  const [error, setError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [savingPages, setSavingPages] = React.useState(0);
  const [previewFailed, setPreviewFailed] = React.useState(false);
  const failedPagesRef = React.useRef(new Set<string>());
  const [loadAttempt, setLoadAttempt] = React.useState(0);
  const [requestId, setRequestId] = React.useState(() => crypto.randomUUID());
  const [drag, setDrag] = React.useState<{ pageId: string; index: CornerIndex } | null>(
    null,
  );
  const dragCornersRef = React.useRef<{ pageId: string; corners: Corner[] } | null>(null);
  const imageRef = React.useRef<HTMLDivElement>(null);
  const cameraRef = React.useRef<HTMLInputElement>(null);
  const libraryRef = React.useRef<HTMLInputElement>(null);
  const timerRef = React.useRef<number | null>(null);
  const pendingRef = React.useRef<{
    pageId: string;
    adjustments: DocumentPage["adjustments"];
  } | null>(null);
  const inflightRef = React.useRef<Promise<void> | null>(null);
  const defaultItemKey = defaultItemIds.join(",");
  const activePage = pages.find((page) => page.id === activePageId) ?? pages[0] ?? null;

  React.useEffect(() => {
    if (!open) return;
    setScanId(null);
    scanIdRef.current = null;
    committedRef.current = false;
    setPages([]);
    setActivePageId(null);
    setOriginalUnavailable(false);
    setTitle("");
    setDocumentType(defaultType);
    setDocumentDate("");
    setMerchant("");
    setItemIds(defaultItemIds);
    setError(null);
    setUploading(Boolean(targetDocumentId));
    setUploadProgress("");
    setSaving(false);
    setSavingPages(0);
    failedPagesRef.current.clear();
    setPreviewFailed(false);
    setRequestId(crypto.randomUUID());
    let active = true;
    if (targetDocumentId) {
      void api.post<DocumentScan>("/documents/scans", {
        target_document_id: targetDocumentId,
      }).then(async (scan) => {
        if (!active) {
          try {
            await api.delete<void>(`/documents/scans/${scan.id}`);
          } catch (caught) {
            toast.error(`Could not discard cleanup draft: ${getApiErrorMessage(caught)}`);
          }
          return;
        }
        scanIdRef.current = scan.id;
        setScanId(scan.id);
        setPages(scan.pages);
        setActivePageId(scan.pages[0]?.id ?? null);
      }).catch((caught: unknown) => {
        if (active) setError(getApiErrorMessage(caught));
      }).finally(() => {
        if (active) setUploading(false);
      });
    }
    // The key intentionally captures the default selection without re-running on
    // every parent render where the array has a new identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { active = false; };
  }, [defaultItemKey, defaultType, open, targetDocumentId, loadAttempt]);

  React.useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      const rect = imageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = clamp((event.clientX - rect.left) / rect.width);
      const y = clamp((event.clientY - rect.top) / rect.height);
      const page = pagesRef.current.find((entry) => entry.id === drag.pageId);
      if (!page) return;
      const position = rotatedPoint({ x, y }, page.adjustments.rotation);
      const corners = page.adjustments.corners.map((corner, index) =>
        index === drag.index ? position : corner,
      );
      dragCornersRef.current = { pageId: page.id, corners };
      setPages((current) =>
        current.map((entry) =>
          entry.id === page.id
            ? { ...entry, adjustments: { ...entry.adjustments, corners } }
            : entry,
        ),
      );
    };
    const up = () => {
      const page = pagesRef.current.find((entry) => entry.id === drag.pageId);
      const dragged = dragCornersRef.current;
      if (page && dragged && dragged.pageId === page.id) {
        schedulePageSave(page.id, { ...page.adjustments, corners: dragged.corners });
      }
      dragCornersRef.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  const persistPage = async (
    pageId: string,
    adjustments: DocumentPage["adjustments"],
  ) => {
    if (!scanIdRef.current) return;
    setSavingPages((current) => current + 1);
    const task = (inflightRef.current ?? Promise.resolve())
      .then(() => api.patch<DocumentPage>(
        `/documents/scans/${scanIdRef.current}/pages/${pageId}`,
        adjustments,
      ))
      .then((updated) => {
        failedPagesRef.current.delete(pageId);
        setPreviewFailed(failedPagesRef.current.size > 0);
        setPages((current) =>
          current.map((page) =>
            page.id === pageId &&
            new Date(updated.updated_at).getTime() >= new Date(page.updated_at).getTime()
              ? {
                  ...updated,
                  adjustments: JSON.stringify(page.adjustments) === JSON.stringify(adjustments)
                    ? updated.adjustments
                    : page.adjustments,
                }
              : page,
          ),
        );
      });
    inflightRef.current = task.then(
      () => undefined,
      () => undefined,
    );
    try {
      await task;
    } catch (caught) {
      failedPagesRef.current.add(pageId);
      setPreviewFailed(true);
      setError(getApiErrorMessage(caught));
      throw caught;
    } finally {
      setSavingPages((current) => Math.max(0, current - 1));
    }
  };

  const schedulePageSave = (
    pageId: string,
    adjustments: DocumentPage["adjustments"],
  ) => {
    pendingRef.current = { pageId, adjustments };
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) {
        void persistPage(pending.pageId, pending.adjustments).catch(() => undefined);
      }
    }, 450);
  };

  const flushPending = async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) {
      await persistPage(pending.pageId, pending.adjustments);
    }
    if (inflightRef.current) {
      await inflightRef.current;
    }
    if (failedPagesRef.current.size > 0) {
      throw new Error("Some page adjustments could not be saved. Retry the preview before saving.");
    }
  };

  const applyAdjustments = (
    pageId: string,
    adjustments: DocumentPage["adjustments"],
  ) => {
    setError(null);
    setPages((current) =>
      current.map((page) =>
        page.id === pageId ? { ...page, adjustments } : page,
      ),
    );
    schedulePageSave(pageId, adjustments);
  };

  const ensureScan = async (): Promise<string> => {
    if (scanIdRef.current) return scanIdRef.current;
    const scan = await api.post<DocumentScan>("/documents/scans");
    scanIdRef.current = scan.id;
    setScanId(scan.id);
    return scan.id;
  };

  const addFiles = async (files: File[]) => {
    if (!files.length || uploading || saving) return;
    setUploading(true);
    setError(null);
    setUploadProgress("");
    try {
      const id = await ensureScan();
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (!file) continue;
        setUploadProgress(
          `Adding ${index + 1} of ${files.length} page${files.length === 1 ? "" : "s"}…`,
        );
        const formData = new FormData();
        formData.append("file", file);
        const page = await api.postForm<DocumentPage>(
          `/documents/scans/${id}/pages`,
          formData,
        );
        setPages((current) => [...current, page]);
        setActivePageId((current) => current ?? page.id);
        if (!title.trim()) {
          setTitle(file.name.replace(/\.[^.]+$/, ""));
        }
      }
    } catch (caught) {
      setError(getApiErrorMessage(caught));
    } finally {
      setUploading(false);
      setUploadProgress("");
    }
  };

  const chooseFiles = (files: FileList | null) => {
    void addFiles(Array.from(files ?? []));
  };

  const selectPage = (pageId: string) => {
    setOriginalUnavailable(false);
    void flushPending().catch(() => undefined);
    setActivePageId(pageId);
  };

  const movePage = async (pageId: string, delta: number) => {
    if (!scanId || uploading || saving) return;
    const index = pages.findIndex((page) => page.id === pageId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= pages.length) return;
    const previous = pages;
    const next = [...pages];
    const moving = next[index];
    const replaced = next[target];
    if (!moving || !replaced) return;
    next[index] = replaced;
    next[target] = moving;
    setPages(next);
    setError(null);
    try {
      await flushPending();
      const scan = await api.post<DocumentScan>(
        `/documents/scans/${scanId}/pages/reorder`,
        { page_ids: next.map((page) => page.id) },
      );
      setPages(scan.pages);
    } catch (caught) {
      setPages(previous);
      setError(getApiErrorMessage(caught));
    }
  };

  const removePage = async (pageId: string) => {
    if (!scanId || uploading || saving) return;
    setError(null);
    if (pendingRef.current?.pageId === pageId) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = null;
    }
    if (inflightRef.current) {
      await inflightRef.current;
    }
    try {
      await api.delete<void>(`/documents/scans/${scanId}/pages/${pageId}`);
      const remaining = pages.filter((page) => page.id !== pageId);
      setPages(remaining);
      if (activePageId === pageId) {
        setActivePageId(remaining[0]?.id ?? null);
        setOriginalUnavailable(false);
      }
    } catch (caught) {
      setError(getApiErrorMessage(caught));
    }
  };

  const rotate = (delta: number) => {
    if (!activePage) return;
    const corners = activePage.adjustments.corners.map(point => rotatedPoint(point, delta));
    const offset = delta > 0 ? 3 : 1;
    applyAdjustments(activePage.id, {
      ...activePage.adjustments,
      rotation: nextRotation(activePage.adjustments.rotation, delta),
      corners: [...corners.slice(offset), ...corners.slice(0, offset)],
    });
  };

  const resetAdjustments = () => {
    if (!activePage) return;
    applyAdjustments(activePage.id, {
      rotation: 0,
      corners: FULL_CORNERS,
      color_mode: "color",
      contrast: 1,
    });
  };

  const nudgeCorner = (
    index: CornerIndex,
    deltaX: number,
    deltaY: number,
  ) => {
    if (!activePage) return;
    const origin = rotatedPoint({ x: 0, y: 0 }, activePage.adjustments.rotation);
    const shifted = rotatedPoint({ x: deltaX, y: deltaY }, activePage.adjustments.rotation);
    const corners = activePage.adjustments.corners.map((corner, cornerIndex) =>
      cornerIndex === index
        ? {
            x: clamp(corner.x + shifted.x - origin.x),
            y: clamp(corner.y + shifted.y - origin.y),
          }
        : corner,
    );
    applyAdjustments(activePage.id, { ...activePage.adjustments, corners });
  };

  const close = async () => {
    if (saving || uploading) return;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    if (inflightRef.current) {
      await inflightRef.current;
    }
    if (scanIdRef.current && !committedRef.current) {
      try {
        await api.delete<void>(`/documents/scans/${scanIdRef.current}`);
      } catch (caught) {
        toast.error(`Could not discard draft; it will expire automatically. ${getApiErrorMessage(caught)}`);
      }
    }
    scanIdRef.current = null;
    onOpenChange(false);
  };

  const save = async () => {
    if (!scanIdRef.current || pages.length === 0 || saving || uploading) return;
    setSaving(true);
    setError(null);
    try {
      await flushPending();
      const document = await api.post<DocumentRecord>(
        `/documents/scans/${scanIdRef.current}/commit`,
        targetDocumentId ? { request_id: requestId } : {
          request_id: requestId,
          title: title.trim() || null,
          document_type: documentType,
          item_ids: itemIds,
          merchant: merchant.trim() || null,
          document_date: documentDate || null,
        },
      );
      committedRef.current = true;
      invalidate();
      toast.success(
        targetDocumentId
          ? "Saved cleaned document"
          : `Saved ${pages.length === 1 ? "1 scanned page" : `${pages.length} scanned pages`}`,
      );
      onSaved?.(document);
      onOpenChange(false);
    } catch (caught) {
      setError(getApiErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const busy = uploading || saving;
  const pageBusy = savingPages > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void close();
        else onOpenChange(true);
      }}
    >
      <DialogContent hideClose className="max-w-6xl overflow-hidden p-0">
        <div className="flex max-h-[calc(100dvh-4rem)] min-h-0 flex-col max-sm:max-h-[90dvh]">
          <div className="relative shrink-0 border-b border-border/60 px-5 pb-3 pt-5 sm:px-7">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-3 top-3 size-10"
              aria-label="Close"
              disabled={busy}
              onClick={() => void close()}
            >
              <X />
            </Button>
            <DialogHeader className="pr-10 max-sm:static max-sm:z-auto max-sm:mx-0 max-sm:p-0">
              <DialogTitle className="flex items-center gap-2">
                <ScanLine className="size-5 text-brass" />
                {targetDocumentId ? "Clean up document" : "Scan document"}
              </DialogTitle>
              <DialogDescription>
                {targetDocumentId
                  ? "Preview and adjust cleanup before replacing the current view. Original files, document details and item links stay unchanged. Cancel leaves the document as it is."
                  : "Capture or choose image pages, review automatic cleanup, then save one multi-page document. Exact originals are preserved; Cancel discards the draft."}
              </DialogDescription>
            </DialogHeader>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
              <span className="rounded-full bg-secondary px-2.5 py-1">{targetDocumentId ? "1 · Prepare preview" : "1 · Add pages"}</span>
              <span className="rounded-full bg-secondary px-2.5 py-1">2 · Adjust</span>
              <span className="rounded-full bg-secondary px-2.5 py-1">
                3 · Review and save
              </span>
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 sm:px-7">
            {error && <FormError message={error} />}
            {targetDocumentId && !scanId && error && (
              <Button type="button" variant="outline" onClick={() => setLoadAttempt(value => value + 1)}>
                Retry cleanup
              </Button>
            )}
            {previewFailed && (
              <Button type="button" variant="outline" disabled={busy || pageBusy} onClick={() => {
                setError(null);
                void (async () => {
                  for (const id of [...failedPagesRef.current]) {
                    const page = pagesRef.current.find(entry => entry.id === id);
                    if (page) await persistPage(id, page.adjustments);
                  }
                })().catch(() => undefined);
              }}>
                Retry preview
              </Button>
            )}

            {!targetDocumentId && <div className="flex flex-wrap items-center gap-2">
          <input
            ref={cameraRef}
            id="scan-page-camera"
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            disabled={busy}
            onChange={(event) => {
              chooseFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <input
            ref={libraryRef}
            id="scan-page-library"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            multiple
            className="sr-only"
            disabled={busy}
            onChange={(event) => {
              chooseFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => cameraRef.current?.click()}
            disabled={busy}
          >
            <Camera />
            Take photo
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => libraryRef.current?.click()}
            disabled={busy}
          >
            <ImagePlus />
            Choose pages
          </Button>
          {uploading && (
            <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {uploadProgress || "Adding pages…"}
            </span>
          )}
        </div>}

        {targetDocumentId && uploading ? (
          <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
            <Spinner /> Preparing private cleanup preview…
          </p>
        ) : pages.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-secondary/20 px-5 py-10 text-center">
            <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-card text-muted-foreground">
              <ScanLine className="size-5" strokeWidth={1.5} />
            </span>
            <p className="mt-4 font-display text-xl tracking-[-0.02em]">
              Start with a page
            </p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
              Take a photo or choose several images. Basic cropping, rotation and contrast
              work locally on your Housetory server without an AI provider.
            </p>
          </div>
        ) : (
          <>
            <div className="flex gap-2 overflow-x-auto overflow-y-hidden pb-1">
              {pages.map((page, index) => {
                const active = activePage?.id === page.id;
                return (
                  <div
                    key={page.id}
                    className={cn(
                      "w-[144px] shrink-0 rounded-xl border bg-background/40 p-2 transition-colors",
                      active ? "border-brass/50 ring-1 ring-brass/25" : "border-border/60",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => selectPage(page.id)}
                      disabled={busy}
                      aria-label={`Edit page ${index + 1}`}
                      aria-current={active ? "true" : undefined}
                      className="block w-full overflow-hidden rounded-lg bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                      <img
                        src={versionedUrl(page.cleaned_url, page.updated_at)}
                        alt=""
                        className="h-24 w-full object-cover"
                      />
                    </button>
                    <div className="mt-1.5 flex items-center justify-between gap-1">
                      <span className="text-2xs font-medium">Page {index + 1}</span>
                      {!targetDocumentId && <div className="flex items-center">
                        <button
                          type="button"
                          aria-label={`Move page ${index + 1} earlier`}
                          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-30"
                          disabled={index === 0 || busy}
                          onClick={() => void movePage(page.id, -1)}
                        >
                          <ArrowLeft className="size-3" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move page ${index + 1} later`}
                          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-30"
                          disabled={index === pages.length - 1 || busy}
                          onClick={() => void movePage(page.id, 1)}
                        >
                          <ArrowRight className="size-3" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove page ${index + 1}`}
                          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          disabled={busy}
                          onClick={() => void removePage(page.id)}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>}
                    </div>
                  </div>
                );
              })}
            </div>

            {activePage && (
              <p role="status" className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
                {activePage.detection_status === "detected"
                  ? "Page edges detected and straightened. Check the preview and adjust the corners if needed."
                  : activePage.detection_status === "manual_required"
                    ? "Could not confidently find the page edges. The full image is kept; adjust the corners manually and check the preview."
                    : "Check the cleaned preview before saving. Corners, colour and contrast are adjustable."}
              </p>
            )}

            {activePage && (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
                <section className="rounded-xl border border-border/70 bg-secondary/15 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div>
                      <p className="text-xs font-medium">Original · adjust corners</p>
                      <p className="text-2xs text-muted-foreground">
                        Drag a corner, or focus a corner and use the arrow keys. The exact
                        original file is preserved.
                      </p>
                    </div>
                    {pageBusy && <Spinner className="size-4" />}
                  </div>
                  {originalUnavailable ? (
                    <div className="space-y-2">
                      <img
                        src={versionedUrl(activePage.cleaned_url, activePage.updated_at)}
                        alt={`Cleaned page ${activePage.page_number}`}
                        className="mx-auto max-h-[52vh] max-w-full rounded-lg object-contain"
                      />
                      <p className="rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                        This browser cannot preview the original{" "}
                        {activePage.original_content_type} file. The original is preserved
                        and downloadable; the cleaned copy is shown here.
                      </p>
                    </div>
                  ) : (
                    <div className="flex justify-center">
                      <div
                        ref={imageRef}
                        className="relative inline-block max-w-full touch-none"
                      >
                        <img
                          src={versionedUrl(activePage.original_url, activePage.updated_at)}
                          alt={`Original page ${activePage.page_number}`}
                          draggable={false}
                          onError={() => setOriginalUnavailable(true)}
                          className="block max-h-[52vh] max-w-full rounded-lg object-contain"
                        />
                        <svg
                          className="pointer-events-none absolute inset-0 size-full text-brass"
                          viewBox="0 0 1 1"
                          preserveAspectRatio="none"
                          aria-hidden
                        >
                          <polygon
                            points={activePage.adjustments.corners
                              .map(corner => rotatedPoint(corner, -activePage.adjustments.rotation))
                              .map((corner) => `${corner.x},${corner.y}`)
                              .join(" ")}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="0.004"
                            vectorEffect="non-scaling-stroke"
                          />
                        </svg>
                        {activePage.adjustments.corners.map((corner, index) => {
                          const visible = rotatedPoint(corner, -activePage.adjustments.rotation);
                          return (
                          <button
                            key={index}
                            type="button"
                            aria-label={`Adjust ${CORNER_LABELS[index]} corner`}
                            title="Drag or use arrow keys"
                            disabled={busy}
                            className="absolute z-10 size-11 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 border-background bg-brass shadow-sm ring-2 ring-brass/30 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40"
                            style={{
                              left: `${visible.x * 100}%`,
                              top: `${visible.y * 100}%`,
                            }}
                            onPointerDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              dragCornersRef.current = {
                                pageId: activePage.id,
                                corners: activePage.adjustments.corners,
                              };
                              setDrag({ pageId: activePage.id, index: index as CornerIndex });
                            }}
                            onKeyDown={(event) => {
                              const step = event.shiftKey ? 0.05 : 0.01;
                              if (event.key === "ArrowLeft") {
                                event.preventDefault();
                                nudgeCorner(index as CornerIndex, -step, 0);
                              } else if (event.key === "ArrowRight") {
                                event.preventDefault();
                                nudgeCorner(index as CornerIndex, step, 0);
                              } else if (event.key === "ArrowUp") {
                                event.preventDefault();
                                nudgeCorner(index as CornerIndex, 0, -step);
                              } else if (event.key === "ArrowDown") {
                                event.preventDefault();
                                nudgeCorner(index as CornerIndex, 0, step);
                              }
                            }}
                          />
                          );
                        })}
                      </div>
                    </div>
                  )}
                </section>

                <section className="rounded-xl border border-border/70 bg-secondary/15 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div>
                      <p className="text-xs font-medium">Cleaned preview</p>
                      <p className="text-2xs text-muted-foreground">
                        A reversible derivative. The original page is never overwritten.
                      </p>
                    </div>
                  </div>
                  <div className="flex min-h-[240px] items-center justify-center rounded-lg bg-background/35 p-2">
                    <img
                      src={versionedUrl(activePage.cleaned_url, activePage.updated_at)}
                      alt={`Cleaned page ${activePage.page_number}`}
                      className="max-h-[52vh] max-w-full rounded-lg object-contain"
                    />
                  </div>
                </section>
              </div>
            )}

            {activePage && (
              <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border/70 bg-secondary/15 p-3">
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label="Rotate page left"
                    onClick={() => rotate(-90)}
                    disabled={busy}
                  >
                    <RotateCcw />
                    Left
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label="Rotate page right"
                    onClick={() => rotate(90)}
                    disabled={busy}
                  >
                    <RotateCw />
                    Right
                  </Button>
                </div>
                <Field label="Mode" htmlFor={`scan-mode-${activePage.id}`}>
                  <Select
                    id={`scan-mode-${activePage.id}`}
                    value={activePage.adjustments.color_mode}
                    onChange={(event) =>
                      applyAdjustments(activePage.id, {
                        ...activePage.adjustments,
                        color_mode: event.target.value as ColorMode,
                      })
                    }
                    disabled={busy}
                    className="h-9 rounded-lg text-xs"
                  >
                    <option value="color">Color</option>
                    <option value="grayscale">Grayscale</option>
                    <option value="document">Document</option>
                  </Select>
                </Field>
                <Field
                  label={`Contrast ${activePage.adjustments.contrast.toFixed(2)}×`}
                  htmlFor={`scan-contrast-${activePage.id}`}
                >
                  <input
                    id={`scan-contrast-${activePage.id}`}
                    type="range"
                    min="0.5"
                    max="2"
                    step="0.05"
                    value={activePage.adjustments.contrast}
                    onChange={(event) =>
                      applyAdjustments(activePage.id, {
                        ...activePage.adjustments,
                        contrast: Number(event.target.value),
                      })
                    }
                    disabled={busy}
                    className="h-9 w-36 accent-primary"
                  />
                </Field>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={resetAdjustments}
                  disabled={busy}
                >
                  <Undo2 />
                  Reset adjustments
                </Button>
              </div>
            )}

            <p className="text-2xs leading-relaxed text-muted-foreground">
              The cleaned PDF is the default download. Exact original page files remain
              available from the saved document. PDFs from scanner apps can still be
              uploaded unchanged through <span className="font-medium">Add document</span>;
              this editor combines image pages.
            </p>

            {!targetDocumentId && <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Title" htmlFor="scan-title" optional>
                <Input
                  id="scan-title"
                  value={title}
                  maxLength={200}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Scanned receipt"
                  disabled={busy}
                />
              </Field>
              <Field label="Type" htmlFor="scan-type">
                <Select
                  id="scan-type"
                  value={documentType}
                  onChange={(event) => setDocumentType(event.target.value as DocumentType)}
                  disabled={busy}
                >
                  {DOCUMENT_TYPE_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Merchant" htmlFor="scan-merchant" optional>
                <Input
                  id="scan-merchant"
                  value={merchant}
                  maxLength={160}
                  onChange={(event) => setMerchant(event.target.value)}
                  placeholder="Where it came from"
                  disabled={busy}
                />
              </Field>
              <Field label="Document date" htmlFor="scan-date" optional>
                <Input
                  id="scan-date"
                  type="date"
                  value={documentDate}
                  onChange={(event) => setDocumentDate(event.target.value)}
                  disabled={busy}
                />
              </Field>
            </div>}

            {!targetDocumentId && <ItemMultiSelect
              selected={itemIds}
              onChange={setItemIds}
              label="Attach to items"
              hint="Review the selected items before saving. Scanning does not create items or purchases."
              disabled={busy}
            />}

          </>
        )}

          </div>

          <div className="shrink-0 border-t border-border/60 bg-popover px-5 py-3 sm:px-7">
            <DialogFooter className="max-sm:static max-sm:mx-0 max-sm:border-0 max-sm:p-0">
              <Button type="button" variant="ghost" onClick={() => void close()} disabled={busy}>
                <X />
                {targetDocumentId ? "Cancel cleanup" : "Cancel scan"}
              </Button>
              <Button
                type="button"
                onClick={() => void save()}
                disabled={!scanId || pages.length === 0 || busy || pageBusy || previewFailed}
              >
                {saving ? <Spinner /> : <Check />}
                {targetDocumentId ? "Save cleaned document" : "Save scanned document"}
              </Button>
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
