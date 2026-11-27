/**
 * A copy of a review correction that the server has not confirmed yet.
 *
 * A correction is sent to the server a short moment after it is made. A browser can
 * lose that request when the page is closed or reloaded just then. So the correction
 * is first written here, on this device, and removed when the server has confirmed
 * it. After a reload the copy is sent again and shown in its row.
 *
 * Two devices can correct the same row. The server keeps a revision for the draft of
 * each row, and a copy says which revision its correction was made on
 * (`baseRevision`). The copy is sent with that number, and the server decides: it
 * keeps the copy, or it says that another device changed the row in the meantime.
 * Then the copy stays here, marked as a conflict, until the person chooses between
 * it and what the server has. It is never sent again by itself.
 *
 * Limitation: this is kept on this device only (localStorage), for one user in one
 * household. It is removed on sign-out, when the account changes, and after fourteen
 * days.
 */

const STORE_PREFIX = "housetory:review-draft:v2:";
// Copies of an older form. They cannot be checked by the server, so they are removed.
const OLD_PREFIXES = ["housetory:review-draft:v1:"];
const DEVICE_KEY = "housetory:device-id";

export const REVIEW_DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

let deviceInMemory: string | null = null;

/**
 * A name for this browser, made once. It is not about a person: it stays after
 * sign-out. It is one half of the writer of a draft (see `writerId`).
 */
