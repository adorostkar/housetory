import { ZoomIn, ZoomOut } from "lucide-react";
import {
  getDocument,
  GlobalWorkerOptions,
  RenderingCancelledException,
  version,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

GlobalWorkerOptions.workerSrc = workerUrl;

// Plain files served next to the app; see the pdfjsData plugin in vite.config.ts.
const DATA_URL = `${import.meta.env.BASE_URL}assets/pdfjs-${version}/`;
const ZOOM_STEPS = [1, 1.5, 2, 3];
// At normal zoom a page is as wide as the screen allows, up to this many pixels.
const FIT_WIDTH = 900;
// Stays below the canvas size that phones accept.
const MAX_PAGE_PIXELS = 12_000_000;

/**
 * Draws the pages of a PDF onto canvases with pdf.js.
 *
 * The browser's own PDF viewer is not used, so nothing inside the file runs or
 * can be clicked: no scripts, no forms, no links. Only pages near the screen
 * keep a bitmap.
 */
export function PdfPages({
  file,
  title,
  initialPage = 1,
}: {
  file: Blob;
  title: string;
  initialPage?: number;
}) {
  const frame = React.useRef<HTMLDivElement>(null);
  const toolbar = React.useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = React.useState<{ pdf: PDFDocumentProxy; shape: number } | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [width, setWidth] = React.useState(0);
  const [zoom, setZoom] = React.useState(0);
  // Height divided by width, for pages that differ from the first one.
  const [shapes, setShapes] = React.useState<Record<number, number>>({});

  React.useEffect(() => {
    let stale = false;
    let task: PDFDocumentLoadingTask | undefined;
    setLoaded(null);
    setFailed(false);
    setShapes({});
    void (async () => {
      try {
        // pdf.js takes over the bytes it is given, so every load gets its own copy.
        const data = new Uint8Array(await file.arrayBuffer());
        if (stale) return;
        task = getDocument({
          data,
          cMapUrl: `${DATA_URL}cmaps/`,
          standardFontDataUrl: `${DATA_URL}standard_fonts/`,
          wasmUrl: `${DATA_URL}wasm/`,
          // The production CSP blocks WebAssembly; the JavaScript decoders work everywhere.
          useWasm: false,
          enableXfa: false,
        });
        const pdf = await task.promise;
        const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
        if (!stale) setLoaded({ pdf, shape: first.height / first.width });
      } catch {
        if (!stale) setFailed(true);
      }
    })();
    return () => {
      stale = true;
      void task?.destroy();
    };
  }, [file]);

  // Pages change size on a zoom step and when the frame gets wider or narrower.
  // The spot under the toolbar is noted while reading and put back there after the change.
  const spot = React.useRef<{ page: HTMLElement; part: number; gap: number; across: number } | null>(
    null,
  );
  const pagesWidth = React.useRef(0);
  const note = React.useCallback(() => {
    const scroller = frame.current;
    const line = toolbar.current?.getBoundingClientRect().bottom ?? 0;
    const page = Array.from(scroller?.querySelectorAll<HTMLElement>("[data-page]") ?? []).find(
      (slot) => slot.getBoundingClientRect().bottom > line,
    );
    if (!scroller || !page) return;
    const box = page.getBoundingClientRect();
    const into = line - box.top;
    spot.current = {
      page,
      // Inside a page, the share of it above the line is kept; before a page, the distance to it.
      part: into > 0 ? into / box.height : 0,
      gap: Math.min(into, 0),
      across: (scroller.scrollLeft + scroller.clientWidth / 2) / scroller.scrollWidth,
    };
  }, []);
  React.useEffect(() => {
    // While the frame already has a new width and the pages do not, a scroll is the
    // layout moving, not the reader: the earlier note is the one to keep.
    const heard = () => {
      if (frame.current?.clientWidth === pagesWidth.current) note();
    };
    // Scrolling does not bubble; capturing also hears the sideways scroll of a zoomed page.
    window.addEventListener("scroll", heard, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", heard, { capture: true });
  }, [note]);
  React.useLayoutEffect(() => {
    pagesWidth.current = width;
    const scroller = frame.current;
    const at = spot.current;
    if (!scroller || !at?.page.isConnected) return;
    scroller.scrollLeft = at.across * scroller.scrollWidth - scroller.clientWidth / 2;
    const box = at.page.getBoundingClientRect();
    const line = toolbar.current?.getBoundingClientRect().bottom ?? 0;
    window.scrollBy({ top: box.height * at.part + at.gap - (line - box.top), behavior: "instant" });
  }, [zoom, width]);
  const changeZoom = (step: number) => {
    note();
    setZoom((value) => Math.min(ZOOM_STEPS.length - 1, Math.max(0, value + step)));
  };

  React.useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onShape = React.useCallback((page: number, shape: number) => {
    setShapes((current) => (current[page] === shape ? current : { ...current, [page]: shape }));
  }, []);

  const pageCount = loaded?.pdf.numPages ?? 0;
  const startPage = Math.min(Math.max(1, Math.floor(initialPage) || 1), pageCount);
  const ready = pageCount > 0 && width > 0;
  React.useEffect(() => {
    if (!ready || startPage <= 1) return;
    // A jump, not a slide: sliding past every page before this one would start drawing them.
    frame.current
      ?.querySelector(`[data-page="${startPage}"]`)
      ?.scrollIntoView?.({ block: "start", behavior: "instant" });
    note();
  }, [ready, startPage, note]);

  if (failed) {
    return (
      <p role="alert" className="surface px-5 py-10 text-center text-sm text-muted-foreground">
        This PDF cannot be shown here. Download it to open it in another app.
      </p>
    );
  }
  const pageWidth = Math.floor(Math.min(width, FIT_WIDTH) * (ZOOM_STEPS[zoom] ?? 1));
  return (
    <section aria-label={`Pages of ${title}`} className="space-y-3">
      {/* Stays under the app header, so the zoom buttons are at hand on every page. */}
      <div
        ref={toolbar}
        className="glass sticky top-[calc(7.5rem+env(safe-area-inset-top))] z-20 -mx-2 flex h-12 items-center justify-between gap-2 rounded-xl px-2 lg:top-[calc(4rem+env(safe-area-inset-top))]"
      >
        {loaded ? (
          <p className="text-xs text-muted-foreground">
            {pageCount} {pageCount === 1 ? "page" : "pages"}
          </p>
        ) : (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner /> Opening the file…
          </p>
        )}
        {/* The page keeps its top 5rem free for whatever gets focus. On wide screens the toolbar
            sits 1rem inside that band; without the margin each focus move would scroll the page. */}
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Zoom out"
            className="lg:-scroll-mt-4"
            disabled={zoom === 0}
            onClick={() => changeZoom(-1)}
          >
            <ZoomOut />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Zoom in"
            className="lg:-scroll-mt-4"
            disabled={zoom === ZOOM_STEPS.length - 1}
            onClick={() => changeZoom(1)}
          >
            <ZoomIn />
          </Button>
        </div>
      </div>
      <div ref={frame} className="overflow-x-auto rounded-xl bg-secondary/30">
        {loaded && ready && (
          <ol className="mx-auto space-y-3 p-0" style={{ width: pageWidth }}>
            {Array.from({ length: pageCount }, (_, index) => (
              <PdfPage
                key={index + 1}
                pdf={loaded.pdf}
                number={index + 1}
                pageCount={pageCount}
                width={pageWidth}
                shape={shapes[index + 1] ?? loaded.shape}
                onShape={onShape}
              />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function PdfPage({
  pdf,
  number,
  pageCount,
  width,
  shape,
  onShape,
}: {
  pdf: PDFDocumentProxy;
  number: number;
  pageCount: number;
  width: number;
  shape: number;
  onShape: (page: number, shape: number) => void;
}) {
  const slot = React.useRef<HTMLLIElement>(null);
  const canvas = React.useRef<HTMLCanvasElement>(null);
  // One canvas takes one drawing at a time; the next waits for the last to stop.
  const lastDrawing = React.useRef<Promise<void>>(Promise.resolve());
  const [near, setNear] = React.useState(false);
  const [state, setState] = React.useState<"waiting" | "drawn" | "failed">("waiting");

  React.useEffect(() => {
    const element = slot.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const target = canvas.current;
    if (!near || !target) return;
    let stale = false;
    let task: RenderTask | undefined;
    lastDrawing.current = lastDrawing.current.then(async () => {
      if (stale) return;
      try {
        const page = await pdf.getPage(number);
        const base = page.getViewport({ scale: 1 });
        if (stale) return;
        onShape(number, base.height / base.width);
        let scale = (width / base.width) * Math.min(window.devicePixelRatio || 1, 3);
        const pixels = base.width * base.height * scale * scale;
        if (pixels > MAX_PAGE_PIXELS) scale *= Math.sqrt(MAX_PAGE_PIXELS / pixels);
        const viewport = page.getViewport({ scale });
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        task = page.render({ canvas: target, viewport });
        await task.promise;
        if (!stale) setState("drawn");
      } catch (error) {
        if (!stale && !(error instanceof RenderingCancelledException)) setState("failed");
      }
    });
    return () => {
      stale = true;
      task?.cancel();
      // Give the bitmap back once the page is far from the screen.
      target.width = 0;
      target.height = 0;
      setState("waiting");
    };
  }, [near, pdf, number, width, onShape]);

  // A page that is scrolled to stops just under the app header and the toolbar.
  // The margins are that height less the 5rem every page of the app already keeps free.
  return (
    <li
      ref={slot}
      data-page={number}
      data-state={state}
      className="relative scroll-mt-[calc(6rem+env(safe-area-inset-top))] overflow-hidden bg-white shadow-sm lg:scroll-mt-[calc(2.5rem+env(safe-area-inset-top))]"
      style={{ width, height: Math.round(width * shape) }}
    >
      {/* A canvas is black until its page is painted, so it stays unseen until then. */}
      <canvas
        ref={canvas}
        role="img"
        aria-label={`Page ${number} of ${pageCount}`}
        className={cn("block size-full", state !== "drawn" && "opacity-0")}
      />
      {state === "failed" && (
        <p role="alert" className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-neutral-600">
          Page {number} could not be drawn. Download the file to see it.
        </p>
      )}
    </li>
  );
}
