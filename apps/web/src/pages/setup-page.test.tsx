import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, api } from "@/lib/api";
import { queryKeys } from "@/lib/queries";
import type { SessionState } from "@/lib/types";
import { NoHouseholdPage } from "@/pages/no-household-page";
import { SetupPage } from "@/pages/setup-page";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

const user = {
  id: "user-1",
  name: "Ada Lovelace",
  email: "ada@example.test",
  created_at: "2026-01-01T00:00:00Z",
};
const household = {
  id: "household-1",
  name: "Elm Street",
  default_currency: "USD",
  warranty_reminder_days: 30,
};
const fresh: SessionState = {
  authenticated: false,
  setup_required: true,
  user: null,
  household: null,
  role: null,
};
const signedIn: SessionState = {
  authenticated: true,
  setup_required: false,
  user,
  household,
  role: "owner",
  households: [{ ...household, role: "owner", property_count: 1, is_current: true }],
};
const noHousehold: SessionState = { ...signedIn, household: null, role: null, households: [] };

function renderAt(path: string, initial: SessionState) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  client.setQueryData(queryKeys.session, initial);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/start" element={<NoHouseholdPage />} />
          <Route path="/items" element={<p>Inventory</p>} />
          <Route path="/login" element={<p>Sign in</p>} />
          <Route path="/" element={<p>Start page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockReset();
});

describe("SetupPage", () => {
  it("creates the account and home in one form and opens the inventory", async () => {
    vi.mocked(api.post).mockResolvedValue(signedIn);
    renderAt("/setup", fresh);

    expect(screen.getByRole("heading", { name: "1 · Your account" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "2 · Your home" })).toBeVisible();
    expect(screen.getByLabelText("Household name")).toHaveValue("My Home");
    await userEvent.type(screen.getByLabelText("Your name"), " Ada Lovelace ");
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "a long passphrase");
    await userEvent.clear(screen.getByLabelText("Household name"));
    await userEvent.type(screen.getByLabelText("Household name"), "Elm Street");
    await userEvent.click(screen.getByRole("button", { name: "Create account and home" }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/auth/setup", {
        name: "Ada Lovelace",
        email: "ada@example.test",
        password: "a long passphrase",
        household_name: "Elm Street",
      }),
    );
    expect(await screen.findByText("Inventory")).toBeVisible();
  });

  it("shows field errors from the server and stays on the form", async () => {
    vi.mocked(api.post).mockRejectedValue(
      new ApiError(422, "validation_error", "Check the form.", {
        password: "Use at least 12 characters.",
      }),
    );
    renderAt("/setup", fresh);
    await userEvent.click(screen.getByRole("button", { name: "Create account and home" }));

    expect(await screen.findByText("Use at least 12 characters.")).toBeVisible();
    expect(screen.queryByText("Inventory")).not.toBeInTheDocument();
  });

  it("is closed once setup is done", () => {
    renderAt("/setup", { ...fresh, setup_required: false });
    expect(screen.getByText("Sign in")).toBeVisible();
  });
});

describe("NoHouseholdPage", () => {
  it("creates the first household with its first property and opens the inventory", async () => {
    vi.mocked(api.post).mockResolvedValue(signedIn);
    renderAt("/start", noHousehold);

    expect(screen.getByText("ada@example.test")).toBeVisible();
    expect(screen.getByText(/Have an invitation\?/)).toBeVisible();
    const create = screen.getByRole("button", { name: "Create household" });
    expect(create).toBeDisabled();
    expect(screen.getByLabelText("First property")).toHaveValue("Home");
    await userEvent.type(screen.getByLabelText("Household name"), " Elm Street ");
    await userEvent.click(create);

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/households", {
        name: "Elm Street",
        property_name: "Home",
      }),
    );
    expect(await screen.findByText("Inventory")).toBeVisible();
  });

  it("can sign out instead", async () => {
    vi.mocked(api.post).mockResolvedValue(undefined);
    renderAt("/start", noHousehold);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/auth/logout"));
    expect(await screen.findByText("Sign in")).toBeVisible();
  });
});
