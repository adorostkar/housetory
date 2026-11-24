import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PdfPages } from "@/components/pdf-pages";

const pdfjs = vi.hoisted(() => ({
  getDocument: vi.fn(),
  render: vi.fn(),
  cancel: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: pdfjs.getDocument,
  GlobalWorkerOptions: {},
  RenderingCancelledException: class RenderingCancelledException extends Error {},
  version: "9.9.9",
}));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "/pdf.worker.mjs" }));

const file = new Blob(["%PDF-1.4 synthetic"], { type: "application/pdf" });
const scrolled: string[] = [];
let watched: { element: Element; show: (visible: boolean) => void }[] = [];

function pdfDocument(pages: number) {
  return {
    numPages: pages,
    getPage: vi.fn(async (number: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
      render: (parameters: { canvas: HTMLCanvasElement }) => {
        pdfjs.render(number, parameters);
        return { promise: Promise.resolve(), cancel: () => pdfjs.cancel(number) };
      },
    })),
  };
}

function slot(page: number) {
  return document.querySelector<HTMLElement>(`[data-page="${page}"]`)!;
}

beforeEach(() => {
  scrolled.length = 0;
  watched = [];
  for (const mock of Object.values(pdfjs)) mock.mockReset();
  pdfjs.getDocument.mockImplementation(() => ({
    promise: Promise.resolve(pdfDocument(3)),
    destroy: pdfjs.destroy,
  }));
  // jsdom has no layout: give the frame a width and record scrolling.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this.getAttribute("data-page") ?? "");
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PdfPages", () => {
  it("draws the file itself with scripts and WebAssembly off and opens at the cited page", async () => {
    const view = render(<PdfPages file={file} title="ASIM6K0R-EN-v2" initialPage={2} />);
    expect(await screen.findByRole("img", { name: "Page 3 of 3" })).toBeInTheDocument();
    await waitFor(() => expect([1, 2, 3].map((page) => slot(page).dataset.state))
      .toEqual(["drawn", "drawn", "drawn"]));

    // pdf.js gets the bytes, not a URL, and nothing inside the file is run.
    const options = pdfjs.getDocument.mock.calls[0]![0];
    expect(new TextDecoder().decode(options.data)).toBe("%PDF-1.4 synthetic");
    expect(options).toMatchObject({
      useWasm: false,
      enableXfa: false,
      wasmUrl: "/assets/pdfjs-9.9.9/wasm/",
      cMapUrl: "/assets/pdfjs-9.9.9/cmaps/",
      standardFontDataUrl: "/assets/pdfjs-9.9.9/standard_fonts/",
    });
    expect(options).not.toHaveProperty("url");
    // Each page is drawn on its own canvas, sized to the frame.
    expect(pdfjs.render.mock.calls.map(([page, parameters]) => [page, parameters.canvas.width]))
      .toEqual([[1, 800], [2, 800], [3, 800]]);
    expect(Object.keys(pdfjs.render.mock.calls[0]![1]).sort()).toEqual(["canvas", "viewport"]);
    expect(screen.getByText("3 pages")).toBeVisible();
    expect(scrolled).toEqual(["2"]);

    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(slot(1).style.width).toBe("1200px"));
    await waitFor(() => expect(slot(1).dataset.state).toBe("drawn"));

    view.unmount();
    expect(pdfjs.destroy).toHaveBeenCalled();
  });

  it("keeps a bitmap only for pages near the screen", async () => {
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private readonly notify: (entries: { isIntersecting: boolean }[]) => void) {}
      observe(element: Element) {
        watched.push({ element, show: (visible) => this.notify([{ isIntersecting: visible }]) });
      }
      disconnect() {}
    });
    render(<PdfPages file={file} title="ASIM6K0R-EN-v2" />);
    await screen.findByRole("img", { name: "Page 1 of 3" });
    expect(pdfjs.render).not.toHaveBeenCalled();

    const show = (page: number, visible: boolean) =>
      act(() => watched.find((entry) => entry.element === slot(page))!.show(visible));
    show(1, true);
    await waitFor(() => expect(slot(1).dataset.state).toBe("drawn"));
    expect(pdfjs.render.mock.calls.map(([page]) => page)).toEqual([1]);
    const canvas = screen.getByRole<HTMLCanvasElement>("img", { name: "Page 1 of 3" });
    expect([canvas.width, canvas.height]).toEqual([800, 1066]);

    show(1, false);
    expect(pdfjs.cancel).toHaveBeenCalledWith(1);
    expect([canvas.width, canvas.height, slot(1).dataset.state]).toEqual([0, 0, "waiting"]);
    // The slot keeps its size, so the page does not jump while scrolling.
    expect(slot(1).style.height).toBe("1067px");
  });

  it("says so when the file cannot be drawn", async () => {
    pdfjs.getDocument.mockImplementation(() => ({
      promise: Promise.reject(new Error("Invalid PDF structure")),
      destroy: pdfjs.destroy,
    }));
    render(<PdfPages file={file} title="Broken" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This PDF cannot be shown here. Download it to open it in another app.",
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
