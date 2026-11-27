import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { queryKeys, useSession } from "@/lib/queries";
import {
  REVIEW_DRAFTS_CHANGED_EVENT,
  REVIEW_DRAFTS_CLEARED_EVENT,
  markLocalReviewDraftConflict,
  moveLocalReviewDraftBase,
  readLocalReviewDraft,
  readLocalReviewDrafts,
  removeLocalReviewDraft,
  stableJson,
  writeLocalReviewDraft,
  writerId,
  type ReviewDraftScope,
  type ReviewRef,
  type StoredReviewDraft,
} from "@/lib/review-draft-store";

/** One row's whole draft and the address that keeps it. */
export interface DraftRequest {
  path: string;
  /** The draft as the row has it. The revision and the device are added when it is sent. */
  body: unknown;
  /** The revision of the row's draft in the answer of the server to a save. */
  revisionOf?: (answer: unknown) => number | null | undefined;
  /** Called when the server has kept this draft. It must not change what is typed. */
  onSaved?: (answer: unknown) => void;
  /**
   * Called when the server did not keep the draft because another device changed the
   * row in the meantime. The review then shows the row as the server has it.
   */
  onConflict?: () => void;
}

/** A correction of this device that waits for the person to choose. */
export interface DraftConflict {
  path: string;
  body: unknown;
}

/** What is sent: the draft, the revision it was made on, and who sends it. */
function withRevision(body: unknown, revision: number, userId: string | undefined) {
  const draft = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  return { ...draft, expected_revision: revision, writer: writerId(userId) };
}

/** Where the copy of a draft is on this device, until the server confirms the draft. */
interface LocalCopy {
  scope: ReviewDraftScope;
  review: ReviewRef;
  at: number;
}

interface Queued extends DraftRequest {
  local: LocalCopy | null;
}

interface Row {
  request: Queued;
  /** Waits for the person to stop changing the row. */
  timer: number | null;
  /** Waits to try a failed save again. */
  retryTimer: number | null;
  sending: boolean;
  /** The request that is on its way. It never rejects. */
  pending: Promise<void> | null;
  /** A newer draft arrived while the last one was on its way. */
  again: boolean;
  failed: boolean;
  /** The row was added or skipped in the meantime: its answer no longer matters. */
  cancelled: boolean;
  attempts: number;
}

const RETRY_STEPS = [5_000, 15_000, 30_000];
// A save that keeps failing is given up after about four minutes of trying.
const MAX_ATTEMPTS = 10;

/** The session ended. The app asks the person to sign in again. */
function signedOut(error: unknown) {
  return error instanceof ApiError && error.status === 401;
}

/**
 * Another household is selected now, here or in another tab. The server did not
 * look at the row at all, so this says nothing about the draft.
 */
function otherHousehold(error: unknown) {
  return error instanceof ApiError && error.status === 409
    && error.code.startsWith("household_context_");
}

/**
 * Another device changed the row since this correction was made. The server kept
 * nothing. The correction stays on this device until the person chooses.
 */
function conflicting(error: unknown) {
  return error instanceof ApiError && error.status === 409 && error.code === "draft_conflict";
}

/**
 * A row that no longer waits answers 409 and a row that is gone answers 404. Nothing
 * is lost then, because its decision carried the draft. A person who may not write
 * (403) cannot keep a draft at all. None of these is tried again or shown.
 */
function gone(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 409) {
    return error.code !== "import_busy" && !otherHousehold(error) && !conflicting(error);
  }
  return error.status === 404 || error.status === 403;
}

// The user and household this tab works in now. A copy of another household is
// never sent: the request would go to the wrong household.
let signedInAs: ReviewDraftScope | null = null;

/** The signed-in user and household, which a copy on this device belongs to. */
export function useReviewDraftScope(): ReviewDraftScope | null {
  const session = useSession().data;
  const userId = session?.user?.id;
  const householdId = session?.household?.id;
  const scope = React.useMemo(
    () => (userId && householdId ? { userId, householdId } : null),
    [userId, householdId],
  );
  signedInAs = scope;
  return scope;
}

