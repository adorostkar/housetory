import * as React from "react";

import { setOfflineGate, type OfflineGate } from "@/lib/api";
import {
  deleteCopy,
  readCopy,
  readCopyInfo,
  readPreference,
  setSignOutPending,
  signOutPending,
  writeCopy,
  writeCopyInfo,
  writePreference,
  type OfflineCopyInfo,
} from "@/lib/offline/copy-store";
import {
  deleteDeviceFiles,
  deletePhotos,
  photoPlan,
  saveAppFiles,
  savePhotos,
} from "@/lib/offline/device-cache";
import { answerOffline, offlineReadOnly } from "@/lib/offline/resolver";
import type { OfflineCopy, OfflineSnapshot, SessionState } from "@/lib/types";

/*
 * The offline copy: an opt-in, read-only copy of one household on this device.
 *
 * While the server answers, the app works as always and the copy is kept up to
 * date in the background. When the server cannot be reached, read requests are
 * answered from the copy and every change is refused. Nothing is queued.
 */

const API = "/api/v1";

/** The shape of the copy this version of the app can read. */
const SNAPSHOT_VERSION = 1;

/** Fired on `window` when the server can be reached again. */
export const BACK_ONLINE_EVENT = "housetory:back-online";

/** A copy that had no contact with the server for this long is removed. */
export const MAX_COPY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** How old a copy may be before it is refreshed when the app is opened or shown. */
const FRESH_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 3500;
const SLOW_REQUEST_MS = 5000;
const RETRY_MS = 15_000;
const WRITE_SETTLE_MS = 5000;

export interface OfflineStatus {
  /** This browser can keep a copy. */
  supported: boolean;
  /** This account chose to keep a copy on this device. */
  enabled: boolean;
  /** Small photos are part of the copy. */
  photos: boolean;
  /** The household lets this account keep a copy. */
  allowed: boolean;
  /** The saved copy, if there is one. */
  info: OfflineCopyInfo | null;
  /**
   * The service worker is in charge of this page. Without it the copy works
   * while the app stays open, but the app cannot be opened without the server.
   */
  appReady: boolean;
  /** False while the server cannot be reached and the copy is shown. */
  online: boolean;
  syncing: boolean;
  syncError: string | null;
  photoProgress: { saved: number; total: number } | null;
}

function supported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof indexedDB !== "undefined" &&
    typeof caches !== "undefined" &&
    "serviceWorker" in navigator
  );
}

function workerInCharge(): boolean {
  return Boolean(navigator.serviceWorker?.controller);
}

let status: OfflineStatus = {
  supported: false,
  enabled: false,
  photos: true,
  allowed: false,
  info: null,
  appReady: false,
  online: true,
  syncing: false,
  syncError: null,
  photoProgress: null,
};
const listeners = new Set<() => void>();

function update(patch: Partial<OfflineStatus>) {
  status = { ...status, ...patch };
  for (const listener of [...listeners]) listener();
}

export function getOfflineStatus(): OfflineStatus {
  return status;
}

export function subscribeOffline(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOfflineStatus(): OfflineStatus {
  return React.useSyncExternalStore(subscribeOffline, getOfflineStatus, getOfflineStatus);
}

let started = false;
let session: SessionState | null = null;
let copyInMemory: OfflineCopy | null = null;
let dirty = false;
let syncRun: Promise<void> | null = null;
let syncAgain = false;
let syncAbort: AbortController | null = null;
let probeRun: Promise<boolean> | null = null;
let retryTimer: number | null = null;
let writeTimer: number | null = null;
let signOutWaiting = false;
let signOutRun: Promise<void> | null = null;

function expired(info: OfflineCopyInfo): boolean {
  return Date.now() - info.savedAt > MAX_COPY_AGE_MS;
}

async function loadCopy(): Promise<OfflineCopy | null> {
  const info = status.info;
  if (!info) return null;
  if (!copyInMemory) copyInMemory = await readCopy();
  if (
    copyInMemory &&
    copyInMemory.userId === info.userId &&
    copyInMemory.snapshot.version === SNAPSHOT_VERSION
  ) {
    return copyInMemory;
  }
  copyInMemory = null;
  return null;
}

function tellWorker() {
  try {
    navigator.serviceWorker?.controller?.postMessage({
      type: "housetory-offline",
      enabled: status.info !== null,
      online: status.online,
    });
  } catch {
    // No worker (development, or a browser without one): nothing to tell.
  }
}

function stopRetrying() {
  if (retryTimer !== null) window.clearInterval(retryTimer);
  retryTimer = null;
}

function goOffline() {
  if (!status.online || !status.info) return;
  syncAbort?.abort();
  update({ online: false, syncing: false });
  tellWorker();
  stopRetrying();
  retryTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") void checkConnection();
  }, RETRY_MS);
  // A single lost request is often a short gap. Look again soon.
  window.setTimeout(() => void checkConnection(), 3000);
}

