/**
 * A copy of a review correction that the server has not confirmed yet.
 *
 * A correction is sent to the server a short moment after it is made. A browser can
 * lose that request when the page is closed or reloaded just then. So the correction
 * is first written here, on this device, and removed when the server has confirmed
 * it. After a reload the copy is sent again and shown in its row.
 *
 * A copy also says what the server had for the row when the correction was made
 * (`base`). A copy can stay behind when the request did arrive but the page was gone
 * before the answer. So a review that opens compares the row on the server with that
 * base: when the server still has it, the copy is shown and sent again; when the
 * server has something else, the server wins and the copy is removed.
 *
 * Limitation: this is kept on this device only (localStorage), for one user in one
 * household. It is removed on sign-out, when the account changes, and after fourteen
 * days. Without a review on screen there is no row to compare with, so only a copy
 * of the last ten minutes is sent again blindly; an older one waits for its review.
 */

const STORE_PREFIX = "housetory:review-draft:v1:";

export const REVIEW_DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * How old a copy may be to be sent again without looking at the row on the server.
 * That is the reload or quick navigation case. Another device cannot realistically
 * have corrected the same row in that time.
 */
export const REVIEW_DRAFT_BLIND_REPLAY_MS = 10 * 60 * 1000;

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
  /**
   * What the server had for the row, as far as this browser knew, when the
   * correction was made. Each review has its own form for it.
   */
  base: unknown;
  /**
   * The drafts of the row that this browser sent and has no answer for, oldest first.
   * One of them may have reached the server. A row that says the same as one of
   * these was not corrected somewhere else: this browser put it there.
   */
  sent: unknown[];
}

/** How many sent drafts without an answer are remembered for one row. */
export const REVIEW_DRAFT_SENT_LIMIT = 6;

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

/** `housetory:review-draft:v1:<user>:<household>:<kind>:<review id>:<row key>` */
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
      record.body === undefined || !("base" in record) ||
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
      base: record.base ?? null,
      sent: Array.isArray(record.sent) ? record.sent.slice(-REVIEW_DRAFT_SENT_LIMIT) : [],
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

/**
 * Writes the copy of a row and gives back its time, or null when storage is not
 * available or full. A later copy of the same row always has a later time. While a
 * copy of the row is still there, its base and its sent drafts are kept: the server
 * has not confirmed anything newer for the row.
 */
export function writeLocalReviewDraft(
  scope: ReviewDraftScope | null,
  review: ReviewRef,
  row: string,
  draft: { path: string; body: unknown; base?: unknown },
  now: number = Date.now(),
): number | null {
  if (!scope) return null;
  try {
    const key = reviewDraftKey(scope, review, row);
    const earlier = parse(key, localStorage.getItem(key), now);
    const at = Math.max(now, (earlier?.at ?? 0) + 1);
    const base = earlier ? earlier.base : draft.base ?? null;
    localStorage.setItem(key, JSON.stringify({
      path: draft.path, body: draft.body, at, base, sent: earlier?.sent ?? [],
    }));
    return at;
  } catch {
    return null;
  }
}

/**
 * A draft of the row is sent now. It is remembered with the copy until its answer
 * comes: the request can reach the server although the answer never reaches the page.
 */
export function noteLocalReviewDraftSent(
  scope: ReviewDraftScope | null,
  review: ReviewRef,
  row: string,
  body: unknown,
): void {
  if (!scope) return;
  try {
    const key = reviewDraftKey(scope, review, row);
    const current = parse(key, localStorage.getItem(key), Date.now());
    if (!current) return;
    const text = stableJson(body);
    const sent = [...current.sent.filter((earlier) => stableJson(earlier) !== text), body]
      .slice(-REVIEW_DRAFT_SENT_LIMIT);
    localStorage.setItem(key, JSON.stringify({
      path: current.path, body: current.body, at: current.at, base: current.base, sent,
    }));
  } catch {
    // Storage is optional.
  }
}

/**
 * The server confirmed an older draft of a row while a newer copy waits. The copy
 * now starts from what the server has after that. The confirmed draft, and the ones
 * sent before it, are no longer open questions.
 */
export function rebaseLocalReviewDraft(
  scope: ReviewDraftScope | null,
  review: ReviewRef,
  row: string,
  base: unknown,
  confirmed?: unknown,
): void {
  if (!scope) return;
  try {
    const key = reviewDraftKey(scope, review, row);
    const current = parse(key, localStorage.getItem(key), Date.now());
    if (!current) return;
    const text = stableJson(confirmed);
    const index = current.sent.findIndex((earlier) => stableJson(earlier) === text);
    localStorage.setItem(key, JSON.stringify({
      path: current.path, body: current.body, at: current.at, base: base ?? null,
      sent: current.sent.slice(index + 1),
    }));
  } catch {
    // Storage is optional.
  }
}

/**
 * A value in one plain form, to compare what was sent with what the server gives
 * back: text without spaces around it, and nothing for empty values.
 */
export function plainForm(value: unknown): unknown {
  if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();
  if (Array.isArray(value)) {
    const items = value.map(plainForm).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, part]) => [key, plainForm(part)] as const)
      .filter(([, part]) => part !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value ?? undefined;
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
}

export const REVIEW_DRAFTS_CLEARED_EVENT = "housetory:review-drafts-cleared";

/** Removes every copy on this device, for every account. Used on sign-out. */
export function clearAllReviewDrafts(): void {
  try {
    for (const key of keysWith(STORE_PREFIX)) localStorage.removeItem(key);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
  window.dispatchEvent(new Event(REVIEW_DRAFTS_CLEARED_EVENT));
}