export function deviceId(): string {
  const valid = (value: string | null): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
  try {
    const kept = localStorage.getItem(DEVICE_KEY);
    if (valid(kept)) return kept;
  } catch {
    // Storage is optional. The name then lasts as long as the page.
  }
  if (!deviceInMemory) {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    deviceInMemory = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  try {
    localStorage.setItem(DEVICE_KEY, deviceInMemory);
  } catch {
    // Storage is optional.
  }
  return deviceInMemory;
}

/**
 * Who stores a draft: this browser and the person who is signed in. The server sees
 * that a draft it keeps came from the same writer, which is so when the answer to
 * a save was lost. The person is part of it, so that a draft another person kept
 * on this same browser is never taken for one's own. It says nothing else about
 * the person or the device.
 */
export function writerId(userId: string | null | undefined): string {
  const person = (userId ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 36);
  return person ? `${deviceId().slice(0, 24)}-${person}` : deviceId().slice(0, 24);
}

export interface ReviewDraftScope {
  userId: string;
  householdId: string;
}

/** Which review a correction belongs to, for example an import or a document. */
export interface ReviewRef {
  kind: "import" | "document" | "inventory";
  id: string;
}

export interface LocalReviewDraft {
  /** The address that keeps the draft on the server. */
  path: string;
  /** The whole draft of the row, as it is sent. */
  body: unknown;
  /** When this copy was written. It also tells one copy of a row from the next. */
  at: number;
  /** The revision of the row's draft on the server that this correction was made on. */
  baseRevision: number;
  /**
   * Another device changed the row in the meantime. The copy waits for the person to
   * choose between it and what the server has.
   */
  conflict: boolean;
}

export interface StoredReviewDraft extends LocalReviewDraft {
  review: ReviewRef;
  row: string;
}

// Only the addresses that keep a draft may come back out of storage.
const DRAFT_PATH =
  /^\/(imports\/[\w-]+\/entries\/[\w-]+|documents\/[\w-]+\/extraction(\/lines\/[^/?#]+)?|inventory-review\/suggestions\/[\w-]+)\/draft$/;

const KINDS: ReadonlyArray<ReviewRef["kind"]> = ["import", "document", "inventory"];

function scopePrefix(scope: ReviewDraftScope): string {
  return `${STORE_PREFIX}${[scope.userId, scope.householdId].map(encodeURIComponent).join(":")}:`;
}

/** `housetory:review-draft:v2:<user>:<household>:<kind>:<review id>:<row key>` */
export function reviewDraftKey(scope: ReviewDraftScope, review: ReviewRef, row: string): string {
  return `${scopePrefix(scope)}${[review.kind, review.id, row].map(encodeURIComponent).join(":")}`;
}

function parse(key: string, raw: string | null, now: number): StoredReviewDraft | null {
  if (!raw) return null;
  try {
    const parts = key.slice(STORE_PREFIX.length).split(":").map(decodeURIComponent);
    const [, , kind, id, row] = parts;
    const record = JSON.parse(raw) as Partial<LocalReviewDraft> | null;
    if (
      parts.length !== 5 || !id || !row ||
      !KINDS.includes(kind as ReviewRef["kind"]) ||
      !record || typeof record !== "object" ||
      typeof record.path !== "string" || !DRAFT_PATH.test(record.path) ||
      typeof record.at !== "number" || !Number.isFinite(record.at) ||
      record.body === undefined ||
      typeof record.baseRevision !== "number" || !Number.isInteger(record.baseRevision) ||
      record.baseRevision < 0 ||
      now - record.at > REVIEW_DRAFT_MAX_AGE_MS || record.at - now > 60_000
    ) {
      return null;
    }
    return {
      review: { kind: kind as ReviewRef["kind"], id },
      row,
      path: record.path,
      body: record.body,
      at: record.at,
      baseRevision: record.baseRevision,
      conflict: record.conflict === true,
    };
  } catch {
    return null;
  }
}

function keysWith(prefix: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/** A value as text, with the keys of every object in order, to compare two values. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, part: unknown) =>
    part && typeof part === "object" && !Array.isArray(part)
      ? Object.fromEntries(Object.entries(part).sort(([left], [right]) => left.localeCompare(right)))
      : part) ?? "null";
}

/**
 * Removes the copies that are too old or cannot be read, of every account on this
 * device. Another person's copies must not stay for good because they never sign in
 * here again.
 */
export function pruneLocalReviewDrafts(now: number = Date.now()): void {
  try {
    for (const prefix of OLD_PREFIXES) {
      for (const key of keysWith(prefix)) localStorage.removeItem(key);
    }
    for (const key of keysWith(STORE_PREFIX)) {
      if (!parse(key, localStorage.getItem(key), now)) localStorage.removeItem(key);
    }
  } catch {
    // Storage is optional.
  }
}

/**
 * The copies of one user in one household, oldest first. With `review`, only the
 * copies of that review. Copies that are too old or cannot be read are removed,
 * for every account.
 */
export function readLocalReviewDrafts(
  scope: ReviewDraftScope | null,
  review?: ReviewRef,
  now: number = Date.now(),
): StoredReviewDraft[] {
  pruneLocalReviewDrafts(now);
  if (!scope) return [];
  const drafts: StoredReviewDraft[] = [];
  try {
    for (const key of keysWith(scopePrefix(scope))) {
      const draft = parse(key, localStorage.getItem(key), now);
      if (!draft) continue;
      if (review && (draft.review.kind !== review.kind || draft.review.id !== review.id)) continue;
      drafts.push(draft);
    }
  } catch {
    // Storage is optional. Without it a correction is only as safe as its request.
    return [];
  }
  return drafts.sort((left, right) => left.at - right.at);
}

/** The copy of one row as it is now, or null. */
export function readLocalReviewDraft(
  scope: ReviewDraftScope | null,
  review: ReviewRef,
  row: string,
  now: number = Date.now(),
): StoredReviewDraft | null {
  if (!scope) return null;
  try {
    const key = reviewDraftKey(scope, review, row);
    return parse(key, localStorage.getItem(key), now);
  } catch {
    return null;
  }
}

function store(key: string, draft: LocalReviewDraft) {
  localStorage.setItem(key, JSON.stringify({
    path: draft.path, body: draft.body, at: draft.at, baseRevision: draft.baseRevision,
    ...(draft.conflict ? { conflict: true } : {}),
  }));
}

function changed() {
  window.dispatchEvent(new Event(REVIEW_DRAFTS_CHANGED_EVENT));
}

/**
 * Writes the copy of a row and gives back its time, or null when storage is not
 * available or full. A later copy of the same row always has a later time.
 */
export function writeLocalReviewDraft(
  scope: ReviewDraftScope | null,
  review: ReviewRef,
  row: string,
  draft: { path: string; body: unknown; baseRevision: number },
  now: number = Date.now(),
): number | null {
  if (!scope) return null;
  try {
    const key = reviewDraftKey(scope, review, row);
    const earlier = parse(key, localStorage.getItem(key), now);
    const at = Math.max(now, (earlier?.at ?? 0) + 1);
    store(key, { path: draft.path, body: draft.body, at, baseRevision: draft.baseRevision, conflict: false });
    return at;
  } catch {
    return null;
  }
}

/**
 * The server kept an older draft of a row while a newer copy waits. The copy was
 * made on top of that draft, so it now starts from the revision the server gave.
 */
export function moveLocalReviewDraftBase(
  scope: ReviewDraftScope | null,
  review: ReviewRef,
  row: string,
  baseRevision: number,
): void {
  if (!scope) return;
  try {
    const key = reviewDraftKey(scope, review, row);
    const current = parse(key, localStorage.getItem(key), Date.now());
    if (!current || current.conflict) return;
    store(key, { ...current, baseRevision });
  } catch {
    // Storage is optional.
  }
}

/**
 * Marks the copy of a row as a conflict, or takes the mark away again. With a mark
 * the copy is never sent by itself. Gives back the copy, or null when there is none.
 */
export function markLocalReviewDraftConflict(
  scope: ReviewDraftScope | null,
  review: ReviewRef,
  row: string,
  conflict: boolean,
  baseRevision?: number,
): StoredReviewDraft | null {
  if (!scope) return null;
  try {
    const key = reviewDraftKey(scope, review, row);
    const current = parse(key, localStorage.getItem(key), Date.now());
    if (!current) return null;
    const next = { ...current, conflict, baseRevision: baseRevision ?? current.baseRevision };
    store(key, next);
    changed();
    return next;
  } catch {
    return null;
  }
}

/**
 * Removes the copy of a row. With `at`, only when the copy is still that one: an
 * answer to an older draft must not remove a newer one.
 */
export function removeLocalReviewDraft(
  scope: ReviewDraftScope | null,
  review: ReviewRef,
  row: string,
  at?: number,
): void {
  if (!scope) return;
  try {
    const key = reviewDraftKey(scope, review, row);
    if (at !== undefined) {
      const current = parse(key, localStorage.getItem(key), Date.now());
      if (current && current.at !== at) return;
    }
    localStorage.removeItem(key);
  } catch {
    // Nothing to remove when storage is unavailable.
  }
  changed();
}

export const REVIEW_DRAFTS_CLEARED_EVENT = "housetory:review-drafts-cleared";
/** A copy was removed, or its conflict mark changed. Open reviews read their copies again. */
export const REVIEW_DRAFTS_CHANGED_EVENT = "housetory:review-drafts-changed";

/** Removes every copy on this device, for every account. Used on sign-out. */
export function clearAllReviewDrafts(): void {
  try {
    for (const key of keysWith(STORE_PREFIX)) localStorage.removeItem(key);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
  window.dispatchEvent(new Event(REVIEW_DRAFTS_CLEARED_EVENT));
  changed();
}
