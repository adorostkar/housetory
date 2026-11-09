import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { HouseholdSwitcher } from "@/components/household-switcher";

const selectMutate = vi.fn();

const session = {
  authenticated: true,
  setup_required: false,
  user: {
    id: "user-1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    created_at: "2026-01-01T00:00:00Z",
  },
  household: { id: "home-1", name: "Ada's Home", default_currency: "USD", warranty_reminder_days: 30 },
  role: "owner" as const,
  households: [
    {
      id: "home-1",
      name: "Ada's Home",
      default_currency: "USD", warranty_reminder_days: 30,
      role: "owner" as const,
      property_count: 2,
      is_current: true,
    },
    {
      id: "home-2",
      name: "Cabin",
      default_currency: "USD", warranty_reminder_days: 30,
      role: "viewer" as const,
      property_count: 1,
      is_current: false,
    },
  ],
};

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useSession: () => ({ data: session, isPending: false }),
    useSelectHousehold: () => ({
      mutate: selectMutate,
      isPending: false,
    }),
    useCreateHousehold: () => ({
      mutate: vi.fn(),
      isPending: false,
      error: null,
    }),
  };
});

describe("HouseholdSwitcher", () => {
  it("shows independent memberships and switches to the chosen household", async () => {
    render(
      <MemoryRouter>
        <HouseholdSwitcher compact />
      </MemoryRouter>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Switch household" }),
    );
    expect(screen.getByText("Ada's Home")).toBeVisible();
    expect(screen.getByText("Cabin")).toBeVisible();
    expect(screen.getByText(/Owner · 2 properties/)).toBeVisible();
    expect(screen.getByText(/Viewer · 1 property/)).toBeVisible();
    await userEvent.click(screen.getByText("Cabin"));
    expect(selectMutate).toHaveBeenCalledWith("home-2", expect.any(Object));
  });

  it("opens the first-household creation flow", async () => {
    render(
      <MemoryRouter>
        <HouseholdSwitcher compact />
      </MemoryRouter>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Switch household" }),
    );
    await userEvent.click(screen.getByText("Create household"));
    expect(
      screen.getByRole("dialog", { name: "Create a household" }),
    ).toBeVisible();
  });
});
