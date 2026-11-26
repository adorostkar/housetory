import * as React from "react";

const STORAGE_KEY = "housetory-property-filter";
const listeners = new Set<() => void>();

function read(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** The property (home) the lists are narrowed to. Empty means all properties. */
export function setStoredPropertyId(value: string, notify = true) {
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, value);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Remembering the filter is best effort.
  }
  if (notify) listeners.forEach((listener) => listener());
}

/** Shared by the room rail and the list pages, so both show the same property. */
export function useStoredPropertyId(): string {
  return React.useSyncExternalStore(subscribe, read, () => "");
}
