import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UNAUTHORIZED_EVENT, api } from "@/lib/api";
import * as store from "@/lib/offline/copy-store";
import {
  BACK_ONLINE_EVENT,
  MAX_COPY_AGE_MS,
  checkConnection,
  disableOfflineCopy,
  enableOfflineCopy,
  getOfflineStatus,
  offlineSessionChanged,
  removeOfflineCopyOnSignOut,
  resetOfflineForTests,
  signOutOffline,
  startOffline,
  syncOfflineCopy,
} from "@/lib/offline/controller";
import * as deviceCache from "@/lib/offline/device-cache";
import { TEST_SESSION, testCopy } from "@/lib/offline/test-copy";
import type { ItemSummaryList, OfflineCopy, SessionState } from "@/lib/types";

// The copy itself lives in IndexedDB, which the test browser does not have.
const saved: { copy: OfflineCopy | null } = { copy: null };
vi.mock("@/lib/offline/copy-store", async (original) => ({
  ...(await original<typeof store>()),
  readCopy: vi.fn(() => Promise.resolve(saved.copy)),
  writeCopy: vi.fn((copy: OfflineCopy) => {
    saved.copy = copy;
    return Promise.resolve();
  }),
  deleteCopy: vi.fn(() => {
    saved.copy = null;
    return Promise.resolve();
  }),
}));
vi.mock("@/lib/offline/device-cache", () => ({
  deleteDeviceFiles: vi.fn(() => Promise.resolve()),
  deletePhotos: vi.fn(() => Promise.resolve()),
  photoPlan: vi.fn(() => []),
  saveAppFiles: vi.fn(() => Promise.resolve()),
  savePhotos: vi.fn(() => Promise.resolve()),
}));

const NETWORK_DOWN = () => Promise.reject(new TypeError("Failed to fetch"));
/** What nginx answers for the API while the API behind it is down. */
const BAD_GATEWAY = () =>
  Promise.resolve(
    new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    }),
  );

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

/** A device that already keeps a copy for the signed-in account. */
function deviceWithCopy(copy = testCopy()) {
  saved.copy = copy;
  store.writePreference({ userId: copy.userId, photos: false });
  store.writeCopyInfo({
    userId: copy.userId,
    householdId: copy.householdId,
    householdName: "Ada's Home",
    savedAt: copy.savedAt,
    itemCount: 3,
  });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  saved.copy = null;
  window.localStorage.clear();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("indexedDB", {});
  vi.stubGlobal("caches", {});
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { controller: null, addEventListener: vi.fn() },
  });
});