/**
 * The time of the copy when a draft may be sent now, else null. Its household must be
 * the one this tab works in, and the copy of its row must still say the same as the
 * draft. It is read again just before each request. An older draft that still waits
 * somewhere (a review that was left while its save kept failing, another tab) must
 * not go over a newer one that was saved since. A copy that is marked as a conflict
 * is never sent by itself. The same review can be on screen twice (the page, and the
 * assistant): both then hold the same draft, and the one that wrote the copy first
 * may still send it.
 */
function copyToSend(scope: ReviewDraftScope, review: ReviewRef, row: string, at: number, body: unknown) {
  if (signedInAs?.userId !== scope.userId || signedInAs.householdId !== scope.householdId) return null;
  const copy = readLocalReviewDraft(scope, review, row);
  if (!copy || copy.conflict) return null;
  return copy.at === at || stableJson(copy.body) === stableJson(body) ? copy.at : null;
}

// The reviews that are on screen. Each of them shows and sends its own copies.
const openReviews = new Map<string, number>();
const reviewName = (scope: ReviewDraftScope, review: ReviewRef) =>
  [scope.userId, scope.householdId, review.kind, review.id].join(":");

export interface ReplayResult {
  /** Copies the server has now. */
  saved: StoredReviewDraft[];
  /** Copies that could not be sent yet. They stay on this device. */
  kept: number;
  /** Copies the server can never keep. They were removed. */
  dropped: number;
  /** Copies of rows that another device changed. They stay, and wait for the person. */
  conflicts: StoredReviewDraft[];
}

let replaying: { name: string; run: Promise<ReplayResult> } | null = null;

/**
 * Sends the copies of this user and household that the server never confirmed. A
 * copy is removed when the server has it, or when its row is gone or decided. It
 * stays when the server cannot be reached, the session ended or another household
 * is selected. A review that is on screen is left out: it shows its copies in their
 * rows and sends them itself. Nothing is added or applied by this: a draft only
 * keeps a correction of a row that still waits.
 *
 * Each copy is sent with the revision it was made on. The server keeps it only when
 * no other device changed the row since. Otherwise the copy is marked as a conflict
 * and stays: its review shows it beside the row, for the person to choose.
 */
export function replayLocalReviewDrafts(scope: ReviewDraftScope): Promise<ReplayResult> {
  const name = `${scope.userId}:${scope.householdId}`;
  if (replaying?.name === name) return replaying.run;
  const run = (async () => {
    const result: ReplayResult = { saved: [], kept: 0, dropped: 0, conflicts: [] };
    for (const draft of readLocalReviewDrafts(scope)) {
      if (openReviews.has(reviewName(scope, draft.review))) continue;
      // A conflict waits for the person. It is never sent again by itself.
      if (draft.conflict) continue;
      // Read again just before the request: the copy may have been saved, replaced
      // or removed since this run began, here or in another tab.
      if (copyToSend(scope, draft.review, draft.row, draft.at, draft.body) !== draft.at) continue;
      try {
        await api.put(draft.path, withRevision(draft.body, draft.baseRevision, scope.userId));
        removeLocalReviewDraft(scope, draft.review, draft.row, draft.at);
        result.saved.push(draft);
      } catch (error) {
        if (conflicting(error)) {
          if (readLocalReviewDraft(scope, draft.review, draft.row)?.at === draft.at) {
            markLocalReviewDraftConflict(scope, draft.review, draft.row, true);
          }
          result.conflicts.push(draft);
          continue;
        }
        if (signedOut(error) || otherHousehold(error)) {
          // The same person gets the copies back after signing in again, or after
          // going back to this household.
          result.kept += 1;
          break;
        }
        if (gone(error)) {
          removeLocalReviewDraft(scope, draft.review, draft.row, draft.at);
        } else if (refused(error)) {
          removeLocalReviewDraft(scope, draft.review, draft.row, draft.at);
          result.dropped += 1;
        } else {
          result.kept += 1;
        }
      }
    }
    return result;
  })().finally(() => {
    if (replaying?.run === run) replaying = null;
  });
  replaying = { name, run };
  return run;
}

/** A review that was not on screen is read again, so that it has the kept draft. */
function forgetLoadedReview(queryClient: QueryClient, review: ReviewRef) {
  const queryKey = review.kind === "import"
    ? queryKeys.importBatch(review.id)
    : review.kind === "document"
      ? [...queryKeys.document(review.id), "extraction"]
      : queryKeys.reviewSuggestionsAll;
  queryClient.removeQueries({ queryKey, type: "inactive" });
  void queryClient.invalidateQueries({ queryKey });
}

