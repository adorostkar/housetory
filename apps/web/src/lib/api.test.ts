import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("request cancellation", () => {
  it.each(["json", "blob"])("preserves an aborted %s request", async (kind) => {
    const controller = new AbortController();
    const error = new DOMException("Cancelled", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    controller.abort();
    const request = kind === "json"
      ? api.get("/items", { signal: controller.signal })
      : api.postBlob("/evidence-exports/preview", undefined, { signal: controller.signal });
    await expect(request).rejects.toBe(error);
  });

  it("still reports a real network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network failure")));
    await expect(api.get("/items")).rejects.toMatchObject({ code: "network_error" });
  });
});
