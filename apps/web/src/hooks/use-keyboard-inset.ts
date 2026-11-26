import * as React from "react";

/**
 * Keeps `--keyboard-inset` on the root element equal to the height the software
 * keyboard covers at the bottom of the layout viewport. A bar fixed to the bottom
 * can add it to its `bottom` so it stays above the keyboard on iOS, where the
 * layout viewport does not shrink.
 */
export function useKeyboardInset(): void {
  React.useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      // Small differences are browser chrome, not a keyboard.
      root.style.setProperty("--keyboard-inset", inset > 80 ? `${Math.round(inset)}px` : "0px");
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      root.style.removeProperty("--keyboard-inset");
    };
  }, []);
}
