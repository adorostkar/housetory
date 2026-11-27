import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
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

describe("DialogContent and Escape", () => {
  it("closes an open suggestion list first and the dialog on the next Escape", async () => {
    function Example() {
      const [open, setOpen] = React.useState(true);
      const [listOpen, setListOpen] = React.useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>New loan</DialogTitle>
            <DialogDescription>Who borrows it</DialogDescription>
            <input
              role="combobox"
              aria-label="Borrower"
              aria-expanded={listOpen}
              aria-controls="names"
              onKeyDown={(event) => {
                if (event.key === "Escape" && listOpen) setListOpen(false);
              }}
            />
          </DialogContent>
        </Dialog>
      );
    }
    render(<Example />);
    const field = screen.getByRole("combobox", { name: "Borrower" });
    field.focus();

    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "New loan" })).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-expanded", "false");

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "New loan" })).not.toBeInTheDocument();
  });
});
