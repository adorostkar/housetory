import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { clearAllItemDrafts } from "@/lib/item-drafts";
import { queryKeys } from "@/lib/queries";
import {
  REVIEW_DRAFT_BLIND_REPLAY_MS,
  REVIEW_DRAFT_MAX_AGE_MS,
  readLocalReviewDraft,
  readLocalReviewDrafts,
  removeLocalReviewDraft,
  reviewDraftKey,
  writeLocalReviewDraft,
  type ReviewRef,
} from "@/lib/review-draft-store";
import { useDraftAutosave, useReplayLocalReviewDrafts } from "@/lib/review-drafts";

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
    const key = "housetory:review-draft:v1:user-1:house-1:import:batch-1:e1";
    expect(reviewDraftKey(me, review, "e1")).toBe(key);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      path: path("e1"), body: { name: "Step ladder" }, at: expect.any(Number), base: null, sent: [],
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
    expect(vi.mocked(api.put).mock.calls.at(-1)).toEqual([path("e1"), { name: "Newer" }, undefined]);
    expect(stored()).toEqual([]);
    const sent = vi.mocked(api.put).mock.calls.length;
    // The old review tries again later. Its copy is gone, so it sends nothing.
    await pass(60_000);
    expect(vi.mocked(api.put).mock.calls.map((call) => (call[1] as { name: string }).name))
      .toEqual(["Older", "Older", "Newer"]);
    expect(vi.mocked(api.put).mock.calls).toHaveLength(sent);
  });

  it("keeps what the server had with the copy, and moves it on when the server confirms an older draft", async () => {
    let confirmFirst!: (answer: unknown) => void;
    vi.mocked(api.put).mockImplementationOnce(() => new Promise((resolve) => { confirmFirst = resolve; }));
    mount(<Review />);
    const rebase = (answer: unknown) => ({ server: (answer as { name: string }).name });
    act(() => autosave.save("e1", { path: path("e1"), body: { name: "Step" }, base: { server: "Ladder" }, rebase }));
    expect(readLocalReviewDraft(me, review, "e1")).toEqual(expect.objectContaining({ base: { server: "Ladder" } }));
    await pass(600);
    // A newer correction while the first is on its way. The copy lives on, so its
    // base is still what the server had before both.
    act(() => autosave.save("e1", { path: path("e1"), body: { name: "Step ladder" }, base: { server: "Other" }, rebase }));
    expect(readLocalReviewDraft(me, review, "e1")).toEqual(
      expect.objectContaining({ body: { name: "Step ladder" }, base: { server: "Ladder" } }),
    );
    // The server confirms the first. The copy that still waits now starts from that.
    confirmFirst({ name: "Step" });
    await pass(0);
    expect(readLocalReviewDraft(me, review, "e1")).toEqual(
      expect.objectContaining({ body: { name: "Step ladder" }, base: { server: "Step" } }),
    );
  });

  it("remembers the drafts that were sent without an answer, and forgets them when the answer comes", async () => {
    let confirmFirst!: (answer: unknown) => void;
    vi.mocked(api.put)
      .mockImplementationOnce(() => new Promise((resolve) => { confirmFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(() => undefined));
    mount(<Review />);
    const rebase = (answer: unknown) => ({ server: (answer as { name: string }).name });
    const draft = (name: string) => ({ path: path("e1"), body: { name }, base: { server: "Ladder" }, rebase });
    act(() => autosave.save("e1", draft("Step")));
    expect(readLocalReviewDraft(me, review, "e1")!.sent).toEqual([]);
    await pass(600);
    // The request is on its way. The server may have it, also if no answer ever comes.
    expect(readLocalReviewDraft(me, review, "e1")!.sent).toEqual([{ name: "Step" }]);
    // A newer correction keeps that knowledge with the copy.
    act(() => autosave.save("e1", draft("Step ladder")));
    expect(readLocalReviewDraft(me, review, "e1")).toEqual(expect.objectContaining({
      body: { name: "Step ladder" }, base: { server: "Ladder" }, sent: [{ name: "Step" }],
    }));
    // The answer comes: the copy starts from it, and that draft is no open question.
    confirmFirst({ name: "Step" });
    await pass(0);
    expect(readLocalReviewDraft(me, review, "e1")).toEqual(expect.objectContaining({
      base: { server: "Step" }, sent: [],
    }));
    await pass(600);
    expect(readLocalReviewDraft(me, review, "e1")!.sent).toEqual([{ name: "Step ladder" }]);
  });

  it("is not seen by another user or in another household, and sign-out removes every copy", async () => {
    mount(<Review />);
    act(() => autosave.save("e1", { path: path("e1"), body: { name: "Step ladder" } }));
    expect(stored()).toHaveLength(1);
    expect(stored({ ...me, userId: "user-2" })).toEqual([]);
    expect(stored({ ...me, householdId: "house-2" })).toEqual([]);
    expect(stored(me, { kind: "import", id: "batch-2" })).toEqual([]);
    writeLocalReviewDraft({ ...me, userId: "user-2" }, review, "e9", { path: path("e9"), body: {} });

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
      expect(api.put).toHaveBeenCalledWith(path("e1"), { name: "Step ladder" }, undefined);
    } finally {
      setItem.mockRestore();
      getItem.mockRestore();
    }
  });

  it("drops copies that are too old, cannot be read, or name another address, for every account", () => {
    const now = Date.now();
    const someone = { userId: "user-2", householdId: "house-9" };
    writeLocalReviewDraft(me, review, "old", { path: path("old"), body: {} }, now - REVIEW_DRAFT_MAX_AGE_MS - 1);
    writeLocalReviewDraft(me, review, "new", { path: path("new"), body: {} }, now);
    // Copies of a person whose session ended here and who never signs in again.
    writeLocalReviewDraft(someone, review, "old", { path: path("old"), body: {} }, now - REVIEW_DRAFT_MAX_AGE_MS - 1);
    writeLocalReviewDraft(someone, review, "new", { path: path("new"), body: {} }, now);
    localStorage.setItem(reviewDraftKey(me, review, "broken"), "{not json");
    localStorage.setItem(reviewDraftKey(someone, review, "broken"), "{not json");
    localStorage.setItem(reviewDraftKey(me, review, "elsewhere"), JSON.stringify({ path: "/items/1", body: {}, at: now, base: null }));
    expect(stored().map((draft) => draft.row)).toEqual(["new"]);
    expect(Object.keys(localStorage).sort()).toEqual(
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
    writeLocalReviewDraft(me, review, "e1", { path: path("e1"), body: { name: "Step ladder" } });
    writeLocalReviewDraft(me, other, "header", { path: headerPath, body: { version: "v1", draft: { merchant: "Shop" } } });
    writeLocalReviewDraft({ ...me, userId: "user-2" }, review, "e2", { path: path("e2"), body: {} });
    const { client } = mount(<Replay />);
    // The import was loaded earlier in this visit, without the correction.
    client.setQueryData(queryKeys.importBatch("batch-1"), { loaded: "before" });
    client.setQueryData(queryKeys.importBatch("batch-2"), { loaded: "before" });
    await pass(0);
    // Plain requests: nothing is added or applied by sending a draft again.
    expect(vi.mocked(api.put).mock.calls).toEqual([
      [path("e1"), { name: "Step ladder" }],
      [headerPath, { version: "v1", draft: { merchant: "Shop" } }],
    ]);
    expect(stored(me, undefined)).toEqual([]);
    // That import is read again when it is opened, so that it shows the correction.
    expect(client.getQueryData(queryKeys.importBatch("batch-1"))).toBeUndefined();
    expect(client.getQueryData(queryKeys.importBatch("batch-2"))).toEqual({ loaded: "before" });
    // The copy of the other user is not sent and not touched.
    expect(stored({ ...me, userId: "user-2" }, undefined)).toHaveLength(1);
  });

  it("keeps a copy that could not be sent, tries again, and again when the connection returns", async () => {
    writeLocalReviewDraft(me, review, "e1", { path: path("e1"), body: { name: "Step ladder" } });
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
    writeLocalReviewDraft(me, review, "e1", { path: path("e1"), body: { name: "" } }, Date.now() - 2000);
    writeLocalReviewDraft(me, review, "e2", { path: path("e2"), body: { name: "Rope" } }, Date.now() - 1000);
    writeLocalReviewDraft(me, review, "e3", { path: path("e3"), body: { name: "Lamp" } });
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

  it("sends only a copy of the last ten minutes without its review, and keeps an older one for the review", async () => {
    const now = Date.now();
    writeLocalReviewDraft(me, review, "old", { path: path("old"), body: { name: "From yesterday" } },
      now - REVIEW_DRAFT_BLIND_REPLAY_MS - 1000);
    writeLocalReviewDraft(me, review, "new", { path: path("new"), body: { name: "From a moment ago" } }, now - 60_000);
    mount(<Replay />);
    await pass(0);
    // There is no row to compare with here. Another device may have corrected the
    // older row since, so it waits until its review opens and looks at the server.
    expect(vi.mocked(api.put).mock.calls).toEqual([[path("new"), { name: "From a moment ago" }]]);
    expect(stored().map((draft) => draft.row)).toEqual(["old"]);
    await pass(60_000);
    expect(api.put).toHaveBeenCalledTimes(1);
    // The review still gets it when it opens.
    mount(<Review />);
    expect([...autosave.recovered.keys()]).toEqual(["old"]);
  });

  it("reads each copy again just before it is sent, and stops when another household is selected", async () => {
    writeLocalReviewDraft(me, review, "e1", { path: path("e1"), body: { name: "One" } }, Date.now() - 3000);
    writeLocalReviewDraft(me, review, "e2", { path: path("e2"), body: { name: "Two" } }, Date.now() - 2000);
    writeLocalReviewDraft(me, review, "e3", { path: path("e3"), body: { name: "Three" } }, Date.now() - 1000);
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
    writeLocalReviewDraft(me, review, "e4", { path: path("e4"), body: { name: "Four" } }, Date.now() - 2000);
    writeLocalReviewDraft(me, review, "e5", { path: path("e5"), body: { name: "Five" } }, Date.now() - 1000);
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
    writeLocalReviewDraft(me, review, "e1", { path: path("e1"), body: { name: "Step ladder" } });
    writeLocalReviewDraft(me, other, "header", { path: headerPath, body: { version: "v1", draft: null } });
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
