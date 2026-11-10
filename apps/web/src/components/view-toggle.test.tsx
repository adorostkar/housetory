import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useItemsView } from "@/components/view-toggle";

describe("useItemsView", () => {
  beforeEach(() => localStorage.clear());

  it("uses the fallback when nothing is stored", () => {
    const { result } = renderHook(() => useItemsView(() => "list"));
    expect(result.current[0]).toBe("list");
  });

  it("persists the choice and prefers it over the fallback", () => {
    const first = renderHook(() => useItemsView());
    act(() => first.result.current[1]("list"));
    expect(localStorage.getItem("housetory.items.view")).toBe("list");
    const second = renderHook(() => useItemsView(() => "grid"));
    expect(second.result.current[0]).toBe("list");
  });
});
