import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import * as store from "@/lib/offline/copy-store";
import {
  BACK_ONLINE_EVENT,
  MAX_COPY_AGE_MS,
  checkConnection,
  disableOfflineCopy,
  enableOfflineCopy,
  getOfflineStatus,
  offlineSessionChanged,
  resetOfflineForTests,
  signOutOffline,
  startOffline,
  syncOfflineCopy,
} from "@/lib/offline/controller";
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