afterEach(() => {
  resetOfflineForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("without an offline copy", () => {
  it("leaves requests alone: a lost network is an error, as before", async () => {
    stubFetch(NETWORK_DOWN);
    startOffline();
    await expect(api.get("/items")).rejects.toMatchObject({ code: "network_error" });
    expect(getOfflineStatus()).toMatchObject({ enabled: false, online: true, info: null });
  });
});

describe("when the server cannot be reached", () => {
  it("answers reads from the copy and refuses every change", async () => {
    deviceWithCopy();
    const fetchMock = stubFetch(NETWORK_DOWN);
    startOffline();

    const list = await api.get<ItemSummaryList>("/items?sort=name_asc");
    expect(list.items.map((item) => item.name)).toEqual(["Axe", "Cordless drill", "Kettle"]);
    expect(getOfflineStatus().online).toBe(false);
    await expect(api.get<SessionState>("/auth/session")).resolves.toMatchObject({
      authenticated: true,
      household: { name: "Ada's Home" },
    });

    fetchMock.mockClear();
    await expect(api.post("/items", { name: "Lamp" })).rejects.toMatchObject({
      code: "offline_read_only",
    });
    await expect(api.patch("/items/drill", { name: "Drill" })).rejects.toMatchObject({
      code: "offline_read_only",
    });
    await expect(api.delete("/items/drill")).rejects.toMatchObject({ code: "offline_read_only" });
    await expect(api.get("/documents")).rejects.toMatchObject({ code: "offline_unavailable" });
    await expect(api.getBlob("/documents/1/file")).rejects.toMatchObject({
      code: "offline_unavailable",
    });
    // Nothing was sent, and nothing waits to be sent later.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts in the copy at once when the device itself is offline", () => {
    deviceWithCopy();
    stubFetch(NETWORK_DOWN);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    startOffline();
    expect(getOfflineStatus().online).toBe(false);
  });

  it("gives up a request that hangs once the server does not answer a direct question", async () => {
    vi.useFakeTimers();
    deviceWithCopy();
    let healthAnswers = true;
    // The health check answers until the server "goes away"; data requests never return.
    stubFetch((url, init) => {
      if (url.endsWith("/health/live")) {
        return healthAnswers ? Promise.resolve(json({ status: "ok" })) : NETWORK_DOWN();
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    });
    startOffline();
    await vi.advanceTimersByTimeAsync(0);
    expect(getOfflineStatus().online).toBe(true);

    healthAnswers = false;
    const pending = api.get<ItemSummaryList>("/items");
    await vi.advanceTimersByTimeAsync(6000);
    await expect(pending).resolves.toMatchObject({ total: 3 });
    expect(getOfflineStatus().online).toBe(false);
  });

  it("stays with the server when one request fails but the server answers", async () => {
    // Something on the device blocks a request. That is not "offline".
    deviceWithCopy();
    stubFetch((url) => (url.endsWith("/health/live") ? Promise.resolve(json({})) : NETWORK_DOWN()));
    startOffline();
    await expect(api.get("/items")).rejects.toMatchObject({ code: "network_error" });
    await expect(api.post("/items", { name: "Lamp" })).rejects.toMatchObject({
      code: "network_error",
    });
    expect(getOfflineStatus().online).toBe(true);
  });

  it("does not answer a failed change from the copy, and keeps the caller's error", async () => {
    deviceWithCopy();
    stubFetch(NETWORK_DOWN);
    startOffline();
    // The first change finds out that the server is gone; it fails as it always did.
    await expect(api.post("/items", { name: "Lamp" })).rejects.toMatchObject({
      code: "network_error",
    });
    expect(getOfflineStatus().online).toBe(false);
  });
});

describe("when the proxy in front of the API says the API is not there", () => {
  it("answers reads from the copy, refuses changes, and comes back", async () => {
    deviceWithCopy();
    let apiDown = false;
    stubFetch((url) => {
      if (apiDown) return BAD_GATEWAY();
      return Promise.resolve(
        url.endsWith("/items") ? json({ items: [], total: 0, limit: 30, offset: 0 }) : json({}),
      );
    });
    startOffline();
    await expect(checkConnection()).resolves.toBe(true);

    // The API stops while the app is open. nginx itself still answers.
    apiDown = true;
    const list = await api.get<ItemSummaryList>("/items?sort=name_asc");
    expect(list.items.map((item) => item.name)).toEqual(["Axe", "Cordless drill", "Kettle"]);
    expect(getOfflineStatus().online).toBe(false);
    await expect(api.get<SessionState>("/auth/session")).resolves.toMatchObject({
      authenticated: true,
    });
    await expect(api.post("/items", { name: "Lamp" })).rejects.toMatchObject({
      code: "offline_read_only",
    });

    apiDown = false;
    await expect(checkConnection()).resolves.toBe(true);
    await expect(api.get<ItemSummaryList>("/items")).resolves.toMatchObject({ total: 0 });
  });

  it("does not answer a change from the copy, and keeps the 502 for the caller", async () => {
    deviceWithCopy();
    let apiDown = false;
    stubFetch(() => (apiDown ? BAD_GATEWAY() : Promise.resolve(json({}))));
    startOffline();
    await checkConnection();
    apiDown = true;
    await expect(api.post("/items", { name: "Lamp" })).rejects.toMatchObject({ status: 502 });
    expect(getOfflineStatus().online).toBe(false);
  });

  it("stays with the server when one request meets 502 but the server answers", async () => {
    // The API sends 502 itself when a service it asks is down (the manual search).
    deviceWithCopy();
    stubFetch((url) =>
      Promise.resolve(
        url.endsWith("/health/live")
          ? json({ status: "ok" })
          : json({ detail: { code: "manual_search_unavailable" } }, { status: 502 }),
      ),
    );
    startOffline();
    await expect(api.get("/items")).rejects.toMatchObject({
      status: 502,
      code: "manual_search_unavailable",
    });
    expect(getOfflineStatus().online).toBe(true);
  });

  it.each([
    [401, "unauthenticated"],
    [403, "forbidden"],
    [404, "not_found"],
    [500, "internal_error"],
  ])("leaves a %i answer as it was: the server is there", async (status, code) => {
    deviceWithCopy();
    const fetchMock = stubFetch((url) =>
      Promise.resolve(
        url.endsWith("/health/live") ? json({ status: "ok" }) : json({ detail: { code } }, { status }),
      ),
    );
    startOffline();
    await checkConnection();
    fetchMock.mockClear();
    const unauthorized = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    await expect(api.get("/items")).rejects.toMatchObject({ status, code });
    window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);

    expect(unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    expect(getOfflineStatus().online).toBe(true);
    // The copy was not asked, and the server was not asked a second time.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("without a copy a 502 is the error it always was", async () => {
    const fetchMock = stubFetch(BAD_GATEWAY);
    startOffline();
    await expect(api.get("/items")).rejects.toMatchObject({ status: 502, code: "request_failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("when the server is back", () => {
  it("returns to the server, says so once, and brings the copy up to date", async () => {
    deviceWithCopy();
    let down = true;
    const fresh = testCopy().snapshot;
    fresh.items = fresh.items.filter((item) => item.id !== "axe");
    const fetchMock = stubFetch((url) => {
      if (down) return NETWORK_DOWN();
      if (url.endsWith("/offline/snapshot")) return Promise.resolve(json(fresh, { headers: { ETag: '"v2"' } }));
      return Promise.resolve(json({ items: [], total: 0, limit: 30, offset: 0 }));
    });
    startOffline();
    await api.get("/items");
    expect(getOfflineStatus().online).toBe(false);

    const backOnline = vi.fn();
    window.addEventListener(BACK_ONLINE_EVENT, backOnline);
    down = false;
    await expect(checkConnection()).resolves.toBe(true);
    window.removeEventListener(BACK_ONLINE_EVENT, backOnline);
    expect(backOnline).toHaveBeenCalledTimes(1);
    expect(getOfflineStatus().online).toBe(true);

    // Requests reach the server again, and the session it reports refreshes the copy.
    await expect(api.get<ItemSummaryList>("/items")).resolves.toMatchObject({ total: 0 });
    offlineSessionChanged(TEST_SESSION);
    await syncOfflineCopy();
    expect(saved.copy?.etag).toBe('"v2"');
    expect(getOfflineStatus().info?.itemCount).toBe(2);
    const snapshotCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/offline/snapshot"));
    expect(new Headers(snapshotCall?.[1]?.headers).get("If-None-Match")).toBe('"v1"');
  });
});

describe("who may have a copy on this device", () => {
  const signedOut: SessionState = {
    authenticated: false,
    setup_required: false,
    user: null,
    household: null,
    role: null,
  };

  it.each([
    ["the session ended", signedOut],
    ["another account signed in", { ...TEST_SESSION, user: { ...TEST_SESSION.user!, id: "user-2" } }],
    ["the household no longer allows it", { ...TEST_SESSION, offline_copy_allowed: false }],
  ])("removes the copy when %s", async (_name, state) => {
    deviceWithCopy();
    stubFetch(() => Promise.resolve(json({})));
    startOffline();
    offlineSessionChanged(state);
    await vi.waitFor(() => expect(saved.copy).toBeNull());
    expect(getOfflineStatus().info).toBeNull();
    expect(store.readCopyInfo()).toBeNull();
  });

  it("removes the copy when the server refuses a new one", async () => {
    deviceWithCopy();
    stubFetch((url) =>
      Promise.resolve(
        url.endsWith("/offline/snapshot")
          ? json({ detail: { code: "offline_copy_not_allowed" } }, { status: 403 })
          : json({}),
      ),
    );
    startOffline();
    offlineSessionChanged({ ...TEST_SESSION });
    await syncOfflineCopy();
    await syncOfflineCopy();
    expect(saved.copy).toBeNull();
    expect(getOfflineStatus()).toMatchObject({ allowed: false, info: null });
  });

  describe("after a switch to another household", () => {
    const cabin = { ...TEST_SESSION.household!, id: "household-2", name: "Cabin" };
    const inCabin: SessionState = { ...TEST_SESSION, household: cabin };
    const cabinSnapshot = { ...testCopy().snapshot, household: cabin };

    it.each([
      ["the server fails", () => Promise.resolve(json({ detail: { code: "internal_error" } }, { status: 500 }))],
      ["the request is lost", NETWORK_DOWN],
    ])("removes the copy of the household that was left, also when %s", async (_name, failure) => {
      deviceWithCopy();
      let snapshotWorks = false;
      stubFetch((url) => {
        if (!url.endsWith("/offline/snapshot")) return Promise.resolve(json({ status: "ok" }));
        return snapshotWorks
          ? Promise.resolve(json(cabinSnapshot, { headers: { ETag: '"cabin-1"' } }))
          : failure();
      });
      startOffline();
      await checkConnection();
      vi.mocked(deviceCache.deleteDeviceFiles).mockClear();

      // The server confirmed the switch. The new copy cannot be downloaded.
      offlineSessionChanged(inCabin);
      await syncOfflineCopy();
      await vi.waitFor(() => expect(getOfflineStatus().syncing).toBe(false));
      expect(saved.copy).toBeNull();
      expect(store.readCopyInfo()).toBeNull();
      expect(getOfflineStatus()).toMatchObject({ enabled: true, info: null, online: true });
      expect(getOfflineStatus().syncError).toBeTruthy();
      // The small photos of the old household go too.
      expect(deviceCache.deleteDeviceFiles).toHaveBeenCalled();

      // Nothing of the old household is shown when the server goes away now.
      vi.stubGlobal("fetch", vi.fn(NETWORK_DOWN));
      await expect(api.get("/items")).rejects.toMatchObject({ code: "network_error" });
      expect(getOfflineStatus().online).toBe(true);

      // The choice stays: the next contact saves the new household.
      stubFetch((url) =>
        Promise.resolve(
          url.endsWith("/offline/snapshot")
            ? json(cabinSnapshot, { headers: { ETag: '"cabin-1"' } })
            : json({ status: "ok" }),
        ),
      );
      snapshotWorks = true;
      offlineSessionChanged(inCabin);
      await vi.waitFor(() => expect(saved.copy?.householdId).toBe("household-2"));
      expect(getOfflineStatus().info).toMatchObject({ householdId: "household-2", householdName: "Cabin" });
    });

    it("saves the new household when the download works, with nothing of the old one left", async () => {
      deviceWithCopy();
      const fetchMock = stubFetch((url) =>
        Promise.resolve(
          url.endsWith("/offline/snapshot")
            ? json(cabinSnapshot, { headers: { ETag: '"cabin-1"' } })
            : json({ status: "ok" }),
        ),
      );
      startOffline();
      await checkConnection();
      offlineSessionChanged(inCabin);
      await vi.waitFor(() => expect(saved.copy?.householdId).toBe("household-2"));
      expect(store.readCopyInfo()).toMatchObject({ householdId: "household-2" });
      // The old copy's version is not offered for a household it does not belong to.
      const snapshotCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/offline/snapshot"));
      expect(new Headers(snapshotCall?.[1]?.headers).get("If-None-Match")).toBeNull();
    });
  });

  it("removes a copy that had no contact with the server for 30 days", async () => {
    deviceWithCopy(testCopy({ savedAt: Date.now() - MAX_COPY_AGE_MS - 1000 }));
    stubFetch(NETWORK_DOWN);
    startOffline();
    await vi.waitFor(() => expect(saved.copy).toBeNull());
    // With no copy there is nothing to show: the request fails as it would without one.
    await expect(api.get("/items")).rejects.toMatchObject({ code: "network_error" });
  });

  it("keeps nothing until the account turns it on, and removes it when turned off", async () => {
    const fetchMock = stubFetch((url) =>
      Promise.resolve(url.endsWith("/offline/snapshot") ? json(testCopy().snapshot) : json({})),
    );
    startOffline();
    offlineSessionChanged(TEST_SESSION);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved.copy).toBeNull();

    await enableOfflineCopy(false);
    expect(saved.copy?.householdId).toBe("household-1");
    expect(getOfflineStatus()).toMatchObject({ enabled: true, info: { itemCount: 3 } });

    await disableOfflineCopy();
    expect(saved.copy).toBeNull();
    expect(store.readPreference()).toBeNull();
    expect(getOfflineStatus()).toMatchObject({ enabled: false, info: null });
  });
});

describe("sign-out without the server", () => {
  it("removes the copy now and ends the session at the next contact", async () => {
    deviceWithCopy();
    let down = true;
    const fetchMock = stubFetch((url) => {
      if (down) return NETWORK_DOWN();
      return Promise.resolve(url.endsWith("/auth/logout") ? new Response(null, { status: 204 }) : json({ authenticated: false }));
    });
    startOffline();
    await api.get("/items");

    await signOutOffline();
    expect(saved.copy).toBeNull();
    expect(store.signOutPending()).toBe(true);

    down = false;
    fetchMock.mockClear();
    await api.get("/auth/session");
    expect(fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method ?? "GET"])).toEqual([
      ["/api/v1/auth/logout", "POST"],
      ["/api/v1/auth/session", "GET"],
    ]);
    expect(store.signOutPending()).toBe(false);
  });
});

describe("sign-out while the copy is being refreshed", () => {
  const fresh = () => {
    const snapshot = testCopy().snapshot;
    snapshot.items = snapshot.items.filter((item) => item.id !== "axe");
    return snapshot;
  };

  /** Checks that nothing of the account is left, on the device or in the running app. */
  async function expectNothingLeft() {
    expect(saved.copy).toBeNull();
    expect(store.readCopyInfo()).toBeNull();
    expect(getOfflineStatus()).toMatchObject({ info: null, syncing: false, photoProgress: null });
    // Without the server the signed-out app has nothing to answer with.
    vi.stubGlobal("fetch", vi.fn(NETWORK_DOWN));
    await expect(api.get("/auth/session")).rejects.toMatchObject({ code: "network_error" });
    await expect(api.get("/items")).rejects.toMatchObject({ code: "network_error" });
    expect(getOfflineStatus().online).toBe(true);
  }

  it("does not bring the copy back when the download ends after the sign-out", async () => {
    deviceWithCopy();
    let answerSnapshot: (response: Response) => void = () => undefined;
    // A download that does not stop when it is told to (the answer is already on its way).
    stubFetch((url) =>
      url.endsWith("/offline/snapshot")
        ? new Promise<Response>((resolve) => {
            answerSnapshot = resolve;
          })
        : Promise.resolve(json({ status: "ok" })),
    );
    startOffline();
    await checkConnection();
    offlineSessionChanged(TEST_SESSION);
    const refresh = syncOfflineCopy();
    await vi.waitFor(() => expect(answerSnapshot).not.toHaveLength(0));

    await removeOfflineCopyOnSignOut();
    answerSnapshot(json(fresh(), { headers: { ETag: '"v2"' } }));
    await refresh;
    await expectNothingLeft();
  });

  it("does not bring the copy back when the sign-out comes while the new copy is written", async () => {
    deviceWithCopy();
    stubFetch((url) =>
      Promise.resolve(
        url.endsWith("/offline/snapshot")
          ? json(fresh(), { headers: { ETag: '"v2"' } })
          : json({ status: "ok" }),
      ),
    );
    let finishWrite: (() => void) | null = null;
    vi.mocked(store.writeCopy).mockImplementationOnce(
      (copy) =>
        new Promise<void>((resolve) => {
          // The write was asked for before the sign-out and lands after it.
          finishWrite = () => {
            saved.copy = copy;
            resolve();
          };
        }),
    );
    startOffline();
    await checkConnection();
    offlineSessionChanged(TEST_SESSION);
    const refresh = syncOfflineCopy();
    await vi.waitFor(() => expect(finishWrite).not.toBeNull());
    vi.mocked(deviceCache.saveAppFiles).mockClear();
    vi.mocked(deviceCache.savePhotos).mockClear();

    await removeOfflineCopyOnSignOut();
    finishWrite!();
    await refresh;
    await vi.waitFor(() => expect(saved.copy).toBeNull());
    await expectNothingLeft();
    // And no files of the app or photos are saved for an account that left.
    expect(deviceCache.saveAppFiles).not.toHaveBeenCalled();
    expect(deviceCache.savePhotos).not.toHaveBeenCalled();
  });

  it("does not answer a waiting read from the copy after a sign-out without the server", async () => {
    deviceWithCopy();
    stubFetch(NETWORK_DOWN);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    let finishRead: (() => void) | null = null;
    vi.mocked(store.readCopy).mockImplementationOnce(() => {
      const copy = saved.copy;
      return new Promise((resolve) => {
        finishRead = () => resolve(copy);
      });
    });
    startOffline();
    expect(getOfflineStatus().online).toBe(false);

    // The first read has to fetch the copy from the device's storage.
    const waiting = api.get("/items");
    await vi.waitFor(() => expect(finishRead).not.toBeNull());
    await signOutOffline();
    finishRead!();
    await expect(waiting).rejects.toMatchObject({ code: "network_error" });
    expect(saved.copy).toBeNull();
    expect(getOfflineStatus().info).toBeNull();
  });
});
