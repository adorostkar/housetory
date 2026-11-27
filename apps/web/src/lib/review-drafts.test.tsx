import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { clearAllItemDrafts } from "@/lib/item-drafts";
import { queryKeys } from "@/lib/queries";
import {
  REVIEW_DRAFT_MAX_AGE_MS,
  deviceId,
  markLocalReviewDraftConflict,
  readLocalReviewDraft,
  readLocalReviewDrafts,
  removeLocalReviewDraft,
  reviewDraftKey,
  writeLocalReviewDraft,
  writerId,
  type ReviewDraftScope,
  type ReviewRef,
} from "@/lib/review-draft-store";
import {
  changedElsewhere, copyConflicts, reviewDraftWriter, useDraftAutosave, useReplayLocalReviewDrafts,
} from "@/lib/review-drafts";

vi.mock("sonner", () => ({ toast: { message: vi.fn(), success: vi.fn(), error: vi.fn() } }));

let session: { user: { id: string } | null; household: { id: string } | null };
vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return { ...actual, useSession: () => ({ data: session }) };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, put: vi.fn() } };
});

const me = { userId: "user-1", householdId: "house-1" };
const review: ReviewRef = { kind: "import", id: "batch-1" };
const path = (row: string) => `/imports/batch-1/entries/${row}/draft`;
const stored = (scope = me, of: ReviewRef | undefined = review) => readLocalReviewDrafts(scope, of);
const pass = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
/** A copy on this device, made on revision 0 of its row unless it says otherwise. */
const write = (
  scope: ReviewDraftScope, of: ReviewRef, row: string,
  draft: { path: string; body: unknown; baseRevision?: number }, now?: number,
) => writeLocalReviewDraft(scope, of, row, { baseRevision: 0, ...draft }, now);
/** A draft as it is sent: with the revision it was made on, by this person on this device. */
const sent = (body: object, revision = 0) =>
  ({ ...body, expected_revision: revision, writer: writerId("user-1") });
const conflict = () => new ApiError(409, "draft_conflict", "This row was also corrected on another device.");

type Autosave = ReturnType<typeof useDraftAutosave>;
let autosave: Autosave;
function Review({ of = review }: { of?: ReviewRef }) {
  autosave = useDraftAutosave(of);
  return <p>{autosave.unsaved ? "not saved" : "saved"}</p>;
}
function Replay() {
  useReplayLocalReviewDrafts();
  return null;
}
function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}>{node}</QueryClientProvider>) };
}

