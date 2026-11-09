import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { FinancialsLayout, isFinancialsPath } from "@/components/financials-layout";

describe("FinancialsLayout", () => {
  it("renders the three tabs, marks the current one and keeps the household", () => {
    render(
      <MemoryRouter initialEntries={["/warranties?household_id=h1"]}>
        <Routes>
          <Route element={<FinancialsLayout />}>
            <Route path="warranties" element={<p>Warranty page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("Warranty page")).toBeVisible();
    expect(screen.getByRole("link", { name: "Warranties" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Insurance" })).toHaveAttribute(
      "href",
      "/insurance?household_id=h1",
    );
  });

  it("recognises financial paths only", () => {
    expect(isFinancialsPath("/purchases")).toBe(true);
    expect(isFinancialsPath("/insurance/abc")).toBe(true);
    expect(isFinancialsPath("/items")).toBe(false);
  });
});
