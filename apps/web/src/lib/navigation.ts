import * as React from "react";

export interface ItemOrigin {
  path: string;
  label: string;
}

const ORIGIN_PARAM = "from";
const ORIGIN_LABEL_PARAM = "from_label";
const SCROLL_PREFIX = "housetory:scroll:";

export function safeRelativePath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (/[\\\u0000-\u001f]/.test(value)) return null;
  try {
    const url = new URL(value, "http://housetory.invalid");
    if (url.origin !== "http://housetory.invalid") return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function safeOriginLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return clean || null;
}

export function itemOrigin(path: string, label: string): ItemOrigin | null {
  const safePath = safeRelativePath(path);
  const safeLabel = safeOriginLabel(label);
  if (!safePath || !safeLabel) return null;
  return { path: safePath, label: safeLabel };
}

export function appendOrigin(path: string, origin?: ItemOrigin | null): string {
  if (!origin) return path;
  const safePath = safeRelativePath(origin.path);
  if (!safePath) return path;
  const [base, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set(ORIGIN_PARAM, safePath);
  const label = safeOriginLabel(origin.label);
  if (label) params.set(ORIGIN_LABEL_PARAM, label);
  return `${base}?${params.toString()}`;
}

export function readOrigin(searchParams: URLSearchParams): ItemOrigin | null {
  const path = safeRelativePath(searchParams.get(ORIGIN_PARAM));
  if (!path) return null;
  const label =
    safeOriginLabel(searchParams.get(ORIGIN_LABEL_PARAM)) ??
    fallbackOriginLabel(path);
  return { path, label };
}

export function fallbackOriginLabel(path: string): string {
  if (path.startsWith("/containers/")) return "container";
  if (path.startsWith("/rooms/")) return "room";
  if (path.startsWith("/items")) return "items";
  return "previous view";
}

export function itemHref(
  itemId: string,
  origin?: ItemOrigin | null,
  householdId?: string | null,
): string {
  let href = `/items/${itemId}`;
  if (householdId) {
    const params = new URLSearchParams();
    params.set("household_id", householdId);
    href = `${href}?${params.toString()}`;
  }
  return appendOrigin(href, origin);
}

export function rememberListScroll(origin: ItemOrigin | null): void {
  if (!origin) return;
  try {
    sessionStorage.setItem(`${SCROLL_PREFIX}${origin.path}`, String(window.scrollY));
  } catch {
    // Storage is optional; navigation still works.
  }
}

export function useRestoreListScroll(ready: boolean, origin: ItemOrigin | null): void {
  const restored = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!ready || !origin) return;
    const key = `${SCROLL_PREFIX}${origin.path}`;
    if (restored.current === key) return;
    try {
      const value = sessionStorage.getItem(key);
      if (value === null) return;
      sessionStorage.removeItem(key);
      restored.current = key;
      const top = Number(value);
      if (Number.isFinite(top) && top > 0) {
        window.requestAnimationFrame(() => window.scrollTo({ top }));
      }
    } catch {
      // Storage failures are non-fatal.
    }
  }, [ready, origin]);
}
