import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BottomBar } from "@/components/shell/bottom-bar";

function renderBar() {
  return render(
    <BottomBar compact railOpen onToggleRail={vi.fn()} canAdd onAdd={vi.fn()} keyboardOpen={false}>
      {({ onFocusChange }) => (
        <input aria-label="Search" onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)} />
      )}
    </BottomBar>,
  );
}

describe("BottomBar", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps its layout for a moment after the field loses focus, so a tap on a bar button does not miss", () => {
    vi.useFakeTimers();
    renderBar();
    expect(screen.getByRole("button", { name: "Add items" })).toBeInTheDocument();

    fireEvent.focus(screen.getByRole("textbox", { name: "Search" }));
    // The field has the whole bar while it is typed in.
    expect(screen.queryByRole("button", { name: "Add items" })).not.toBeInTheDocument();

    // On a phone the tap on a button takes focus from the field before the click.
    fireEvent.blur(screen.getByRole("textbox", { name: "Search" }));
    expect(screen.queryByRole("button", { name: "Add items" })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("button", { name: "Add items" })).toBeInTheDocument();
  });

  it("does not give the room back when focus returns at once", () => {
    vi.useFakeTimers();
    renderBar();
    const field = screen.getByRole("textbox", { name: "Search" });
    fireEvent.focus(field);
    fireEvent.blur(field);
    fireEvent.focus(field);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole("button", { name: "Add items" })).not.toBeInTheDocument();
  });
});
