import type { OfflineCopy } from "@/lib/types";

/*
 * Where the offline copy lives on the device.
 *
 * - The inventory itself is one record in IndexedDB.
 * - The choice to keep a copy, and a few facts about it (no inventory data),
 *   are in localStorage so the app can read them at once when it starts.
 */

const DATABASE = "housetory-offline";
const STORE = "copy";
const RECORD = "current";
const PREFERENCE_KEY = "housetory-offline-copy";
const SIGN_OUT_KEY = "housetory-offline-sign-out";

/** This device keeps a copy for this account. Says nothing about the inventory. */
export interface OfflinePreference {
  userId: string;
  photos: boolean;
}

/** Facts about the saved copy, kept beside the preference. */
export interface OfflineCopyInfo {
  userId: string;
  householdId: string;
  householdName: string;
  savedAt: number;
  itemCount: number;
}

interface Stored {
  preference: OfflinePreference | null;
  info: OfflineCopyInfo | null;
}

function readStored(): Stored {
  try {
    const raw = window.localStorage.getItem(PREFERENCE_KEY);
    if (!raw) return { preference: null, info: null };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return { preference: parsed.preference ?? null, info: parsed.info ?? null };
  } catch {
    return { preference: null, info: null };
  }
}

function writeStored(stored: Stored) {
  try {
    if (!stored.preference && !stored.info) window.localStorage.removeItem(PREFERENCE_KEY);
    else window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(stored));
  } catch {
    // Storage is off (some private modes). The copy is then not kept.
  }
}

export function readPreference(): OfflinePreference | null {
  return readStored().preference;
}

export function writePreference(preference: OfflinePreference | null) {
  writeStored({ ...readStored(), preference });
}

export function readCopyInfo(): OfflineCopyInfo | null {
  return readStored().info;
}

export function writeCopyInfo(info: OfflineCopyInfo | null) {
  writeStored({ ...readStored(), info });
}

/** Sign-out was asked for while the server could not be reached. */
export function signOutPending(): boolean {
  try {
    return window.localStorage.getItem(SIGN_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSignOutPending(pending: boolean) {
  try {
    if (pending) window.localStorage.setItem(SIGN_OUT_KEY, "1");
    else window.localStorage.removeItem(SIGN_OUT_KEY);
  } catch {
    // Without storage there is nothing to remember.
  }
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser has no storage for an offline copy."));
      return;
    }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open offline storage."));
    request.onblocked = () => reject(new Error("Offline storage is in use by another tab."));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new Error("Offline storage failed."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("The device has no room for the offline copy."));
    });
  } finally {
    database.close();
  }
}

export async function readCopy(): Promise<OfflineCopy | null> {
  try {
    return (await withStore<OfflineCopy | undefined>("readonly", (store) => store.get(RECORD))) ?? null;
  } catch {
    return null;
  }
}

export async function writeCopy(copy: OfflineCopy): Promise<void> {
  await withStore("readwrite", (store) => store.put(copy, RECORD));
}

export async function deleteCopy(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
