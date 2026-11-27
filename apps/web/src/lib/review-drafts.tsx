import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { queryKeys, useSession } from "@/lib/queries";
import {
  REVIEW_DRAFT_BLIND_REPLAY_MS,
  REVIEW_DRAFTS_CLEARED_EVENT,
  noteLocalReviewDraftSent,
  readLocalReviewDraft,
  readLocalReviewDrafts,
  rebaseLocalReviewDraft,
  removeLocalReviewDraft,
  stableJson,
  writeLocalReviewDraft,
  type ReviewDraftScope,
  type ReviewRef,
  type StoredReviewDraft,
} from "@/lib/review-draft-store";

/** One row's whole draft and the address that keeps it. */
export interface DraftRequest {
  path: string;
  body: unknown;
  /**
   * What the server has for the row now, as far as the review knows, in a form the
   * review can build again from a fresh row. It is kept with the copy on this device.
   * When the review opens again, a copy is only used if the server still has this.
   */
  base?: unknown;
  /** The same form, from the answer of the server to this save. */
  rebase?: (response: unknown) => unknown;
  /** Called when the server has kept this draft. It must not change what is typed. */
  onSaved?: () => void;
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
 * A row that no longer waits answers 409 and a row that is gone answers 404. Nothing
 * is lost then, because its decision carried the draft. A person who may not write
 * (403) cannot keep a draft at all. None of these is tried again or shown.
 */
function gone(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 409) return error.code !== "import_busy" && !otherHousehold(error);
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
 * not go over a newer one that was saved since. The same review can be on screen
 * twice (the page, and the assistant): both then hold the same draft, and the one
 * that wrote the copy first may still send it.
 */
function copyToSend(scope: ReviewDraftScope, review: ReviewRef, row: string, at: number, body: unknown) {
  if (signedInAs?.userId !== scope.userId || signedInAs.householdId !== scope.householdId) return null;
  const copy = readLocalReviewDraft(scope, review, row);
  if (!copy) return null;
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
 * There is no row to compare with here, so only a copy of the last ten minutes is
 * sent (a reload, a quick navigation). An older one waits until its review opens,
 * which then checks that the server has nothing newer for the row.
 */
export function replayLocalReviewDrafts(scope: ReviewDraftScope): Promise<ReplayResult> {
  const name = `${scope.userId}:${scope.householdId}`;
  if (replaying?.name === name) return replaying.run;
  const run = (async () => {
    const result: ReplayResult = { saved: [], kept: 0, dropped: 0 };
    for (const draft of readLocalReviewDrafts(scope)) {
      if (openReviews.has(reviewName(scope, draft.review))) continue;
      if (Date.now() - draft.at > REVIEW_DRAFT_BLIND_REPLAY_MS) continue;
      // Read again just before the request: the copy may have been saved, replaced
      // or removed since this run began, here or in another tab.
      if (copyToSend(scope, draft.review, draft.row, draft.at, draft.body) !== draft.at) continue;
      try {
        await api.put(draft.path, draft.body);
        removeLocalReviewDraft(scope, draft.review, draft.row, draft.at);
        result.saved.push(draft);
      } catch (error) {
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
  for (const draft of result.saved) forgetLoadedReview(queryClient, draft.review);
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
 * The answer of the server is never written back into the page.
 */
export function useDraftAutosave(review?: ReviewRef, delay = 600) {
  const rows = React.useRef(new Map<string, Row>());
  const alive = React.useRef(true);
  const [unsaved, setUnsaved] = React.useState(false);
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
    // From now on the server may have this draft, also when its answer never comes.
    if (sent.local) noteLocalReviewDraftSent(sent.local.scope, sent.local.review, key, sent.body);
    // `keepalive` lets the request finish after the page is gone.
    row.pending = api.put(sent.path, sent.body, leaving ? { keepalive: true } : undefined).then(
      (response) => {
        const serverHas = sent.rebase?.(response);
        if (sent.local) {
          // The copy on this device goes only when it is the draft that was confirmed.
          removeLocalReviewDraft(sent.local.scope, sent.local.review, key, sent.local.at);
          // A newer copy of the row starts from what the server has after this save.
          if (sent.rebase) {
            rebaseLocalReviewDraft(sent.local.scope, sent.local.review, key, serverHas, sent.body);
          }
        }
        sent.onSaved?.();
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
  }, [report]);

  const save = React.useCallback((key: string, draft: DraftRequest) => {
    // Written to this device first, at once, so that it outlives a lost request.
    const where = placeRef.current;
    const at = where
      ? writeLocalReviewDraft(where.scope, where.review, key, {
          path: draft.path, body: draft.body, base: draft.base,
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

  /** The row was decided, or it is gone. Its copy on this device is removed. */
  const forget = React.useCallback((key: string) => {
    const where = placeRef.current;
    if (where) removeLocalReviewDraft(where.scope, where.review, key);
  }, []);

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
    () => ({ save, cancel, forget, flush, settle, unsaved, recovered }),
    [save, cancel, forget, flush, settle, unsaved, recovered],
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