function goOnline() {
  if (status.online) return;
  stopRetrying();
  dirty = true;
  update({ online: true });
  tellWorker();
  window.dispatchEvent(new Event(BACK_ONLINE_EVENT));
}

async function probe(): Promise<boolean> {
  const abort = new AbortController();
  const timer = window.setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${API}/health/live`, {
      cache: "no-store",
      signal: abort.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Asks the server if it is there, and switches between the server and the copy. */
export function checkConnection(): Promise<boolean> {
  probeRun ??= probe()
    .then((reachable) => {
      if (reachable) goOnline();
      else {
        if (status.info && expired(status.info)) void removeCopy();
        goOffline();
      }
      return reachable;
    })
    .finally(() => {
      probeRun = null;
    });
  return probeRun;
}

/** Removes the copy and its files from this device. The choice to keep one stays. */
async function removeCopy(): Promise<void> {
  syncAbort?.abort();
  copyInMemory = null;
  writeCopyInfo(null);
  stopRetrying();
  // With nothing left to show, the app goes back to asking the server.
  update({ info: null, photoProgress: null, syncError: null, syncing: false, online: true });
  tellWorker();
  await Promise.all([deleteCopy(), deleteDeviceFiles()]).catch(() => undefined);
}

/** Ends the session on the server after a sign-out that the server did not hear of. */
async function finishSignOut(): Promise<void> {
  if (!signOutWaiting) return;
  // Tried before every request, so that no request is answered for the old session.
  signOutRun ??= (async () => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(`${API}/auth/logout`, {
        method: "POST",
        credentials: "include",
        signal: abort.signal,
      });
      if (response.ok || response.status === 401) {
        signOutWaiting = false;
        setSignOutPending(false);
      }
    } catch {
      // Still no server. The next request tries again.
    } finally {
      window.clearTimeout(timer);
      signOutRun = null;
    }
  })();
  await signOutRun;
}

/**
 * Sign-out while the server cannot be reached: the copy is removed now, and the
 * session on the server is ended as soon as the server answers again.
 */
export async function signOutOffline(): Promise<void> {
  signOutWaiting = true;
  setSignOutPending(true);
  session = null;
  await removeCopy();
}

const gate: OfflineGate = {
  async intercept(method, path) {
    if (signOutWaiting) await finishSignOut();
    if (status.online) return undefined;
    if (method !== "GET") throw offlineReadOnly();
    const copy = await loadCopy();
    if (!copy) {
      // The browser dropped the copy. There is nothing to show but the server.
      await removeCopy();
      return undefined;
    }
    return { data: answerOffline(copy, path) };
  },
  async onNetworkFailure(method, path) {
    if (!status.info) return undefined;
    // One failed request is not proof. Something on the device may have blocked
    // it. The copy is used only when the server itself does not answer.
    if (status.online && (await checkConnection())) return undefined;
    if (status.online || method !== "GET") return undefined;
    const copy = await loadCopy();
    return copy ? { data: answerOffline(copy, path) } : undefined;
  },
  watch(method) {
    if (method !== "GET" || !status.online || !status.info) return null;
    let finish: () => void = () => undefined;
    const offline = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = subscribeOffline(() => {
      if (!status.online) finish();
    });
    // A request that hangs (a server that is not there, a dead network) is not an
    // error for a long time. Ask the server directly instead of waiting for it.
    const timer = window.setTimeout(() => void checkConnection(), SLOW_REQUEST_MS);
    return {
      offline,
      done() {
        window.clearTimeout(timer);
        unsubscribe();
      },
    };
  },
  onResponse(method, path, ok) {
    if (!ok || method === "GET" || !status.enabled || path.startsWith("/auth/")) return;
    // Something changed on the server. Refresh the copy once the changes settle.
    dirty = true;
    if (writeTimer !== null) window.clearTimeout(writeTimer);
    writeTimer = window.setTimeout(() => {
      writeTimer = null;
      void syncOfflineCopy();
    }, WRITE_SETTLE_MS);
  },
};

function storedSession(state: SessionState, snapshot: OfflineSnapshot): SessionState {
  return {
    ...state,
    household: snapshot.household,
    role: snapshot.role,
    offline_copy_allowed: true,
  };
}

async function runSync(): Promise<void> {
  const state = session;
  const preference = readPreference();
  if (!state?.user || !state.household || !preference || !status.enabled || !status.online) return;
  const abort = new AbortController();
  syncAbort = abort;
  dirty = false;
  update({ syncing: true, syncError: null });
  try {
    const saved = await (status.info ? loadCopy() : Promise.resolve(null));
    const current =
      saved && saved.userId === state.user.id && saved.householdId === state.household.id
        ? saved
        : null;
    const response = await fetch(`${API}/offline/snapshot`, {
      credentials: "include",
      cache: "no-store",
      headers: current?.etag ? { "If-None-Match": current.etag } : undefined,
      signal: abort.signal,
    });
    let copy: OfflineCopy;
    if (response.status === 304 && current) {
      copy = { ...current, savedAt: Date.now(), session: storedSession(state, current.snapshot) };
    } else if (response.ok) {
      const snapshot = (await response.json()) as OfflineSnapshot;
      if (snapshot.version !== SNAPSHOT_VERSION) {
        throw new Error("Housetory was updated. Reload the app to save the offline copy.");
      }
      copy = {
        userId: snapshot.user.id,
        householdId: snapshot.household.id,
        savedAt: Date.now(),
        etag: response.headers.get("ETag"),
        session: storedSession(state, snapshot),
        snapshot,
      };
    } else if (response.status === 403) {
      // The household does not allow a copy for this account (any more).
      update({ allowed: false });
      await removeCopy();
      return;
    } else if (response.status === 401) {
      return;
    } else {
      throw new Error("The server could not prepare the offline copy. Try again later.");
    }
    if (abort.signal.aborted) return;
    await writeCopy(copy);
    copyInMemory = copy;
    const info: OfflineCopyInfo = {
      userId: copy.userId,
      householdId: copy.householdId,
      householdName: copy.snapshot.household.name,
      savedAt: copy.savedAt,
      itemCount: copy.snapshot.items.filter((item) => !item.is_archived).length,
    };
    writeCopyInfo(info);
    update({ info, syncing: false });

    await saveAppFiles(abort.signal);
    update({ appReady: workerInCharge() });
    tellWorker();
    if (preference.photos) {
      await savePhotos(photoPlan(copy.snapshot), abort.signal, (done, total) =>
        update({ photoProgress: { saved: done, total } }),
      );
    } else {
      await deletePhotos();
      update({ photoProgress: null });
    }
  } catch (error) {
    if (abort.signal.aborted) return;
    if (error instanceof TypeError) {
      // The network failed, not the copy. The connection check decides what is shown.
      void checkConnection();
      update({ syncError: "The server could not be reached. The copy was not updated." });
    } else {
      update({
        syncError:
          error instanceof Error ? error.message : "The offline copy could not be saved.",
      });
    }
  } finally {
    if (syncAbort === abort) syncAbort = null;
    update({ syncing: false });
  }
}

/** Brings the copy up to date. Calls made while one runs are joined into one more run. */
export function syncOfflineCopy(): Promise<void> {
  if (syncRun) {
    syncAgain = true;
    return syncRun;
  }
  syncRun = runSync().finally(() => {
    syncRun = null;
    if (syncAgain) {
      syncAgain = false;
      void syncOfflineCopy();
    }
  });
  return syncRun;
}

/**
 * Tells the offline copy who is signed in. Called with every session answer
 * that came from the server. It removes a copy that no longer belongs here.
 */
export function offlineSessionChanged(state: SessionState) {
  if (!status.online) return;
  session = state;
  const info = readCopyInfo();
  if (!state.authenticated || !state.user) {
    update({ enabled: false, allowed: false });
    if (info || status.info) void removeCopy();
    return;
  }
  const preference = readPreference();
  const mine = preference?.userId === state.user.id;
  const allowed = Boolean(state.offline_copy_allowed && state.household);
  update({ enabled: mine, photos: mine ? preference.photos : true, allowed });
  if (info && (info.userId !== state.user.id || !mine || !allowed)) {
    void removeCopy();
    return;
  }
  if (!mine || !allowed || !state.household) return;
  if (
    !info ||
    info.householdId !== state.household.id ||
    Date.now() - info.savedAt > FRESH_MS ||
    dirty
  ) {
    void syncOfflineCopy();
  }
}

/** Starts keeping a copy for the signed-in account on this device. */
export async function enableOfflineCopy(photos = true): Promise<void> {
  if (!status.supported) throw new Error("This browser cannot keep an offline copy.");
  if (!session?.user) throw new Error("Sign in to keep an offline copy.");
  writePreference({ userId: session.user.id, photos });
  if (!readPreference()) {
    throw new Error(
      "This browser does not let Housetory keep data on the device. A private window does this.",
    );
  }
  update({ enabled: true, photos, allowed: Boolean(session.offline_copy_allowed) });
  // Asks the browser not to clear the copy when the device runs low on space.
  void navigator.storage?.persist?.().catch(() => undefined);
  await syncOfflineCopy();
}

export async function setOfflinePhotos(photos: boolean): Promise<void> {
  const preference = readPreference();
  if (!preference) return;
  writePreference({ ...preference, photos });
  update({ photos });
  await syncOfflineCopy();
}

/** Stops keeping a copy and removes it from this device. Works without the server. */
export async function disableOfflineCopy(): Promise<void> {
  writePreference(null);
  update({ enabled: false });
  await removeCopy();
}

/** Signed out, or the session ended: nothing of the account stays on the device. */
export async function removeOfflineCopyOnSignOut(): Promise<void> {
  session = null;
  await removeCopy();
}

/** Reads what this device keeps and starts watching the connection. Call once, early. */
export function startOffline() {
  if (started) return;
  started = true;
  setOfflineGate(gate);
  signOutWaiting = signOutPending();
  const preference = readPreference();
  let info = readCopyInfo();
  if (info && (!preference || preference.userId !== info.userId || expired(info))) {
    info = null;
    void removeCopy();
  }
  status = {
    ...status,
    supported: supported(),
    enabled: preference !== null,
    photos: preference?.photos ?? true,
    allowed: info !== null,
    info,
    appReady: workerInCharge(),
    // With a copy at hand and the device itself offline, do not wait for a request to fail.
    online: !(info && navigator.onLine === false),
  };

  window.addEventListener("online", () => void checkConnection());
  window.addEventListener("offline", () => goOffline());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!status.online) void checkConnection();
    else if (status.enabled && status.info && Date.now() - status.info.savedAt > FRESH_MS) {
      void syncOfflineCopy();
    }
  });
  // Another tab removed the copy (sign-out, turned off): this tab lets go of it too.
  window.addEventListener("storage", () => {
    if (status.info === null || readCopyInfo() !== null) return;
    syncAbort?.abort();
    copyInMemory = null;
    stopRetrying();
    update({
      info: null,
      enabled: readPreference() !== null,
      photoProgress: null,
      syncing: false,
      online: true,
    });
  });
  navigator.serviceWorker?.addEventListener("controllerchange", () => {
    update({ appReady: workerInCharge() });
    tellWorker();
  });
  // The service worker loaded this page. If the server did not answer it then,
  // the copy is shown at once instead of after one more wait for the server.
  navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: string; online?: boolean } | null;
    if (data?.type === "housetory-offline-state" && data.online === false) goOffline();
  });

  if (!status.online) {
    // `status.online` is already false; start the same retries as a later switch does.
    tellWorker();
    retryTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void checkConnection();
    }, RETRY_MS);
    void checkConnection();
  } else if (info) {
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: "housetory-offline-ask" });
    } catch {
      // No worker to ask. The connection check below decides.
    }
    void checkConnection();
  }
}

/** For tests: forget everything held in memory. */
export function resetOfflineForTests() {
  stopRetrying();
  if (writeTimer !== null) window.clearTimeout(writeTimer);
  writeTimer = null;
  started = false;
  session = null;
  copyInMemory = null;
  dirty = false;
  syncRun = null;
  syncAgain = false;
  syncAbort = null;
  probeRun = null;
  signOutWaiting = false;
  signOutRun = null;
  listeners.clear();
  status = {
    supported: false,
    enabled: false,
    photos: true,
    allowed: false,
    info: null,
    appReady: false,
    online: true,
    syncing: false,
    syncError: null,
    photoProgress: null,
  };
  setOfflineGate(null);
}