beforeEach(() => {
  localStorage.clear();
  session = { user: { id: "user-1" }, household: { id: "house-1" } };
  vi.mocked(api.put).mockReset();
  vi.mocked(api.put).mockResolvedValue({});
  vi.mocked(toast.message).mockClear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("the copy of a correction on this device", () => {
  it("is written at once, before the request, under the user, household, review and row", async () => {
    mount(<Review />);
    act(() => autosave.save("e1", { path: path("e1"), body: { name: "Step ladder" } }));
    // Nothing was sent yet. The copy is already there, so a reload now loses nothing.
    expect(api.put).not.toHaveBeenCalled();
    const key = "housetory:review-draft:v2:user-1:house-1:import:batch-1:e1";
    expect(reviewDraftKey(me, review, "e1")).toBe(key);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      path: path("e1"), body: { name: "Step ladder" }, at: expect.any(Number), baseRevision: 0,
    });
    expect(stored()).toEqual([expect.objectContaining({ review, row: "e1", body: { name: "Step ladder" } })]);
  });

  it("is removed when the server confirms that same draft, and not by an answer to an older one", async () => {
    let confirmFirst!: () => void;
    vi.mocked(api.put).mockImplementationOnce(() => new Promise((resolve) => { confirmFirst = () => resolve({}); }));
    mount(<Review />);
    act(() => autosave.save("e1", { path: path("e1"), body: { name: "Step" } }));
    await pass(600);
    expect(api.put).toHaveBeenCalledTimes(1);
    // A newer correction is made while the first one is still on its way.
    act(() => autosave.save("e1", { path: path("e1"), body: { name: "Step ladder" } }));
    confirmFirst();
    await pass(0);
    // The answer to the older draft does not remove the newer copy.
    expect(stored()).toEqual([expect.objectContaining({ body: { name: "Step ladder" } })]);
    await pass(600);
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(stored()).toEqual([]);
  });

  it("stays while the save fails, and through a reload of the page", async () => {
    vi.mocked(api.put).mockRejectedValue(new ApiError(0, "network_error", "No connection."));
    const view = mount(<Review />);
    act(() => autosave.save("e1", { path: path("e1"), body: { name: "Step ladder" } }));
    await pass(600);
    expect(view.getByText("not saved")).toBeTruthy();
    expect(stored()).toHaveLength(1);
    await pass(5000);
    expect(stored()).toHaveLength(1);
    // The page goes away with the save still failing. The review that opens next
    // finds the correction and can show it in its row.
    view.unmount();
    expect(stored()).toHaveLength(1);
    mount(<Review />);
    expect([...autosave.recovered]).toEqual([
      ["e1", expect.objectContaining({ path: path("e1"), body: { name: "Step ladder" } })],
    ]);
  });

  it("stays when the decision of the row is on its way, and goes when the decision went through", async () => {
    mount(<Review />);
    act(() => autosave.save("e1", { path: path("e1"), body: { name: "Step ladder" } }));
    // Add or Skip was pressed: the waiting request is dropped, the copy is not.
    act(() => autosave.cancel("e1"));
    await pass(5000);
    expect(api.put).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(1);
    act(() => autosave.forget("e1"));
    expect(stored()).toEqual([]);
  });

  it("goes when the server says the row is decided or gone, and stays when the session ended", async () => {
    mount(<Review />);
    for (const [error, left] of [
      [new ApiError(409, "import_entry_not_pending", "No longer waiting."), 0],
      [new ApiError(404, "import_entry_not_found", "Gone."), 0],
      [new ApiError(403, "read_only_role", "Viewers cannot write."), 0],
      [new ApiError(422, "validation_error", "Not valid."), 0],
      [new ApiError(401, "not_authenticated", "Sign in."), 1],
      // Another household was selected in another tab. The server did not look at the row.
      [new ApiError(409, "household_context_changed", "The selected household changed."), 1],
      [new ApiError(409, "household_context_required", "Choose a household."), 1],
      [new ApiError(409, "import_busy", "Busy."), 1],
      // Another device changed the row. The correction waits for the person.
      [conflict(), 1],
      [new ApiError(503, "request_failed", "Try later."), 1],
    ] as const) {
      localStorage.clear();
      vi.mocked(api.put).mockReset();
      vi.mocked(api.put).mockRejectedValue(error);
      act(() => autosave.save(`row-${error.code}`, { path: path("e1"), body: { name: "Step ladder" } }));
      await pass(600);
      expect(stored(), error.code).toHaveLength(left);
    }
  });

  it("is not sent, and stays, when another household is selected in this tab", async () => {
    const view = mount(<Review />);
    act(() => autosave.save("e1", { path: path("e1"), body: { name: "Step ladder" } }));
    // The person goes to another household before the request is sent. Sending it now
    // would ask the other household for the row, which answers 404.
    vi.mocked(api.put).mockRejectedValue(new ApiError(404, "import_not_found", "Import not found."));
    session = { user: { id: "user-1" }, household: { id: "house-2" } };
    view.rerender(<QueryClientProvider client={view.client}><Review /></QueryClientProvider>);
    await pass(5000);
    expect(api.put).not.toHaveBeenCalled();
    expect(stored()).toEqual([expect.objectContaining({ row: "e1", body: { name: "Step ladder" } })]);
  });

  it("does not let an older draft that still waits go over a newer one that was saved since", async () => {
    vi.mocked(api.put)
      .mockRejectedValueOnce(new ApiError(0, "network_error", "No connection."))
      .mockRejectedValueOnce(new ApiError(0, "network_error", "No connection."));
    // The save of a review fails and keeps trying. The person leaves the review,
    // which sends it once more; that fails too, and it will be tried again later.
    const first = mount(<Review />);
    act(() => autosave.save("e1", { path: path("e1"), body: { name: "Older" } }));
    await pass(600);
    first.unmount();
    await pass(0);
    expect(api.put).toHaveBeenCalledTimes(2);
    // The review is opened again, the row is corrected again, and that save goes through.
    mount(<Review />);
    act(() => autosave.save("e1", { path: path("e1"), body: { name: "Newer" } }));
    await pass(600);
    expect(vi.mocked(api.put).mock.calls.at(-1)).toEqual([path("e1"), sent({ name: "Newer" }), undefined]);
    expect(stored()).toEqual([]);
    const count = vi.mocked(api.put).mock.calls.length;
    // The old review tries again later. Its copy is gone, so it sends nothing.
    await pass(60_000);
    expect(vi.mocked(api.put).mock.calls.map((call) => (call[1] as { name: string }).name))
      .toEqual(["Older", "Older", "Newer"]);
    expect(vi.mocked(api.put).mock.calls).toHaveLength(count);
  });

  it("is sent with the revision its row was built from, and the answer moves that revision on", async () => {
    let confirmFirst!: (answer: unknown) => void;
    vi.mocked(api.put).mockImplementationOnce(() => new Promise((resolve) => { confirmFirst = resolve; }));
    mount(<Review />);
    const revisionOf = (answer: unknown) => (answer as { draft_revision?: number }).draft_revision;
    const draft = (name: string) => ({ path: path("e1"), body: { name }, revisionOf });
    // The row on screen was built from revision 3 of its draft on the server.
    act(() => autosave.track("e1", 3));
    act(() => autosave.save("e1", draft("Step")));
    expect(readLocalReviewDraft(me, review, "e1")).toEqual(expect.objectContaining({ baseRevision: 3, conflict: false }));
    await pass(600);
    expect(vi.mocked(api.put).mock.calls.at(-1)).toEqual([path("e1"), sent({ name: "Step" }, 3), undefined]);
    // A newer correction while the first is on its way. It was made on the same row.
    act(() => autosave.save("e1", draft("Step ladder")));
    expect(readLocalReviewDraft(me, review, "e1")).toEqual(
      expect.objectContaining({ body: { name: "Step ladder" }, baseRevision: 3 }),
    );
    // The server kept the first as revision 4. The copy that still waits was made
    // on top of it, and is sent with that revision.
    confirmFirst({ draft_revision: 4 });
    await pass(0);
    expect(readLocalReviewDraft(me, review, "e1")).toEqual(
      expect.objectContaining({ body: { name: "Step ladder" }, baseRevision: 4 }),
    );
    vi.mocked(api.put).mockResolvedValueOnce({ draft_revision: 5 });
    await pass(600);
    expect(vi.mocked(api.put).mock.calls.at(-1)).toEqual([path("e1"), sent({ name: "Step ladder" }, 4), undefined]);
    expect(stored()).toEqual([]);
    // A row that is built again from the server starts from the revision it has there.
    act(() => autosave.track("e1", 9, false));
    act(() => autosave.save("e1", draft("Tall ladder")));
    expect(readLocalReviewDraft(me, review, "e1")!.baseRevision).toBe(5);
    act(() => autosave.track("e1", 9));
    act(() => autosave.save("e1", draft("Tall ladder")));
    expect(readLocalReviewDraft(me, review, "e1")!.baseRevision).toBe(9);
  });

  it("is not seen by another user or in another household, and sign-out removes every copy", async () => {
    mount(<Review />);
    act(() => autosave.save("e1", { path: path("e1"), body: { name: "Step ladder" } }));
    expect(stored()).toHaveLength(1);
    expect(stored({ ...me, userId: "user-2" })).toEqual([]);
    expect(stored({ ...me, householdId: "house-2" })).toEqual([]);
    expect(stored(me, { kind: "import", id: "batch-2" })).toEqual([]);
    write({ ...me, userId: "user-2" }, review, "e9", { path: path("e9"), body: {} });

    // Signing out removes the copies of every account on this device.
    clearAllItemDrafts();
    expect(stored()).toEqual([]);
    expect(stored({ ...me, userId: "user-2" })).toEqual([]);
    // A request that still waited does not write a copy back when it is answered.
    await pass(600);
    expect(Object.keys(localStorage).filter((key) => key.startsWith("housetory:review-draft"))).toEqual([]);
  });

  it("does not break saving when storage is full or not available", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    try {
      mount(<Review />);
      expect(autosave.recovered.size).toBe(0);
      act(() => autosave.save("e1", { path: path("e1"), body: { name: "Step ladder" } }));
      await pass(600);
      expect(api.put).toHaveBeenCalledWith(path("e1"), sent({ name: "Step ladder" }), undefined);
    } finally {
      setItem.mockRestore();
      getItem.mockRestore();
    }
  });

  it("drops copies that are too old, cannot be read, or name another address, for every account", () => {
    const now = Date.now();
    const someone = { userId: "user-2", householdId: "house-9" };
    write(me, review, "old", { path: path("old"), body: {} }, now - REVIEW_DRAFT_MAX_AGE_MS - 1);
    write(me, review, "new", { path: path("new"), body: {} }, now);
    // Copies of a person whose session ended here and who never signs in again.
    write(someone, review, "old", { path: path("old"), body: {} }, now - REVIEW_DRAFT_MAX_AGE_MS - 1);
    write(someone, review, "new", { path: path("new"), body: {} }, now);
    localStorage.setItem(reviewDraftKey(me, review, "broken"), "{not json");
    localStorage.setItem(reviewDraftKey(someone, review, "broken"), "{not json");
    localStorage.setItem(reviewDraftKey(me, review, "elsewhere"), JSON.stringify({ path: "/items/1", body: {}, at: now, baseRevision: 0 }));
    // A copy without the revision it was made on cannot be checked by the server.
    localStorage.setItem(reviewDraftKey(me, review, "unchecked"), JSON.stringify({ path: path("unchecked"), body: {}, at: now }));
    // Copies in the older form are removed, for every account.
    localStorage.setItem("housetory:review-draft:v1:user-1:house-1:import:batch-1:e1",
      JSON.stringify({ path: path("e1"), body: { name: "Old form" }, at: now, base: null, sent: [] }));
    localStorage.setItem("housetory:review-draft:v1:user-2:house-9:import:batch-1:e1",
      JSON.stringify({ path: path("e1"), body: { name: "Old form" }, at: now, base: null, sent: [] }));
    expect(stored().map((draft) => draft.row)).toEqual(["new"]);
    expect(Object.keys(localStorage).filter((key) => key.startsWith("housetory:review-draft")).sort()).toEqual(
      [reviewDraftKey(me, review, "new"), reviewDraftKey(someone, review, "new")].sort(),
    );
    // A copy is removed by its time only when it is still that copy.
    removeLocalReviewDraft(me, review, "new", now - 1);
    expect(stored()).toHaveLength(1);
    removeLocalReviewDraft(me, review, "new", now);
    expect(stored()).toEqual([]);
  });
});

