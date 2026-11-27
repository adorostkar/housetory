import * as React from "react";

import { isTextEntry } from "@/hooks/use-software-keyboard-open";

const GAP = 12;

/**
 * With the phone keyboard open, keeps the field that is being typed in on the
 * part of the page that can be seen. iOS scrolls a focused field to just above
 * the keyboard, but it does not know about a Save bar that stands there, so the
 * field can end up under that bar. Fields in dialogs and in the bottom bar place
 * themselves.
 */
export function useKeepFocusedFieldVisible(keyboardOpen: boolean): void {
  React.useEffect(() => {
    if (!keyboardOpen) return;
    const visual = window.visualViewport;
    if (!visual) return;
    let timer = 0;

    const check = () => {
      const field = document.activeElement;
      if (!(field instanceof HTMLElement) || !isTextEntry(field)) return;
      if (field.closest("[data-always-on-screen], [role='dialog']")) return;
      // Safari measures boxes from the top of what is seen, other browsers from the
      // top of the window. A fixed mark at the window's top tells which.
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;pointer-events:none";
      document.body.appendChild(probe);
      const top = visual.offsetTop + probe.getBoundingClientRect().top;
      probe.remove();
      let bottom = top + visual.height;
      const rect = field.getBoundingClientRect();
      // A bar that lies over the page at the lower edge takes that room away.
      const x = Math.min(window.innerWidth - 2, Math.max(2, rect.left + rect.width / 2));
      let cover = document.elementFromPoint(x, bottom - 4);
      while (cover && cover !== document.body) {
        const position = window.getComputedStyle(cover).position;
        if ((position === "sticky" || position === "fixed") && !cover.contains(field)) {
          bottom = Math.min(bottom, cover.getBoundingClientRect().top);
          break;
        }
        cover = cover.parentElement;
      }
      const room = bottom - top - GAP * 2;
      let delta = 0;
      if (rect.height > room || rect.top < top + GAP) delta = rect.top - (top + GAP);
      else if (rect.bottom > bottom - GAP) delta = rect.bottom - (bottom - GAP);
      if (Math.abs(delta) <= 1) return;
      // The field may live in a part that scrolls by itself (the item panel beside the list).
      let scroller: HTMLElement | null = field.parentElement;
      while (scroller && scroller !== document.body) {
        const overflow = window.getComputedStyle(scroller).overflowY;
        if ((overflow === "auto" || overflow === "scroll") && scroller.scrollHeight > scroller.clientHeight + 1) break;
        scroller = scroller.parentElement;
      }
      if (scroller && scroller !== document.body) scroller.scrollBy({ top: delta, behavior: "auto" });
      else window.scrollBy({ top: delta, behavior: "auto" });
    };
    // After the browser's own scrolling for the keyboard has ended. The keyboard
    // slides in for some time and the page's parts take their new size during it,
    // so the place is checked once more a little later.
    let later = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      window.clearTimeout(later);
      timer = window.setTimeout(check, 350);
      later = window.setTimeout(check, 900);
    };
    schedule();
    visual.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(later);
      visual.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
    };
  }, [keyboardOpen]);
}
