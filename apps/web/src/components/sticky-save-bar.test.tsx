import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { StickySaveBar } from "@/components/sticky-save-bar";

describe("StickySaveBar", () => {
  it("is hidden when clean", () => {
    render(<StickySaveBar dirty={false} onSave={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.queryByTestId("sticky-save-bar")).toBeNull();
  });

  it("shows status and calls handlers when dirty", async () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    render(<StickySaveBar dirty saveLabel="Save default" onSave={onSave} onDiscard={onDiscard} />);
    expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    await userEvent.click(screen.getByRole("button", { name: "Save default" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("disables save when it cannot save", () => {
    render(<StickySaveBar dirty canSave={false} onSave={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });
});