describe("sending copies of earlier visits again", () => {
  const other: ReviewRef = { kind: "document", id: "doc-1" };
  const headerPath = "/documents/doc-1/extraction/draft";

  it("sends them when the app starts, removes the confirmed ones and forgets the loaded review", async () => {
    write(me, review, "e1", { path: path("e1"), body: { name: "Step ladder" } });
    write(me, other, "header", { path: headerPath, body: { version: "v1", draft: { merchant: "Shop" } } });
    write({ ...me, userId: "user-2" }, review, "e2", { path: path("e2"), body: {} });
    const { client } = mount(<Replay />);
    // The import was loaded earlier in this visit, without the correction.
    client.setQueryData(queryKeys.importBatch("batch-1"), { loaded: "before" });
    client.setQueryData(queryKeys.importBatch("batch-2"), { loaded: "before" });
    await pass(0);
    // Plain requests: nothing is added or applied by sending a draft again.
    expect(vi.mocked(api.put).mock.calls).toEqual([
      [path("e1"), sent({ name: "Step ladder" })],
      [headerPath, sent({ version: "v1", draft: { merchant: "Shop" } })],
    ]);
    expect(stored(me, undefined)).toEqual([]);
    // That import is read again when it is opened, so that it shows the correction.
    expect(client.getQueryData(queryKeys.importBatch("batch-1"))).toBeUndefined();
    expect(client.getQueryData(queryKeys.importBatch("batch-2"))).toEqual({ loaded: "before" });
    // The copy of the other user is not sent and not touched.
    expect(stored({ ...me, userId: "user-2" }, undefined)).toHaveLength(1);
  });

  it("keeps a copy that could not be sent, tries again, and again when the connection returns", async () => {
    write(me, review, "e1", { path: path("e1"), body: { name: "Step ladder" } });
    vi.mocked(api.put).mockRejectedValue(new ApiError(503, "request_failed", "Try later."));
    mount(<Replay />);
    await pass(0);
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(stored()).toHaveLength(1);
    await pass(5000);
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(stored()).toHaveLength(1);
    vi.mocked(api.put).mockResolvedValue({});
    act(() => { window.dispatchEvent(new Event("online")); });
    await pass(0);
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(stored()).toEqual([]);
    expect(toast.message).not.toHaveBeenCalled();
  });

  it("keeps the copies when the session ended, drops one the server can never keep and says so once", async () => {
    write(me, review, "e1", { path: path("e1"), body: { name: "" } }, Date.now() - 2000);
    write(me, review, "e2", { path: path("e2"), body: { name: "Rope" } }, Date.now() - 1000);
    write(me, review, "e3", { path: path("e3"), body: { name: "Lamp" } });
    vi.mocked(api.put)
      .mockRejectedValueOnce(new ApiError(422, "validation_error", "Not valid."))
      .mockRejectedValueOnce(new ApiError(401, "not_authenticated", "Sign in."));
    mount(<Replay />);
    await pass(0);
    // After the 401 nothing more is sent. The person gets the copies back after signing in.
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(stored().map((draft) => draft.row)).toEqual(["e2", "e3"]);
    expect(toast.message).toHaveBeenCalledTimes(1);
    expect(toast.message).toHaveBeenCalledWith("A correction from an earlier visit could not be kept. It was removed.");
  });

  it("sends every copy, however old, with the revision it was made on, and lets the server decide", async () => {
    const now = Date.now();
    write(me, review, "old", { path: path("old"), body: { name: "From last week" }, baseRevision: 2 },
      now - 7 * 24 * 60 * 60 * 1000);
    write(me, review, "new", { path: path("new"), body: { name: "From a moment ago" }, baseRevision: 5 }, now - 60_000);
    // Another device corrected the older row since. The server keeps nothing of it.
    vi.mocked(api.put).mockRejectedValueOnce(conflict());
    const { client } = mount(<Replay />);
    client.setQueryData(queryKeys.importBatch("batch-1"), { loaded: "before" });
    await pass(0);
    expect(vi.mocked(api.put).mock.calls).toEqual([
      [path("old"), sent({ name: "From last week" }, 2)],
      [path("new"), sent({ name: "From a moment ago" }, 5)],
    ]);
    // The correction that was refused stays on this device, marked, for the person
    // to choose. The other one is on the server and its copy is gone.
    expect(stored()).toEqual([
      expect.objectContaining({ row: "old", body: { name: "From last week" }, conflict: true }),
    ]);
    // The import is read again when it is opened, so that it shows the server's row.
    expect(client.getQueryData(queryKeys.importBatch("batch-1"))).toBeUndefined();
    // It is never sent again by itself: not later, and not when the connection returns.
    await pass(120_000);
    act(() => { window.dispatchEvent(new Event("online")); });
    await pass(0);
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(toast.message).not.toHaveBeenCalled();
    // The review gets it when it opens, as a conflict.
    mount(<Review />);
    expect([...autosave.conflicts]).toEqual([["old", { path: path("old"), body: { name: "From last week" } }]]);
    expect(autosave.recovered.get("old")).toEqual(expect.objectContaining({ conflict: true }));
  });

  it("reads each copy again just before it is sent, and stops when another household is selected", async () => {
    write(me, review, "e1", { path: path("e1"), body: { name: "One" } }, Date.now() - 3000);
    write(me, review, "e2", { path: path("e2"), body: { name: "Two" } }, Date.now() - 2000);
    write(me, review, "e3", { path: path("e3"), body: { name: "Three" } }, Date.now() - 1000);
    let answer!: () => void;
    vi.mocked(api.put).mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve({}); }));
    const view = mount(<Replay />);
    await pass(0);
    expect(api.put).toHaveBeenCalledTimes(1);
    // While the first is on its way, another tab saves a newer correction of the second row.
    removeLocalReviewDraft(me, review, "e2");
    answer();
    await pass(0);
    // The second is not sent with its old body. The third is.
    expect(vi.mocked(api.put).mock.calls.map((call) => call[0])).toEqual([path("e1"), path("e3")]);

    // A run that is under way stops when the person goes to another household.
    write(me, review, "e4", { path: path("e4"), body: { name: "Four" } }, Date.now() - 2000);
    write(me, review, "e5", { path: path("e5"), body: { name: "Five" } }, Date.now() - 1000);
    vi.mocked(api.put).mockClear();
    vi.mocked(api.put).mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve({}); }));
    act(() => { window.dispatchEvent(new Event("online")); });
    await pass(0);
    expect(vi.mocked(api.put).mock.calls.map((call) => call[0])).toEqual([path("e4")]);
    session = { user: { id: "user-1" }, household: { id: "house-2" } };
    view.rerender(<QueryClientProvider client={view.client}><Replay /></QueryClientProvider>);
    answer();
    await pass(0);
    expect(vi.mocked(api.put).mock.calls.map((call) => call[0])).toEqual([path("e4")]);
    expect(stored().map((draft) => draft.row)).toEqual(["e5"]);
  });

  it("leaves the copies of a review that is on screen to that review, and sends nothing without a session", async () => {
    write(me, review, "e1", { path: path("e1"), body: { name: "Step ladder" } });
    write(me, other, "header", { path: headerPath, body: { version: "v1", draft: null } });
    const view = mount(<><Review /><Replay /></>);
    await pass(0);
    // Only the copy of the review that is not open was sent. The open review has its own.
    expect(vi.mocked(api.put).mock.calls.map((call) => call[0])).toEqual([headerPath]);
    expect([...autosave.recovered.keys()]).toEqual(["e1"]);
    expect(stored()).toHaveLength(1);
    view.unmount();

    vi.mocked(api.put).mockClear();
    session = { user: null, household: null };
    mount(<><Review /><Replay /></>);
    await pass(0);
    expect(api.put).not.toHaveBeenCalled();
    expect(autosave.recovered.size).toBe(0);
    expect(stored()).toHaveLength(1);
  });
});