// One plan for trying again, for the whole app: several reviews can be open at once.
let again: { name: string; timer: number | null; attempts: number } | null = null;
let watchers = 0;
const handled = new WeakSet<ReplayResult>();

function stopTryingAgain() {
  if (again?.timer != null) window.clearTimeout(again.timer);
  again = null;
}

/** Sends the copies and, while some could not be sent, tries again after a while. */
async function sendLocalReviewDrafts(scope: ReviewDraftScope, queryClient: QueryClient) {
  const name = `${scope.userId}:${scope.householdId}`;
  if (again?.name !== name) {
    stopTryingAgain();
    again = { name, timer: null, attempts: 0 };
  }
  if (again.timer != null) window.clearTimeout(again.timer);
  again.timer = null;
  const result = await replayLocalReviewDrafts(scope);
  // Several callers can wait for the same run. Its result is handled once.
  const plan = again;
  if (handled.has(result) || plan?.name !== name) return;
  handled.add(result);
  // A review that is opened next must show what the server has now: the correction
  // that was kept, or the row that another device changed.
  for (const draft of [...result.saved, ...result.conflicts]) {
    forgetLoadedReview(queryClient, draft.review);
  }
  if (result.dropped) {
    toast.message("A correction from an earlier visit could not be kept. It was removed.");
  }
  if (result.kept && plan.attempts < MAX_ATTEMPTS && plan.timer == null) {
    plan.attempts += 1;
    plan.timer = window.setTimeout(
      () => void sendLocalReviewDrafts(scope, queryClient),
      RETRY_STEPS[Math.min(plan.attempts, RETRY_STEPS.length) - 1]!,
    );
  }
}

/**
 * Sends corrections of earlier visits that the server never confirmed, as soon as a
 * person is signed in. It tries again by itself and when the connection returns.
 * Mount it once for the whole app. Each review also runs it when it opens.
 */
export function useReplayLocalReviewDrafts() {
  const scope = useReviewDraftScope();
  const queryClient = useQueryClient();
  React.useEffect(() => {
    if (!scope) {
      stopTryingAgain();
      return;
    }
    const online = () => {
      if (again) again.attempts = 0;
      void sendLocalReviewDrafts(scope, queryClient);
    };
    watchers += 1;
    void sendLocalReviewDrafts(scope, queryClient);
    window.addEventListener("online", online);
    // Sign-out removes every copy, so there is nothing left to try again.
    window.addEventListener(REVIEW_DRAFTS_CLEARED_EVENT, stopTryingAgain);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener(REVIEW_DRAFTS_CLEARED_EVENT, stopTryingAgain);
      watchers -= 1;
      if (watchers === 0) stopTryingAgain();
    };
  }, [scope, queryClient]);
}

/** Other rows of the same review are being added right now. It is over in a moment. */
function busy(error: unknown) {
  return error instanceof ApiError && error.status === 409 && error.code === "import_busy";
}

/** A draft the server refuses as it is. Sending the same one again cannot help. */
function refused(error: unknown) {
  return error instanceof ApiError && (error.status === 422 || error.status === 400);
}

/**
 * Keeps corrections of review rows on the server without a button.
 *
 * `save` takes the whole current draft of one row. It is sent a short moment after
 * the last change of that row: one request for each row, never one for each key
 * press. What still waits is sent at once when the page is hidden or left, and when
 * the review goes away. A failed save keeps waiting: it is tried again by itself, on
 * the next change, and when the connection returns. `unsaved` is true meanwhile. A
 * save that failed is still tried again for a while after the review went away.
 *
 * With `review`, each draft is also written to this device at once, before it is
 * sent, and removed when the server has confirmed that same draft. A browser can
 * lose a request while a page closes; the copy is then still there. `recovered` has
 * the copies of this review that were found when it opened: the review shows them in
 * their rows and sends them again with `save`. `forget` removes the copy of a row
 * whose decision went through.
 *
 * Two devices can correct the same row. `track` tells which revision of the row's
 * draft the row on screen was built from; every save is sent with it, and the
 * answer moves it on. When the server says that another device changed the row,
 * the correction is not sent again. It is kept in `conflicts`, and on this device,
 * until the person chooses: `takeMine` lets the review send it on top of what the
 * server has now, and `forget` drops it. Nothing here adds, skips or applies a row.
 *
 * The answer of the server is never written back into the page.
 */
