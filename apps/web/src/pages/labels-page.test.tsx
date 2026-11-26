import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LabelsPage } from "@/pages/labels-page";

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useLabelTemplates: () => ({ data: { items: [], default: "L7165" }, isPending: false }),
    useContainers: () => ({ data: { items: [] }, isPending: false }),
  };
});

function renderPage(path = "/labels") {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <LabelsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("LabelsPage calibration", () => {
  it("keeps calibration closed under Advanced until it is opened", async () => {
    renderPage();
    const summary = screen.getByText("Advanced · Calibration");
    const details = summary.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(screen.queryByText(/Offsets in use/)).not.toBeInTheDocument();

    await userEvent.click(summary);
    expect(details).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Download calibration sheet" })).toBeVisible();
    expect(screen.getByLabelText("Horizontal (mm)")).toHaveValue(0);
  });

  it("opens from the Settings link and shows saved offsets even when closed", async () => {
    window.localStorage.setItem(
      "housetory-label-calibration",
      JSON.stringify({ offsetX: 1.5, offsetY: -0.5 }),
    );
    renderPage("/labels#calibration");
    const details = screen.getByText("Advanced · Calibration").closest("details")!;
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("Offsets in use: 1.5 / -0.5 mm")).toBeVisible();

    await userEvent.click(screen.getByText("Advanced · Calibration"));
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("Offsets in use: 1.5 / -0.5 mm")).toBeInTheDocument();
  });
});
