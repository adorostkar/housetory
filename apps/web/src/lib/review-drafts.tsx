import * as React from "react";

import { api, ApiError } from "@/lib/api";

/** One row's whole draft and the address that keeps it. */
export interface DraftRequest {
  path: string;
  body: unknown;
  /** Called when the server has kept this draft. It must not change what is typed. */
  onSaved?: () => void;
}

interface Row {
  request: DraftRequest;
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

/**
 * A row that no longer waits answers 409 and a row that is gone answers 404. Nothing
 * is lost then, because its decision carried the draft. A person who may not write
 * (403) cannot keep a draft at all. None of these is tried again or shown.
 */
function gone(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 409) return error.code !== "import_busy";
  // 401: the session ended. The app asks the person to sign in again.
  return error.status === 404 || error.status === 403 || error.status === 401;
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
 * The answer of the server is never written back into the page.
 */
export function useDraftAutosave(delay = 600) {
  const rows = React.useRef(new Map<string, Row>());
  const alive = React.useRef(true);
  const [unsaved, setUnsaved] = React.useState(false);

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
    row.sending = true;
    row.again = false;
    const sent = row.request;
    // `keepalive` lets the request finish after the page is gone.
    row.pending = api.put(sent.path, sent.body, leaving ? { keepalive: true } : undefined).then(
      () => {
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
        if (rows.current.get(key) !== row) return;
        row.sending = false;
        if (row.cancelled || gone(error)) {
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

  const save = React.useCallback((key: string, request: DraftRequest) => {
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

  /** The row was decided (added, skipped, applied). Its waiting draft is dropped. */
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

  return React.useMemo(
    () => ({ save, cancel, flush, settle, unsaved }),
    [save, cancel, flush, settle, unsaved],
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