export function useDraftAutosave(review?: ReviewRef, delay = 600) {
  const rows = React.useRef(new Map<string, Row>());
  const alive = React.useRef(true);
  const [unsaved, setUnsaved] = React.useState(false);
  // The revision of each row's draft that the row on screen was built from.
  const revisions = React.useRef(new Map<string, number>());
  // Conflicts that could not be written to this device. They last as long as the page.
  const unstored = React.useRef(new Map<string, DraftConflict>());
  const [conflicts, setConflicts] = React.useState<ReadonlyMap<string, DraftConflict>>(new Map());
  const scope = useReviewDraftScope();
  const kind = review?.kind;
  const reviewId = review?.id;
  const place = React.useMemo(
    () => (scope && kind && reviewId ? { scope, review: { kind, id: reviewId } } : null),
    [scope, kind, reviewId],
  );
  const placeRef = React.useRef(place);
  placeRef.current = place;
  // Read once, while this review opens and before its own request has come back.
  const recovered = React.useMemo(
    () => new Map(
      place ? readLocalReviewDrafts(place.scope, place.review).map((draft) => [draft.row, draft]) : [],
    ),
    [place],
  );
  React.useEffect(() => {
    if (!place) return;
    const name = reviewName(place.scope, place.review);
    openReviews.set(name, (openReviews.get(name) ?? 0) + 1);
    return () => {
      const count = (openReviews.get(name) ?? 1) - 1;
      if (count > 0) openReviews.set(name, count);
      else openReviews.delete(name);
    };
  }, [place]);
  // Copies of other reviews are sent while this one is open.
  useReplayLocalReviewDrafts();

  const report = React.useCallback(() => {
    if (!alive.current) return;
    setUnsaved([...rows.current.values()].some((row) => row.failed && !row.cancelled));
  }, []);

  // The corrections of this review that wait for the person to choose.
  const readConflicts = React.useCallback(() => {
    const where = placeRef.current;
    const next = new Map<string, DraftConflict>(unstored.current);
    if (where) {
      for (const draft of readLocalReviewDrafts(where.scope, where.review)) {
        if (draft.conflict) next.set(draft.row, { path: draft.path, body: draft.body });
      }
    }
    setConflicts((current) =>
      stableJson([...current]) === stableJson([...next]) ? current : next);
  }, []);
  React.useEffect(() => {
    unstored.current.clear();
  }, [kind, reviewId]);
  React.useEffect(() => {
    readConflicts();
    window.addEventListener(REVIEW_DRAFTS_CHANGED_EVENT, readConflicts);
    // Another tab of this browser can mark or resolve a conflict too.
    window.addEventListener("storage", readConflicts);
    return () => {
      window.removeEventListener(REVIEW_DRAFTS_CHANGED_EVENT, readConflicts);
      window.removeEventListener("storage", readConflicts);
    };
  }, [place, readConflicts]);

  /**
   * The row on screen was built from this revision of its draft on the server. With
   * `replace` false, a revision that is already known for the row is kept: the row
   * on screen was not built again.
   */
  const track = React.useCallback((key: string, revision: number | null | undefined, replace = true) => {
    if (!replace && revisions.current.has(key)) return;
    revisions.current.set(key, typeof revision === "number" && revision >= 0 ? revision : 0);
  }, []);

  /** The revision that is known for the row on screen, if any. */
  const tracked = React.useCallback((key: string) => revisions.current.get(key), []);

  /**
   * This page did something that changes what the server keeps for the row once:
   * it skipped the row, or loaded suggestions into it. The row on screen is what
   * the server has after that, so its revision moves on. It only does so when the
   * server is exactly one step further. More steps mean that another device
   * changed the row in between, and then the next save must be asked about.
   */
  const trackStep = React.useCallback((key: string, revision: number | null | undefined) => {
    const known = revisions.current.get(key);
    if (known !== undefined && revision === known + 1) revisions.current.set(key, revision);
  }, []);

  /** Another device changed the row. Its correction waits, and is not sent again. */
  const noteConflict = React.useCallback((key: string, fallback?: DraftConflict) => {
    const where = placeRef.current;
    const marked = where ? markLocalReviewDraftConflict(where.scope, where.review, key, true) : null;
    if (!marked && fallback) unstored.current.set(key, fallback);
    const row = rows.current.get(key);
    if (row) {
      if (row.timer != null) window.clearTimeout(row.timer);
      if (row.retryTimer != null) window.clearTimeout(row.retryTimer);
      rows.current.delete(key);
    }
    readConflicts();
    report();
  }, [readConflicts, report]);

  const send = React.useCallback((key: string, leaving = false) => {
    const row = rows.current.get(key);
    if (!row || row.cancelled) return;
    if (row.timer != null) window.clearTimeout(row.timer);
    if (row.retryTimer != null) window.clearTimeout(row.retryTimer);
    row.timer = null;
    row.retryTimer = null;
    if (row.sending && !leaving) {
      row.again = true;
      return;
    }
    let sent = row.request;
    if (sent.local) {
      const at = copyToSend(sent.local.scope, sent.local.review, key, sent.local.at, sent.body);
      if (at == null) {
        // Not sent. The copy, if it is still there, stays as it is.
        rows.current.delete(key);
        report();
        return;
      }
      if (at !== sent.local.at) {
        sent = { ...sent, local: { ...sent.local, at } };
        row.request = sent;
      }
    }
    row.sending = true;
    row.again = false;
    // The revision the row on screen was built from. The server keeps the draft only
    // when no other device changed the row since.
    const body = withRevision(
      sent.body,
      revisions.current.get(key) ?? 0,
      (sent.local?.scope ?? placeRef.current?.scope ?? signedInAs)?.userId,
    );
    // `keepalive` lets the request finish after the page is gone.
    row.pending = api.put(sent.path, body, leaving ? { keepalive: true } : undefined).then(
      (response) => {
        const revision = sent.revisionOf?.(response);
        if (typeof revision === "number") revisions.current.set(key, revision);
        if (sent.local) {
          // The copy on this device goes only when it is the draft that was confirmed.
          removeLocalReviewDraft(sent.local.scope, sent.local.review, key, sent.local.at);
          // A newer copy of the row was made on top of the draft the server has now.
          if (typeof revision === "number") {
            moveLocalReviewDraftBase(sent.local.scope, sent.local.review, key, revision);
          }
        }
        sent.onSaved?.(response);
        if (rows.current.get(key) !== row) return;
        row.sending = false;
        row.failed = false;
        row.attempts = 0;
        if (row.again) send(key);
        else if (row.timer == null && row.request === sent) rows.current.delete(key);
        report();
      },
      (error: unknown) => {
        // A row that is gone or decided needs no copy, and a draft the server refuses
        // can never be kept. When the session ended, the copy waits for the person.
        if (sent.local && (gone(error) || refused(error))) {
          removeLocalReviewDraft(sent.local.scope, sent.local.review, key, sent.local.at);
        }
        if (conflicting(error) && !row.cancelled) {
          // Another device changed the row. The newest correction of this device is
          // kept, and marked, and nothing of the row is sent again by itself. A row
          // whose decision is on its way is left to that decision.
          const latest = rows.current.get(key)?.request ?? sent;
          noteConflict(key, { path: latest.path, body: latest.body });
          latest.onConflict?.();
          return;
        }
        if (rows.current.get(key) !== row) return;
        row.sending = false;
        if (row.cancelled || gone(error) || signedOut(error) || otherHousehold(error)) {
          if (row.timer != null) window.clearTimeout(row.timer);
          rows.current.delete(key);
          report();
          return;
        }
        if (row.again) {
          send(key);
          return;
        }
        // A newer draft of this row already waits for its own turn.
        if (row.timer != null) return;
        row.attempts += 1;
        // A busy review is tried again soon, and is only told after a few tries.
        const soon = busy(error) && row.attempts <= 3;
        row.failed = !soon;
        if (!refused(error) && row.attempts < MAX_ATTEMPTS) {
          const wait = soon ? 1_000 : RETRY_STEPS[Math.min(row.attempts, RETRY_STEPS.length) - 1]!;
          row.retryTimer = window.setTimeout(() => send(key), wait);
        }
        report();
      },
    );
  }, [noteConflict, report]);

  const save = React.useCallback((key: string, draft: DraftRequest) => {
    // Written to this device first, at once, so that it outlives a lost request. A
    // correction that waits for the person to choose keeps its place: a change of
    // the row meanwhile is sent, but not copied over it.
    const where = placeRef.current;
    const waiting = where && readLocalReviewDraft(where.scope, where.review, key)?.conflict;
    const at = where && !waiting
      ? writeLocalReviewDraft(where.scope, where.review, key, {
          path: draft.path, body: draft.body, baseRevision: revisions.current.get(key) ?? 0,
        })
      : null;
    const request: Queued = { ...draft, local: where && at != null ? { ...where, at } : null };
    const current = rows.current.get(key);
    const row: Row = current && !current.cancelled
      ? current
      : { request, timer: null, retryTimer: null, sending: false, pending: null, again: false,
          failed: false, cancelled: false, attempts: 0 };
    row.request = request;
    if (row.timer != null) window.clearTimeout(row.timer);
    if (row.retryTimer != null) window.clearTimeout(row.retryTimer);
    row.retryTimer = null;
    row.timer = window.setTimeout(() => send(key), delay);
    rows.current.set(key, row);
    // A change is also the moment to try the rows that could not be saved before.
    for (const [other, waiting] of rows.current) {
      if (other !== key && waiting.failed && !waiting.sending && waiting.timer == null) {
        if (waiting.retryTimer != null) window.clearTimeout(waiting.retryTimer);
        waiting.retryTimer = null;
        waiting.timer = window.setTimeout(() => send(other), delay);
      }
    }
  }, [delay, send]);

  /**
   * The decision of the row is on its way (add, skip, apply). Its waiting draft is not
   * sent any more. The copy on this device stays until `forget`: if the decision does
   * not go through and the page is reloaded, the correction is still there.
   */
  const cancel = React.useCallback((key: string) => {
    const row = rows.current.get(key);
    if (!row) return;
    if (row.timer != null) window.clearTimeout(row.timer);
    if (row.retryTimer != null) window.clearTimeout(row.retryTimer);
    row.timer = null;
    row.retryTimer = null;
    row.again = false;
    row.cancelled = true;
    if (!row.sending) rows.current.delete(key);
    report();
  }, [report]);

  /**
   * The row was decided, or it is gone, or the person chose what the server has. Its
   * copy on this device is removed.
   */
  const forget = React.useCallback((key: string) => {
    const where = placeRef.current;
    unstored.current.delete(key);
    if (where) removeLocalReviewDraft(where.scope, where.review, key);
    else readConflicts();
  }, [readConflicts]);

  /**
   * The review found, when it opened, that another device changed the row since the
   * copy on this device was made. The copy is marked and waits for the person.
   */
  const markConflict = React.useCallback((key: string) => noteConflict(key), [noteConflict]);

  /**
   * The person chose their own correction. It is no longer a conflict: the review
   * puts it into the row and saves it, on top of what the server has now.
   */
  const takeMine = React.useCallback((key: string) => {
    const where = placeRef.current;
    unstored.current.delete(key);
    if (where) {
      markLocalReviewDraftConflict(
        where.scope, where.review, key, false, revisions.current.get(key) ?? 0,
      );
    }
    readConflicts();
  }, [readConflicts]);

  /** Sends everything that still waits, now. */
  const flush = React.useCallback((leaving = false) => {
    for (const [key, row] of rows.current) {
      if (row.cancelled) continue;
      const waiting = row.timer != null || row.retryTimer != null || row.again || row.failed;
      if (waiting && (leaving || !row.sending)) send(key, leaving);
    }
  }, [send]);

  /**
   * Sends everything that still waits and comes back when the server has answered.
   * For a step that reads the kept drafts on the server, such as taking suggestions.
   */
  const settle = React.useCallback(async () => {
    for (let round = 0; round < 3; round += 1) {
      flush();
      const waiting = [...rows.current.values()].flatMap((row) => (row.pending ? [row.pending] : []));
      if (waiting.length === 0) return;
      await Promise.all(waiting);
      if (![...rows.current.values()].some((row) => row.sending || row.again)) return;
    }
  }, [flush]);

  React.useEffect(() => {
    alive.current = true;
    const leave = () => flush(true);
    const hidden = () => {
      if (document.visibilityState === "hidden") flush(true);
    };
    const online = () => flush();
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("online", online);
      // The review goes away (navigation, closed surface): what waits is sent now.
      // A save that fails is still tried again; only the page is no longer told.
      flush(true);
      alive.current = false;
    };
  }, [flush]);

  // Sign-out removes every copy. Drafts that still wait here must not write one back.
  React.useEffect(() => {
    const cleared = () => {
      for (const row of rows.current.values()) row.request = { ...row.request, local: null };
    };
    window.addEventListener(REVIEW_DRAFTS_CLEARED_EVENT, cleared);
    return () => window.removeEventListener(REVIEW_DRAFTS_CLEARED_EVENT, cleared);
  }, []);

  return React.useMemo(
    () => ({
      save, cancel, forget, flush, settle, unsaved, recovered,
      track, tracked, trackStep, conflicts, markConflict, takeMine,
    }),
    [save, cancel, forget, flush, settle, unsaved, recovered, track, tracked, trackStep, conflicts,
      markConflict, takeMine],
  );
}

