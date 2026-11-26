/**
 * Recently opened items, for the "Recent" order of the item list.
 *
 * Limitation: this is kept on this device only (localStorage), for one user in
 * one household. It is not sent to the server, so another phone or browser has
 * its own list, and clearing site data forgets it. The times come from this
 * device's clock. It is removed on sign-out and when the account changes.
 */

const STORE_PREFIX = "housetory:recent-items:v1:";
const SNAPSHOT_KEY = "housetory:recent-items:snapshot";

/** The server takes at most 100 ids in one request; fifty is plenty for "recent". */
export const RECENT_ITEMS_LIMIT = 50;

export interface RecentItemsScope {
  userId: string;
  householdId: string;
}

/** Item id to the time it was last opened, in milliseconds. */
export type RecentItemsMap = Record<string, number>;

export function recentItemsKey(scope: RecentItemsScope): string {
  return `${STORE_PREFIX}${[scope.userId, scope.householdId].map(encodeURIComponent).join(":")}`;
}

function cleanMap(value: unknown): RecentItemsMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const clean: RecentItemsMap = {};
  for (const [id, openedAt] of Object.entries(value)) {
    if (typeof openedAt === "number" && Number.isFinite(openedAt) && openedAt > 0) {
      clean[id] = openedAt;
    }
  }
  return clean;
}

export function readRecentItems(scope: RecentItemsScope | null): RecentItemsMap {
  if (!scope) return {};
  try {
    const stored = localStorage.getItem(recentItemsKey(scope));
    return stored ? cleanMap(JSON.parse(stored)) : {};
  } catch {
    return {};
  }
}

/** Remembers that the item was opened now. Only the newest fifty are kept. */
export function recordItemOpened(
  scope: RecentItemsScope | null,
  itemId: string,
  now: number = Date.now(),
): void {
  if (!scope || !itemId) return;
  const entries = Object.entries({ ...readRecentItems(scope), [itemId]: now })
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, RECENT_ITEMS_LIMIT);
  try {
    localStorage.setItem(recentItemsKey(scope), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // The list still works without it; it is then ordered by when items were added.
  }
}

/** Removes the recently opened items of every account on this device. */
export function clearAllRecentItems(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(STORE_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
  try {
    sessionStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    // Same as above.
  }
}

/** A held order is for the way back from an item, not for the next day. */
const HOLD_MAX_AGE_MS = 30 * 60 * 1000;

interface StoredSnapshot {
  scope: string;
  view: string;
  openedAt: RecentItemsMap;
  /** When an item was opened from the list, or null when nothing is held. */
  heldAt: number | null;
}

function readSnapshot(): StoredSnapshot | null {
  try {
    const stored = sessionStorage.getItem(SNAPSHOT_KEY);
    if (!stored) return null;
    const value = JSON.parse(stored) as Partial<StoredSnapshot> | null;
    if (!value || typeof value.scope !== "string" || typeof value.view !== "string") return null;
    return {
      scope: value.scope,
      view: value.view,
      openedAt: cleanMap(value.openedAt),
      heldAt: typeof value.heldAt === "number" ? value.heldAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * The opening times a list should order by. While the user is browsing (an
 * item was opened from this same list view and they came back) the earlier
 * times are returned, so the list does not move. Otherwise the current times.
 */
export function recentItemsSnapshot(
  scope: RecentItemsScope | null,
  view: string,
  now: number = Date.now(),
): RecentItemsMap {
  if (!scope) return {};
  const snapshot = readSnapshot();
  if (
    snapshot?.heldAt != null &&
    now - snapshot.heldAt < HOLD_MAX_AGE_MS &&
    snapshot.scope === recentItemsKey(scope) &&
    snapshot.view === view
  ) {
    return snapshot.openedAt;
  }
  return readRecentItems(scope);
}

/** Notes which times the visible list is ordered by. */
export function keepRecentItemsSnapshot(
  scope: RecentItemsScope | null,
  view: string,
  openedAt: RecentItemsMap,
): void {
  if (!scope) return;
  try {
    const snapshot: StoredSnapshot = {
      scope: recentItemsKey(scope),
      view,
      openedAt,
      heldAt: null,
    };
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Without it the list is ordered again when the user comes back.
  }
}

/** Called when an item is opened from a list: the list keeps its order for the way back. */
export function holdRecentItemsSnapshot(now: number = Date.now()): void {
  const snapshot = readSnapshot();
  if (!snapshot) return;
  try {
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ ...snapshot, heldAt: now }));
  } catch {
    // See keepRecentItemsSnapshot.
  }
}

interface Dated {
  id: string;
  created_at: string;
}

/**
 * Puts recently opened items into a list that is ordered newest first.
 *
 * `loaded` is the pages fetched so far, ordered by creation time (newest
 * first, then id). `opened` is the recently opened items that match the same
 * filters. Each item is placed by the later of its creation and its opening;
 * equal times are ordered by id. While more pages can be loaded, an opened
 * item that belongs below the last loaded row is left out until that row's
 * page arrives, so loading more never inserts rows above the fold.
 */
export function mergeRecentItems<T extends Dated>(
  loaded: T[],
  opened: T[],
  openedAt: RecentItemsMap,
  hasMore: boolean,
): T[] {
  const created = (item: Dated) => Date.parse(item.created_at) || 0;
  const promoted = opened
    .map((item) => ({ item, key: openedAt[item.id] ?? 0 }))
    .filter((entry) => entry.key > created(entry.item))
    .sort((left, right) => right.key - left.key || (left.item.id < right.item.id ? -1 : 1));
  if (promoted.length === 0) return loaded;

  const promotedIds = new Set(promoted.map((entry) => entry.item.id));
  const comesBefore = (entry: { item: T; key: number }, key: number, id: string) =>
    entry.key > key || (entry.key === key && entry.item.id < id);
  const merged: T[] = [];
  let next = 0;
  for (const item of loaded) {
    if (promotedIds.has(item.id)) continue;
    const key = created(item);
    while (next < promoted.length && comesBefore(promoted[next]!, key, item.id)) {
      merged.push(promoted[next]!.item);
      next += 1;
    }
    merged.push(item);
  }
  const last = loaded[loaded.length - 1];
  while (next < promoted.length) {
    if (hasMore && last && !comesBefore(promoted[next]!, created(last), last.id)) break;
    merged.push(promoted[next]!.item);
    next += 1;
  }
  return merged;
}
