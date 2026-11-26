import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { AppearanceSettings } from "@/components/appearance-settings";
import { ThemeProvider } from "@/components/theme-provider";

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.palette;
  delete document.documentElement.dataset.theme;
  document.documentElement.classList.remove("dark");
});

describe("AppearanceSettings", () => {
  it("offers four colour themes, applies the chosen one and returns to the default", async () => {
    document.head.innerHTML = '<meta name="theme-color" content="#F8F5EF">';
    render(
      <ThemeProvider>
        <AppearanceSettings />
      </ThemeProvider>,
    );
    const themes = screen.getByRole("radiogroup", { name: "Colour theme" });
    expect(Array.from(themes.querySelectorAll('[role="radio"]')).map((radio) => radio.textContent)).toEqual([
      expect.stringContaining("Current Housetory · default"),
      expect.stringContaining("Design D"),
      expect.stringContaining("Field notes"),
      expect.stringContaining("Collected"),
    ]);
    expect(screen.getByRole("radio", { name: /Current Housetory/ })).toBeChecked();

    await userEvent.click(screen.getByRole("radio", { name: /Field notes/ }));
    expect(document.documentElement.dataset.palette).toBe("field-notes");
    expect(localStorage.getItem("housetory-palette")).toBe("field-notes");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", "#F5F2E9");

    await userEvent.click(screen.getByRole("radio", { name: /Current Housetory/ }));
    expect(document.documentElement.dataset.palette).toBeUndefined();
    expect(localStorage.getItem("housetory-palette")).toBeNull();
  });

  it("switches between light, dark and the system setting", async () => {
    render(
      <ThemeProvider>
        <AppearanceSettings />
      </ThemeProvider>,
    );
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();

    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("housetory-theme")).toBe("dark");

    await userEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement).not.toHaveClass("dark");
    expect(localStorage.getItem("housetory-theme")).toBe("light");
  });
});