/**
 * True when the copy of a row on this device must not go into the row by itself:
 * it is marked as a conflict, or the server has a newer draft of the row that this
 * browser did not write. The server checks the same again when the copy is saved,
 * so a loaded row that is older than the server's does no harm here.
 */
export function copyConflicts(
  copy: Pick<StoredReviewDraft, "baseRevision" | "conflict">,
  server: { revision?: number | null; writer?: string | null },
) {
  if (copy.conflict) return true;
  return (server.revision ?? 0) > copy.baseRevision && server.writer !== reviewDraftWriter();
}

/** Who stores drafts from this tab: this browser and the person who is signed in. */
export function reviewDraftWriter(): string {
  return writerId(signedInAs?.userId);
}

/**
 * True when the server keeps a draft of a row that this writer did not store, at
 * another revision than the row on screen was built from (`known`). Without a
 * known revision, any draft from someone else counts. A skip and loaded
 * suggestions have no writer, so they count as someone else's too.
 */
export function changedElsewhere(
  server: { revision?: number | null; writer?: string | null },
  known: number | undefined,
) {
  const revision = server.revision ?? 0;
  if (server.writer === reviewDraftWriter()) return false;
  return known === undefined ? revision > 0 : revision !== known;
}

const CONFLICT_TEXT = {
  row: "This row was also corrected on another device.",
  line: "This line was also corrected on another device.",
  fields: "These details were also corrected on another device.",
  suggestion: "This suggestion was also edited on another device.",
} as const;

