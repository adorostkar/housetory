import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useItemsView } from "@/components/view-toggle";

describe("useItemsView", () => {
  beforeEach(() => localStorage.clear());

  it("shows compact rows until a view is chosen, or the fallback a page gives", () => {
    expect(renderHook(() => useItemsView()).result.current[0]).toBe("list");
    expect(renderHook(() => useItemsView(() => "grid")).result.current[0]).toBe("grid");
    // Looking at a list is not a choice, and a view stored by the old key is not one either.
    expect(localStorage.getItem("housetory.items.view.v2")).toBeNull();
    localStorage.setItem("housetory.items.view", "grid");
    expect(renderHook(() => useItemsView()).result.current[0]).toBe("list");
  });

  it("persists the choice and prefers it over the fallback", () => {
    const first = renderHook(() => useItemsView());
    act(() => first.result.current[1]("grid"));
    expect(first.result.current[0]).toBe("grid");
    expect(localStorage.getItem("housetory.items.view.v2")).toBe("grid");
    const second = renderHook(() => useItemsView(() => "list"));
    expect(second.result.current[0]).toBe("grid");
  });
});
