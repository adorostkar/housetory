import type { OfflineSnapshot } from "@/lib/types";

/*
 * Files kept on the device beside the offline copy, in the browser's Cache Storage:
 * the app's own code, so every page opens without the server, and one small
 * photo per item. The page writes them; the service worker only reads them.
 *
 * The app cache also tells the service worker that this device keeps a copy.
 */

export const APP_CACHE = "housetory-offline-app-v1";
export const PHOTO_CACHE = "housetory-offline-photos-v1";
const ASSET_LIST = "/offline-assets.json";
const PARALLEL = 4;

export interface PhotoPlanEntry {
  /** The address the pages ask for; the saved photo is filed under it. */
  key: string;
  /** Where the small copy is downloaded from. */
  source: string;
}

function available(): boolean {
  return typeof caches !== "undefined";
}

/** One photo per item: its main photo, or the picture that stands in for it. */
export function photoPlan(snapshot: OfflineSnapshot): PhotoPlanEntry[] {
  const plan = new Map<string, string>();
  for (const item of snapshot.items) {
    if (item.is_archived) continue;
    if (item.primary_photo) {
      plan.set(item.primary_photo.thumbnail_url, `/api/v1/offline/photos/${item.primary_photo.id}`);
      continue;
    }
    const picture = item.representative_image?.thumbnail_url ?? item.representative_image?.url;
    if (picture) plan.set(picture, picture);
  }
  return [...plan].map(([key, source]) => ({ key, source }));
}

async function inParallel<T>(
  entries: T[],
  signal: AbortSignal,
  work: (entry: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < entries.length && !signal.aborted) {
      const entry = entries[next++] as T;
      await work(entry);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, entries.length) }, worker));
}

async function keep(cache: Cache, wanted: Set<string>): Promise<Set<string>> {
  const have = new Set<string>();
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (wanted.has(path)) have.add(path);
    else await cache.delete(request);
  }
  return have;
}

/** Saves the app's code. Does nothing where there is no build to save (development). */
export async function saveAppFiles(signal: AbortSignal): Promise<void> {
  if (!available()) return;
  // Opening the cache is what marks this device for the service worker.
  const cache = await caches.open(APP_CACHE);
  let files: string[];
  try {
    const response = await fetch(ASSET_LIST, { cache: "no-store", signal });
    if (!response.ok) return;
    files = ((await response.json()) as { files: string[] }).files;
  } catch {
    return;
  }
  const have = await keep(cache, new Set(files));
  await inParallel(
    files.filter((file) => !have.has(file)),
    signal,
    async (file) => {
      try {
        // The header tells the service worker not to keep a second copy of the file.
        const response = await fetch(file, {
          headers: { "X-Housetory-Offline-Save": "1" },
          signal,
        });
        if (response.ok) await cache.put(file, response);
      } catch {
        // Tried again at the next update.
      }
    },
  );
}

/** Saves the planned photos and drops the ones no longer needed. */
export async function savePhotos(
  plan: PhotoPlanEntry[],
  signal: AbortSignal,
  onProgress: (saved: number, total: number) => void,
): Promise<void> {
  if (!available()) return;
  const cache = await caches.open(PHOTO_CACHE);
  const have = await keep(cache, new Set(plan.map((entry) => entry.key)));
  let saved = have.size;
  onProgress(saved, plan.length);
  await inParallel(
    plan.filter((entry) => !have.has(entry.key)),
    signal,
    async (entry) => {
      try {
        const response = await fetch(entry.source, { credentials: "include", signal });
        if (!response.ok) return;
        await cache.put(entry.key, response);
        saved += 1;
        onProgress(saved, plan.length);
      } catch {
        // A photo that failed (or a full device) is tried again at the next update.
      }
    },
  );
}

export async function deletePhotos(): Promise<void> {
  if (available()) await caches.delete(PHOTO_CACHE);
}

export async function deleteDeviceFiles(): Promise<void> {
  if (!available()) return;
  await Promise.all([caches.delete(PHOTO_CACHE), caches.delete(APP_CACHE)]);
}
