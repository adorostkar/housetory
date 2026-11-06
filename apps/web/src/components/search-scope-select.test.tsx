import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { SearchScopeSelect } from "@/components/search-scope-select";

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useSearchScopes: () => ({
      data: {
        items: [
          {
            id: "home-1",
            name: "Ada's Home",
            role: "owner",
            properties: [
              { id: "property-home", name: "Home", is_archived: false },
              { id: "property-cabin", name: "Cabin", is_archived: false },
            ],
          },
          {
            id: "home-2",
            name: "Studio",
            role: "viewer",
            properties: [
              { id: "property-studio", name: "Studio", is_archived: false },
            ],
          },
        ],
      },
      isPending: false,
      isError: false,
    }),
  };
});

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">{`${location.pathname}${location.search}`}</output>
  );
}

describe("SearchScopeSelect", () => {
  it("defaults to All my places and remembers a household/property scope in the URL", async () => {
    render(
      <MemoryRouter initialEntries={["/search?q=drill"]}>
        <SearchScopeSelect />
        <LocationProbe />
      </MemoryRouter>,
    );
    const select = screen.getByLabelText("Search scope");
    expect(select).toHaveValue("all");
    await userEvent.selectOptions(
      select,
      screen.getByRole("option", { name: "Ada's Home · Cabin" }),
    );
    expect(screen.getByTestId("location")).toHaveTextContent(
      "household_id=home-1&property_id=property-cabin",
    );
    expect(window.localStorage.getItem("housetory-search-scope")).toContain(
      "property-cabin",
    );
  });
});
