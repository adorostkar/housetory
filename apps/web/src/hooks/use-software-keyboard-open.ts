import * as React from "react";

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function isTextEntry(element: Element | null): boolean {
  if (!element || !(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element.tagName === "TEXTAREA" || element.tagName === "SELECT") return true;
  if (element.tagName !== "INPUT") return false;
  return !NON_TEXT_INPUT_TYPES.has((element as HTMLInputElement).type.toLowerCase());
}

/**
 * Detect a software keyboard from a real visual-viewport reduction while a
 * text control is focused. It intentionally ignores focus alone so hardware
 * keyboards do not hide navigation, and it never changes the viewport meta.
 */
export function useSoftwareKeyboardOpen(): boolean {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const visualViewport = window.visualViewport;
    let baseline = Math.max(window.innerHeight, visualViewport?.height ?? 0);
    let frame = 0;

    const measure = () => {
      frame = 0;
      const height = visualViewport?.height ?? window.innerHeight;
      const editing = isTextEntry(document.activeElement);
      if (!editing) {
        baseline = Math.max(height, window.innerHeight);
      }
      const keyboardReduction = baseline - height;
      setOpen(editing && keyboardReduction > 120);
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };

    const onOrientation = () => {
      baseline = Math.max(window.innerHeight, visualViewport?.height ?? 0);
      schedule();
    };

    measure();
    visualViewport?.addEventListener("resize", schedule);
    visualViewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", onOrientation);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      visualViewport?.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", onOrientation);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
    };
  }, []);

  return open;
}
