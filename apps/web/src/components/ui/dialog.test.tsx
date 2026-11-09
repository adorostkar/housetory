import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

describe("DialogContent bottom sheet", () => {
  it("exposes mobile sheet classes, a handle, a title and a close control", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move item</DialogTitle>
            <DialogDescription>Pick a place</DialogDescription>
          </DialogHeader>
          <DialogFooter>Actions</DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Move item" });
    expect(dialog.className).toContain("max-sm:bottom-0");
    expect(dialog.className).toContain("max-sm:max-h-[90dvh]");
    expect(dialog.className).toContain("max-sm:rounded-t-2xl");
    expect(dialog.className).toContain("-translate-y-1/2");
    expect(dialog.querySelector("[data-dialog-handle]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" }).parentElement?.className).toContain("max-sm:sticky");
    expect(screen.getByText("Actions").className).toContain("max-sm:sticky");
  });
});