describe("a row that another device corrected in the meantime", () => {
  const draft = (name: string, more: object = {}) => ({
    path: path("e1"), body: { name },
    revisionOf: (answer: unknown) => (answer as { draft_revision?: number }).draft_revision,
    ...more,
  });

  it("keeps the correction of this device, marks it, tells the review and does not send it again", async () => {
    vi.mocked(api.put).mockRejectedValue(conflict());
    const onConflict = vi.fn();
    const view = mount(<><Review /><Replay /></>);
    act(() => autosave.track("e1", 2));
    act(() => autosave.save("e1", draft("Mine", { onConflict })));
    await pass(600);
    expect(vi.mocked(api.put).mock.calls).toEqual([[path("e1"), sent({ name: "Mine" }, 2), undefined]]);
    // Nothing was stored on the server. The correction is still on this device.
    expect(stored()).toEqual([expect.objectContaining({ row: "e1", body: { name: "Mine" }, conflict: true })]);
    expect([...autosave.conflicts]).toEqual([["e1", { path: path("e1"), body: { name: "Mine" } }]]);
    expect(onConflict).toHaveBeenCalledTimes(1);
    // It is not a save that failed: nothing is tried again, now or when the page is left.
    expect(view.getByText("saved")).toBeTruthy();
    await pass(120_000);
    act(() => autosave.flush());
    act(() => { window.dispatchEvent(new Event("online")); });
    await pass(0);
    view.unmount();
    await pass(0);
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(stored()).toHaveLength(1);
  });

  it("sends the person's own correction on the revision the server has now when they choose it", async () => {
    vi.mocked(api.put).mockRejectedValueOnce(conflict());
    mount(<Review />);
    act(() => autosave.track("e1", 2));
    act(() => autosave.save("e1", draft("Mine")));
    await pass(600);
    expect(autosave.conflicts.has("e1")).toBe(true);
    // The review showed the row as the server has it now: revision 6.
    act(() => autosave.track("e1", 6));
    // "Use mine": the correction is no conflict any more and is saved as usual.
    const mine = autosave.conflicts.get("e1")!;
    vi.mocked(api.put).mockResolvedValueOnce({ draft_revision: 7 });
    act(() => {
      autosave.takeMine("e1");
      autosave.save("e1", draft((mine.body as { name: string }).name));
    });
    expect(autosave.conflicts.size).toBe(0);
    expect(readLocalReviewDraft(me, review, "e1")).toEqual(expect.objectContaining({ conflict: false, baseRevision: 6 }));
    await pass(600);
    expect(vi.mocked(api.put).mock.calls.at(-1)).toEqual([path("e1"), sent({ name: "Mine" }, 6), undefined]);
    expect(stored()).toEqual([]);

    // The server changed again before that arrived: the choice is asked again.
    vi.mocked(api.put).mockRejectedValueOnce(conflict());
    act(() => autosave.save("e1", draft("Mine again")));
    await pass(600);
    expect([...autosave.conflicts.keys()]).toEqual(["e1"]);
    expect(stored()).toEqual([expect.objectContaining({ body: { name: "Mine again" }, conflict: true })]);
  });

  it("removes the correction of this device when the person keeps the other one", async () => {
    vi.mocked(api.put).mockRejectedValueOnce(conflict());
    mount(<Review />);
    act(() => autosave.save("e1", draft("Mine")));
    await pass(600);
    expect(autosave.conflicts.has("e1")).toBe(true);
    // "Keep the other": nothing is sent, and the copy is gone.
    act(() => autosave.forget("e1"));
    expect(autosave.conflicts.size).toBe(0);
    expect(stored()).toEqual([]);
    await pass(60_000);
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it("is not replaced by a later change of the row while the choice waits", async () => {
    vi.mocked(api.put).mockRejectedValueOnce(conflict());
    mount(<Review />);
    act(() => autosave.save("e1", draft("Mine")));
    await pass(600);
    // The row shows what the server has (revision 4). The person changes it there.
    act(() => autosave.track("e1", 4));
    vi.mocked(api.put).mockResolvedValueOnce({ draft_revision: 5 });
    act(() => autosave.save("e1", draft("The other, corrected")));
    await pass(600);
    expect(vi.mocked(api.put).mock.calls.at(-1)).toEqual([path("e1"), sent({ name: "The other, corrected" }, 4), undefined]);
    // The correction that waits for a choice is still the one that was refused.
    expect(stored()).toEqual([expect.objectContaining({ body: { name: "Mine" }, conflict: true })]);
    expect([...autosave.conflicts]).toEqual([["e1", { path: path("e1"), body: { name: "Mine" } }]]);
  });

  it("is marked by the review that finds it when it opens, and is seen by a second view of the review", async () => {
    write(me, review, "e1", { path: path("e1"), body: { name: "Mine" }, baseRevision: 1 });
    mount(<Review />);
    const copy = autosave.recovered.get("e1")!;
    // The server has the revision the copy was made on, or a newer one that this
    // same browser wrote: no conflict. A row that is older than the copy is none either.
    expect(copyConflicts(copy, { revision: 1, writer: "another-device" })).toBe(false);
    expect(copyConflicts(copy, { revision: 3, writer: writerId("user-1") })).toBe(false);
    expect(copyConflicts(copy, { revision: 0, writer: null })).toBe(false);
    // A newer revision from another device, or from no device at all, is a conflict.
    expect(copyConflicts(copy, { revision: 2, writer: "another-device" })).toBe(true);
    expect(copyConflicts(copy, { revision: 2, writer: null })).toBe(true);
    act(() => autosave.markConflict("e1"));
    expect(autosave.conflicts.has("e1")).toBe(true);
    expect(copyConflicts(readLocalReviewDraft(me, review, "e1")!, { revision: 1, writer: writerId("user-1") })).toBe(true);
    await pass(60_000);
    expect(api.put).not.toHaveBeenCalled();
    // Another view of the same review (the assistant) resolves it: this one follows.
    act(() => { markLocalReviewDraftConflict(me, review, "e1", false); });
    expect(autosave.conflicts.size).toBe(0);
  });

  it("is still shown when the correction could not be written to this device", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    try {
      vi.mocked(api.put).mockRejectedValueOnce(conflict());
      mount(<Review />);
      act(() => autosave.save("e1", draft("Mine")));
      await pass(600);
      expect([...autosave.conflicts]).toEqual([["e1", { path: path("e1"), body: { name: "Mine" } }]]);
      act(() => autosave.forget("e1"));
      expect(autosave.conflicts.size).toBe(0);
    } finally {
      setItem.mockRestore();
    }
  });

  it("names this browser once, with a name that stays after sign-out", () => {
    const name = deviceId();
    expect(name).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(deviceId()).toBe(name);
    clearAllItemDrafts();
    expect(deviceId()).toBe(name);
  });

  it("does not take a draft that another person kept on this same browser for one's own", async () => {
    // The writer of a draft is this browser and the person who is signed in.
    const mine = writerId("0b6f6c1e-8f0a-4c1e-9d55-3f2a0c7d9e11");
    const theirs = writerId("7a1d2f3b-5c6e-4d7f-8a9b-0c1d2e3f4a5b");
    for (const writer of [mine, theirs, writerId(null)]) expect(writer).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(mine).not.toBe(theirs);
    expect(writerId("0b6f6c1e-8f0a-4c1e-9d55-3f2a0c7d9e11")).toBe(mine);
    // Person X left a copy here that was made on revision 1. The session ended.
    write(me, review, "e1", { path: path("e1"), body: { name: "From X" }, baseRevision: 1 });
    // Person Y signed in on this browser and corrected the row: revision 2.
    mount(<Review />);
    expect(reviewDraftWriter()).toBe(writerId("user-1"));
    const copy = autosave.recovered.get("e1")!;
    expect(copyConflicts(copy, { revision: 2, writer: writerId("user-2") })).toBe(true);
    // Every request names the person who is signed in, so the server sees it too.
    act(() => autosave.save("e2", { path: path("e2"), body: { name: "Rope" } }));
    await pass(600);
    expect((vi.mocked(api.put).mock.calls.at(-1)![1] as { writer: string }).writer).toBe(writerId("user-1"));
    expect(writerId("user-1")).not.toBe(writerId("user-2"));
  });

  it("goes one revision on after this page skipped the row, and not when another device changed it too", async () => {
    mount(<Review />);
    const draft = (name: string) => ({ path: path("e1"), body: { name } });
    act(() => autosave.track("e1", 2));
    // This page skipped the row: the server kept it as revision 3. Restore brings
    // the same row back, so the next correction is made on revision 3.
    act(() => autosave.trackStep("e1", 3));
    expect(autosave.tracked("e1")).toBe(3);
    act(() => autosave.save("e1", draft("After restore")));
    await pass(600);
    expect(vi.mocked(api.put).mock.calls.at(-1)).toEqual([path("e1"), sent({ name: "After restore" }, 3), undefined]);
    // The server is two revisions on: another device changed the row in between.
    // The revision is not moved, so the next save is asked about by the server.
    act(() => autosave.trackStep("e1", 5));
    expect(autosave.tracked("e1")).toBe(3);
    // A row that this page never built has no revision to move.
    act(() => autosave.trackStep("e9", 1));
    expect(autosave.tracked("e9")).toBeUndefined();

    // A row of this visit is older than the server's when someone else changed it:
    // a draft of another writer, or a skip or loaded suggestions, which have none.
    expect(changedElsewhere({ revision: 0, writer: null }, undefined)).toBe(false);
    expect(changedElsewhere({ revision: 3, writer: null }, undefined)).toBe(true);
    expect(changedElsewhere({ revision: 3, writer: "laptop-0123456789" }, undefined)).toBe(true);
    expect(changedElsewhere({ revision: 3, writer: writerId("user-1") }, undefined)).toBe(false);
    expect(changedElsewhere({ revision: 3, writer: null }, 3)).toBe(false);
    expect(changedElsewhere({ revision: 4, writer: null }, 3)).toBe(true);
    expect(changedElsewhere({ revision: 4, writer: writerId("user-1") }, 3)).toBe(false);
  });
});
