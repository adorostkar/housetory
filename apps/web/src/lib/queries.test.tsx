import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  useCaptureReviews, useDocuments, useInvalidateInventory, useItemHistory, useItems, usePendingActions,
} from "@/lib/queries";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const fetch = vi.fn(async (_url: string, _options?: RequestInit) => new Response(
    JSON.stringify({ items: [], total: 0, limit: 24, offset: 0 }),
    { headers: { "Content-Type": "application/json" } },
  ));
  vi.stubGlobal("fetch", fetch);
  return { client, wrapper, fetch };
}

describe("inventory requests", () => {
  it("requests lightweight item and document lists", async () => {
    const { client, wrapper, fetch } = setup();
    const hook = renderHook(() => ({ items: useItems({}), documents: useDocuments() }), { wrapper });
    await waitFor(() => expect(hook.result.current.items.isSuccess).toBe(true));
    await waitFor(() => expect(hook.result.current.documents.isSuccess).toBe(true));
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/items\?.*representation=summary/),
        expect.stringMatching(/\/documents\?.*representation=summary/),
      ]),
    );
    hook.unmount();
    client.clear();
  });

  it("does not request history until its tab needs it", async () => {
    const { client, wrapper, fetch } = setup();
    const hook = renderHook(({ enabled }) => useItemHistory("item-1", enabled), {
      wrapper, initialProps: { enabled: false },
    });
    expect(fetch).not.toHaveBeenCalled();
    hook.rerender({ enabled: true });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    hook.unmount();
    client.clear();
  });

  it("aborts an abandoned item-list request", async () => {
    const { client, wrapper } = setup();
    let observedRequest: RequestInit = {};
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        observedRequest = options;
        options.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
      }),
    ));
    const hook = renderHook(() => useItems({ q: "drill" }), { wrapper });
    await waitFor(() => expect(observedRequest.signal).toBeDefined());
    hook.unmount();
    expect(observedRequest.signal?.aborted).toBe(true);
    client.clear();
  });

  it("deduplicates targeted invalidation and leaves unrelated caches alone", () => {
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const hook = renderHook(() => useInvalidateInventory(["items", "items", "documents"]), { wrapper });
    act(() => hook.result.current());
    expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([
      ["items"], ["documents"],
    ]);
    hook.unmount();
    client.clear();
  });
});

describe("app-wide status polling", () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  /** Renders the two app-wide status queries and counts their requests over a period. */
  async function poll(captures: { status: string }[], { hidden = false, seconds = 60 } = {}) {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requests.push(String(url));
      const body = String(url).includes("/auth/session") ? { user: { id: "user-1" }, household: { id: "house-1" } }
        : String(url).includes("/captures") ? captures : { items: [], total: 0 };
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    }));
    const hook = renderHook(() => ({ captures: useCaptureReviews(), actions: usePendingActions() }), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(hook.result.current.captures.isSuccess && hook.result.current.actions.isSuccess).toBe(true);
    if (hidden) {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    }
    requests.length = 0;
    await act(() => vi.advanceTimersByTimeAsync(seconds * 1000));
    hook.unmount();
    client.clear();
    return {
      captures: requests.filter((url) => url.includes("/captures")),
      actions: requests.filter((url) => url.includes("/proposals/pending")),
    };
  }

  it("polls slowly when nothing is queued or running and never loads dismissed captures", async () => {
    const idle = await poll([{ status: "review" }, { status: "failed" }]);
    // Previously 40 active + 40 dismissed capture requests and 12 pending-action requests a minute.
    expect(idle.captures).toHaveLength(2);
    expect(idle.actions).toHaveLength(2);
    expect(idle.captures.some((url) => url.includes("dismissed"))).toBe(false);
  });

  it("polls quickly while a capture is still processing", async () => {
    const busy = await poll([{ status: "processing" }], { seconds: 15 });
    expect(busy.captures.length).toBeGreaterThanOrEqual(9);
    expect(busy.actions.length).toBeGreaterThanOrEqual(2);
  });

  it("stops polling while the tab is hidden", async () => {
    const hidden = await poll([{ status: "processing" }], { hidden: true });
    expect(hidden.captures).toHaveLength(0);
    expect(hidden.actions).toHaveLength(0);
  });
});
