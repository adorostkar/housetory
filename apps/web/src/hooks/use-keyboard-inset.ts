import * as React from "react";

import { isTextEntry } from "@/hooks/use-software-keyboard-open";

/**
 * Keeps `--keyboard-inset` on the root element equal to the height the software
 * keyboard covers at the bottom of the layout viewport. A bar fixed to the bottom
 * can add it to its `bottom` so it stays above the keyboard on iOS, where the
 * layout viewport does not shrink. `--visual-viewport-top` is how far the visible
 * part has moved down from the top of the layout viewport, and
 * `--visual-viewport-height` is its height.
 */
/**
 * The height of the area that `position: fixed` is measured in. In an installed
 * iOS web app `window.innerHeight` shrinks to what is seen while the keyboard is
 * open, but fixed boxes are still placed in the full area. The root element keeps
 * the full height.
 */
export function layoutViewportHeight(): number {
  return Math.max(window.innerHeight, document.documentElement.clientHeight);
}

export function useKeyboardInset(): void {
  React.useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let frame = 0;
    let last = "";
    const measure = () => {
      // The keyboard is open when the visible part is clearly shorter than the
      // window. A pinch zoom also makes it shorter, so that is left out. Small
      // differences are browser chrome, not a keyboard.
      const layoutHeight = layoutViewportHeight();
      const keyboard = viewport.scale <= 1.01 && layoutHeight - viewport.height > 80;
      // iOS can move the visible part down the page when the keyboard opens. What
      // is left under it is the inset; it can be small, or nothing at all.
      const inset = keyboard ? Math.max(0, Math.round(layoutHeight - viewport.height - viewport.offsetTop)) : 0;
      const top = keyboard ? Math.max(0, Math.round(viewport.offsetTop)) : 0;
      const height = keyboard ? Math.round(viewport.height) : 0;
      const key = `${inset}/${top}/${height}`;
      if (key === last) return;
      last = key;
      root.style.setProperty("--keyboard-inset", `${inset}px`);
      // Something that must start at the top of what is seen adds this to its `top`.
      root.style.setProperty("--visual-viewport-top", `${top}px`);
      // The height of what is seen. A sheet that stands on the keyboard is not taller.
      if (keyboard) root.style.setProperty("--visual-viewport-height", `${height}px`);
      else root.style.removeProperty("--visual-viewport-height");
    };
    const schedule = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
      }
    };
    // iOS does not always tell when it moves the visible part for a focused field
    // (an installed web app does not). While a field has focus the numbers are
    // read on every frame; nothing is written unless one of them changed.
    let follow = 0;
    const followField = () => {
      measure();
      follow = isTextEntry(document.activeElement) ? window.requestAnimationFrame(followField) : 0;
    };
    const onFocus = () => {
      if (!follow) follow = window.requestAnimationFrame(followField);
      schedule();
    };
    measure();
    onFocus();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (follow) window.cancelAnimationFrame(follow);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", schedule);
      root.style.removeProperty("--keyboard-inset");
      root.style.removeProperty("--visual-viewport-top");
      root.style.removeProperty("--visual-viewport-height");
    };
  }, []);
}
