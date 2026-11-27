import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useKeyboardInset } from "@/hooks/use-keyboard-inset";

function Probe() {
  useKeyboardInset();
  return null;
}

/** A stand-in for the phone's visual viewport. The numbers are the ones iOS gave in the Simulator. */
function viewport(values: { height: number; offsetTop: number; scale?: number }) {
  const target = new EventTarget();
  return Object.assign(target, { scale: 1, ...values }) as unknown as VisualViewport;
}

const root = document.documentElement;
const read = (name: string) => root.style.getPropertyValue(name);

describe("useKeyboardInset", () => {
  const innerHeight = window.innerHeight;
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: innerHeight });
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 0 });
  });

  function show(inner: number, layout: number, visual: { height: number; offsetTop: number; scale?: number }) {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: inner });
    Object.defineProperty(root, "clientHeight", { configurable: true, value: layout });
    vi.stubGlobal("visualViewport", viewport(visual));
    return render(<Probe />);
  }

  it("is zero without a keyboard", () => {
    show(699, 699, { height: 699, offsetTop: 0 });
    expect(read("--keyboard-inset")).toBe("0px");
    expect(read("--visual-viewport-top")).toBe("0px");
    expect(read("--visual-viewport-height")).toBe("");
  });

  it("is the covered height when the keyboard only makes the visible part shorter", () => {
    show(699, 699, { height: 369, offsetTop: 0 });
    expect(read("--keyboard-inset")).toBe("330px");
    expect(read("--visual-viewport-top")).toBe("0px");
    expect(read("--visual-viewport-height")).toBe("369px");
  });

  it("counts only what is left under the visible part when iOS has moved it down the page", () => {
    // Safari: the visible part moved 266 px down, so only 64 px of the window lie under it.
    show(699, 699, { height: 369, offsetTop: 266 });
    expect(read("--keyboard-inset")).toBe("64px");
    expect(read("--visual-viewport-top")).toBe("266px");
  });

  it("uses the full layout height in an installed web app, where the window height shrinks with the keyboard", () => {
    // Home Screen app: innerHeight equals the visible height, fixed boxes still use 797 px.
    show(401, 797, { height: 401, offsetTop: 396 });
    expect(read("--keyboard-inset")).toBe("0px");
    expect(read("--visual-viewport-top")).toBe("396px");
    expect(read("--visual-viewport-height")).toBe("401px");
  });

  it("does not take a pinch zoom for a keyboard", () => {
    show(699, 699, { height: 350, offsetTop: 100, scale: 2 });
    expect(read("--keyboard-inset")).toBe("0px");
    expect(read("--visual-viewport-top")).toBe("0px");
  });

  it("removes its values when it goes away", () => {
    const view = show(699, 699, { height: 369, offsetTop: 0 });
    act(() => view.unmount());
    expect(read("--keyboard-inset")).toBe("");
    expect(read("--visual-viewport-height")).toBe("");
  });
});
