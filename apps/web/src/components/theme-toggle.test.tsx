import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";

function renderToggle() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

afterEach(() => {
  localStorage.removeItem("housetory-theme");
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty("color-scheme");
});

describe("ThemeToggle", () => {
  it("cycles Light, Dark and System with the current-selection icon and next-action label", async () => {
    localStorage.setItem("housetory-theme", "light");
    renderToggle();
    const user = userEvent.setup();
    const button = screen.getByRole("button");

    expect(button).toHaveAccessibleName("Appearance: Light. Switch to dark mode");
    expect(button.querySelector("svg")).toHaveClass("lucide-sun");
    await user.click(button);
    expect(button).toHaveAccessibleName("Appearance: Dark. Switch to system mode");
    expect(button.querySelector("svg")).toHaveClass("lucide-moon");
    expect(document.documentElement).toHaveClass("dark");

    await user.click(button);
    expect(button).toHaveAccessibleName("Appearance: System. Switch to light mode");
    expect(button.querySelector("svg")).toHaveClass("lucide-monitor");
    expect(document.documentElement).not.toHaveClass("dark");

    await user.click(button);
    expect(button).toHaveAccessibleName("Appearance: Light. Switch to dark mode");
    expect(button.querySelector("svg")).toHaveClass("lucide-sun");
    expect(localStorage.getItem("housetory-theme")).toBe("light");
  });

  it("keeps System selected as device appearance changes and cycles independently of it", async () => {
    const media = Object.assign(new EventTarget(), {
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    renderToggle();
    const button = screen.getByRole("button");
    expect(button).toHaveAccessibleName("Appearance: System. Switch to light mode");

    act(() => {
      media.matches = true;
      media.dispatchEvent(new Event("change"));
    });
    expect(document.documentElement).toHaveClass("dark");
    expect(button).toHaveAccessibleName("Appearance: System. Switch to light mode");
    expect(button.querySelector("svg")).toHaveClass("lucide-monitor");

    act(() => {
      media.matches = false;
      media.dispatchEvent(new Event("change"));
    });
    expect(document.documentElement).not.toHaveClass("dark");
    await userEvent.click(button);
    expect(button).toHaveAccessibleName("Appearance: Light. Switch to dark mode");

    act(() => {
      media.matches = true;
      media.dispatchEvent(new Event("change"));
    });
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("restores the saved preference after remounting", async () => {
    localStorage.setItem("housetory-theme", "dark");
    const view = renderToggle();
    expect(screen.getByRole("button")).toHaveAccessibleName(
      "Appearance: Dark. Switch to system mode",
    );
    await userEvent.click(screen.getByRole("button"));
    expect(localStorage.getItem("housetory-theme")).toBe("system");
    view.unmount();
    renderToggle();
    expect(screen.getByRole("button")).toHaveAccessibleName(
      "Appearance: System. Switch to light mode",
    );
    expect(screen.getByRole("button").querySelector("svg")).toHaveClass("lucide-monitor");
  });
});
