import { describe, expect, it } from "vitest";

import {
  appendOrigin,
  itemHref,
  itemOrigin,
  readOrigin,
  safeOriginLabel,
  safeRelativePath,
} from "@/lib/navigation";

describe("navigation origin safety", () => {
  it("accepts only same-app relative paths", () => {
    expect(safeRelativePath("/containers/abc?scope=direct")).toBe(
      "/containers/abc?scope=direct",
    );
    expect(safeRelativePath("/rooms/abc#contents")).toBe("/rooms/abc#contents");
    for (const unsafe of [
      "https://evil.example/steal",
      "//evil.example/steal",
      "javascript:alert(1)",
      "\\\\evil.example",
      "/rooms/abc\nInjected",
      "",
      null,
    ]) {
      expect(safeRelativePath(unsafe)).toBeNull();
    }
  });

  it("round-trips bounded labels and encoded paths", () => {
    const origin = itemOrigin("/containers/abc?scope=direct", "BOX-001 · Shelf");
    expect(origin).toEqual({
      path: "/containers/abc?scope=direct",
      label: "BOX-001 · Shelf",
    });
    const href = appendOrigin("/items/item-1/edit", origin);
    const params = new URL(href, "http://test").searchParams;
    expect(params.get("from")).toBe("/containers/abc?scope=direct");
    expect(params.get("from_label")).toBe("BOX-001 · Shelf");
    expect(readOrigin(params)).toEqual(origin);
  });

  it("does not trust an external return URL or unsafe label", () => {
    const params = new URLSearchParams({
      from: "https://evil.example",
      from_label: "Evil",
    });
    expect(readOrigin(params)).toBeNull();
    expect(safeOriginLabel("  BOX-001\u0000\n")).toBe("BOX-001");
  });

  it("builds household-aware item links with the origin preserved", () => {
    const href = itemHref(
      "item-1",
      { path: "/rooms/room-1?scope=direct", label: "Garage" },
      "household-1",
    );
    const params = new URL(href, "http://test").searchParams;
    expect(params.get("household_id")).toBe("household-1");
    expect(params.get("from")).toBe("/rooms/room-1?scope=direct");
    expect(params.get("from_label")).toBe("Garage");
  });
});
