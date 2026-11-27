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
/** Under this visible height, with the keyboard open, a sheet has room for typing only. */
const SHORT_HEIGHT = 420;
/** Under this height there is room for one field and nothing else. */
const TINY_HEIGHT = 200;
/**
 * A strip that is tiny and at least this wide is a phone held sideways. There is no
 * room above the field, but there is room beside it: Save, Close and the search
 * results are then placed beside the field that is typed in.
 */
const SIDE_WIDTH = 560;

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
      const key = `${inset}/${top}/${height}/${Math.round(viewport.width)}`;
      if (key === last) return;
      last = key;
      root.style.setProperty("--keyboard-inset", `${inset}px`);
      // Something that must start at the top of what is seen adds this to its `top`.
      root.style.setProperty("--visual-viewport-top", `${top}px`);
      // The height of what is seen. A sheet that stands on the keyboard is not taller.
      if (keyboard) root.style.setProperty("--visual-viewport-height", `${height}px`);
      else root.style.removeProperty("--visual-viewport-height");
      // For styles: "short" when the keyboard leaves little height (a small phone,
      // or a phone held sideways). Things that are not needed for typing hide then.
      if (keyboard) root.dataset.keyboard = height < SHORT_HEIGHT ? "short" : "open";
      else delete root.dataset.keyboard;
      // "Tiny": a phone held sideways, where the keyboard leaves a strip of some
      // 70 px. Only the field that is typed in can be shown there.
      if (keyboard && height < TINY_HEIGHT) root.dataset.keyboardTiny = "";
      else delete root.dataset.keyboardTiny;
      if (keyboard && height < TINY_HEIGHT && viewport.width >= SIDE_WIDTH) root.dataset.keyboardSide = "";
      else delete root.dataset.keyboardSide;
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
    // In a sideways strip Save, Close and the results stand beside the field. A tap on
    // a button would first take the focus from the field: the keyboard would start to
    // close, everything would move back, and the tap would miss its button. So the
    // field keeps the focus for that tap. The button still gets its click.
    const keepFocus = (event: MouseEvent) => {
      if (root.dataset.keyboardSide === undefined || !isTextEntry(document.activeElement)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || isTextEntry(target)) return;
      if (target.closest("button, a, [role='button'], [role='option']")) event.preventDefault();
    };
    measure();
    onFocus();
    document.addEventListener("mousedown", keepFocus, true);
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (follow) window.cancelAnimationFrame(follow);
      document.removeEventListener("mousedown", keepFocus, true);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", schedule);
      root.style.removeProperty("--keyboard-inset");
      root.style.removeProperty("--visual-viewport-top");
      root.style.removeProperty("--visual-viewport-height");
      delete root.dataset.keyboard;
      delete root.dataset.keyboardTiny;
      delete root.dataset.keyboardSide;
    };
  }, []);
}
