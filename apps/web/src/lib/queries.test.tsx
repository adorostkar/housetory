import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDocuments, useInvalidateInventory, useItemHistory, useItems } from "@/lib/queries";

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