/**
 * One plain notice beside a row that another device changed while a correction of
 * this device was not saved yet. The row shows what the server has. The person
 * chooses: their own correction, or the other one. Nothing is added or applied.
 */
export function DraftConflictNotice({
  subject = "row",
  label,
  yours,
  onUseMine,
  onKeepOther,
  disabled,
  className,
}: {
  subject?: keyof typeof CONFLICT_TEXT;
  /** The name of the row, when the notice is not right beside it. */
  label?: string;
  /** The correction of this device in a few words, with its name in « ». */
  yours: string;
  onUseMine: () => void;
  onKeepOther: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label ? `Two corrections of ${label}` : "Two corrections"}
      data-draft-conflict
      className={className ?? "rounded-lg border border-brass/40 bg-brass-soft/40 px-3 py-2 text-xs leading-relaxed"}
    >
      <p role="status">
        {label && <span className="font-medium">{label}: </span>}
        {CONFLICT_TEXT[subject]} Yours: {yours}.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onUseMine}>
          Use mine
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onKeepOther}>
          Keep the other
        </Button>
      </div>
    </div>
  );
}

/** One quiet line near a review while a correction could not be kept yet. */
export function DraftSaveNotice({ show, className }: { show: boolean; className?: string }) {
  if (!show) return null;
  return (
    <p role="status" className={className ?? "text-xs text-muted-foreground"}>
      Your corrections are not saved yet. Trying again.
    </p>
  );
}
