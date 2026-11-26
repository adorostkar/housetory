import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@/components/theme-provider";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queries";
import type {
  AiStatus,
  Household,
  OnlineSearchSettings,
  Overview,
  SessionState,
} from "@/lib/types";
import { SettingsAdvancedPage } from "@/pages/settings-advanced-page";
import { SettingsHouseholdPage } from "@/pages/settings-household-page";
import { SettingsPage } from "@/pages/settings-page";
import { SettingsServicesPage } from "@/pages/settings-services-page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
      patch: vi.fn(),
    },
  };
});

const session: SessionState = {
  authenticated: true,
  setup_required: false,
  user: {
    id: "user-1",
    name: "Ashkan",
    email: "owner@example.test",
    created_at: "2026-01-01T00:00:00Z",
  },
  household: {
    id: "household-1",
    name: "Home",
    default_currency: "USD",
    warranty_reminder_days: 30,
  },
  role: "owner",
  households: [
    {
      id: "household-1",
      name: "Home",
      default_currency: "USD",
      warranty_reminder_days: 30,
      role: "owner",
      property_count: 1,
      is_current: true,
    },
  ],
};

const overview = {
  photo_bytes: 0,
  document_bytes: 0,
} as Overview;

const baseStatus: AiStatus = {
  provider: "openrouter",
  mode: "cloud",
  source: "database",
  task: "assistant",
  provider_id: "provider-1",
  provider_label: "OpenRouter",
  capabilities: ["text", "structured", "tools"],
  model: "~openai/gpt-luna-latest",
  configured: true,
  available: true,
  catalog_checked: true,
  catalog_count: 500,
  cloud_enabled: true,
  cloud_consent: true,
  data_leaves_server: true,
  error: null,
  privacy_note: "Remote inference sends household prompts to openrouter.ai.",
};

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.hash}</p>;
}

/** Renders the Settings index and its screens at the given address. */
function renderPage(path = "/settings") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/household" element={<SettingsHouseholdPage />} />
            <Route path="/settings/services" element={<SettingsServicesPage />} />
            <Route path="/settings/advanced" element={<SettingsAdvancedPage />} />
            <Route path="*" element={null} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return client;
}

function mockApi(status: () => AiStatus, getSession: () => SessionState = () => session) {
  const calls = { status: 0 };
  vi.mocked(api.get).mockImplementation(((path: string) => {
    if (path === "/auth/session") return Promise.resolve(getSession());
    if (path === "/overview") return Promise.resolve(overview);
    if (path === "/system/status/summary") {
      return Promise.resolve({
        status: "healthy",
        attention_count: 0,
        core_issue_count: 0,
        configured_feature_issue_count: 0,
        optional_not_configured: ["Email delivery", "AI tasks"],
        issues: [],
        generated_at: "2026-11-06T12:30:00Z",
      });
    }
    if (path.startsWith("/ai/status")) {
      calls.status += 1;
      return Promise.resolve(status());
    }
    return Promise.reject(new Error(`Unexpected request: ${path}`));
  }) as typeof api.get);
  return calls;
}

describe("Settings index", () => {
  it("lists every screen as a link row and keeps Sign out at the foot", async () => {
    mockApi(() => baseStatus);
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Settings", level: 1 }),
    ).toBeVisible();
    const rows: Array<[RegExp, string]> = [
      [/^Account/, "/settings/account"],
      [/^Appearance/, "/settings/appearance"],
      [/^Household/, "/settings/household"],
      [/^Members and invitations/, "/settings/members"],
      [/^AI and online services/, "/settings/services"],
      [/^System status/, "/settings/system-status"],
      [/^Storage, install and labels/, "/settings/advanced"],
    ];
    for (const [name, href] of rows) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    }
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent),
    ).toEqual(["Yours", "Household", "Advanced", "Sign out"]);
    expect(screen.getByRole("link", { name: /^Account/ })).toHaveTextContent(
      "Ashkan · owner@example.test",
    );
    expect(screen.getByRole("link", { name: /^Appearance/ })).toHaveTextContent(
      "Current Housetory · System",
    );
    expect(screen.getByRole("link", { name: /^Household/ })).toHaveTextContent(
      "Home · USD · you are owner",
    );
    expect(
      await within(screen.getByRole("link", { name: /^System status/ })).findByText("Healthy"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
    // The index holds no forms and never checks the AI provider.
    expect(screen.queryByLabelText("Household name")).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith(expect.stringMatching(/^\/ai\/status/));
  });

  it("hides owner-only rows from members and viewers and says why", async () => {
    mockApi(() => baseStatus, () => ({ ...session, role: "viewer" }));
    renderPage();

    expect(await screen.findByRole("link", { name: /^Household/ })).toHaveTextContent(
      "you are viewer",
    );
    expect(screen.getByRole("link", { name: /^AI and online services/ })).toBeVisible();
    expect(screen.queryByRole("link", { name: /^Members and invitations/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^System status/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Only the household owner can change household settings/)).toBeVisible();
    expect(api.get).not.toHaveBeenCalledWith("/system/status/summary");
  });

  it.each([
    ["#online-search", "/settings/services#online-search"],
    ["#online-manual-search", "/settings/services#online-manual-search"],
    ["#item-images", "/settings/household#item-images"],
    ["#system-status", "/settings/system-status#system-status"],
  ])("sends the old anchor %s to the screen that now holds it", async (hash, target) => {
    mockApi(() => baseStatus);
    renderPage(`/settings${hash}`);

    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(target));
  });
});

describe("Settings › Advanced", () => {
  it("keeps storage, install help and the label calibration link", async () => {
    mockApi(() => baseStatus);
    renderPage("/settings/advanced");

    expect(await screen.findByRole("heading", { name: "Storage", level: 2 })).toBeVisible();
    expect(screen.getByText("scripts/backup.sh")).toBeVisible();
    expect(screen.getByText("Install on your iPhone")).toBeVisible();
    expect(
      await screen.findByRole("link", { name: "Open label calibration" }),
    ).toHaveAttribute("href", "/labels#calibration");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });
});

describe("Settings › Household defaults", () => {
  it("saves the default currency, updates cached memberships and follows household switches", async () => {
    let currentSession = session;
    mockApi(() => baseStatus, () => currentSession);
    const updatedHousehold: Household = {
      ...session.household!,
      default_currency: "EUR",
    };
    vi.mocked(api.patch).mockImplementation((() => {
      currentSession = {
        ...currentSession,
        household: updatedHousehold,
        households: currentSession.households?.map((entry) =>
          entry.id === updatedHousehold.id
            ? { ...entry, ...updatedHousehold }
            : entry,
        ),
      };
      return Promise.resolve(updatedHousehold);
    }) as typeof api.patch);
    const client = renderPage("/settings/household");

    const currency = await screen.findByLabelText("Default currency");
    expect(currency).toHaveValue("USD");
    expect(screen.getByRole("option", { name: "EUR" })).toBeInTheDocument();
    await userEvent.selectOptions(currency, "EUR");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/household", {
        name: "Home",
        default_currency: "EUR",
        warranty_reminder_days: 30,
        item_image_auto_reference: false,
      }),
    );
    await waitFor(() => {
      const cached = client.getQueryData<SessionState>(queryKeys.session);
      expect(cached?.household?.default_currency).toBe("EUR");
      expect(cached?.households?.[0]?.default_currency).toBe("EUR");
    });

    const switched: SessionState = {
      ...currentSession,
      household: {
        id: "household-2",
        name: "Cabin",
        default_currency: "GBP",
        warranty_reminder_days: 14,
      },
      households: [],
    };
    currentSession = switched;
    client.setQueryData(queryKeys.session, switched);
    await waitFor(() => expect(currency).toHaveValue("GBP"));
  });

  it("shows the same fields read-only to a viewer, with no members link", async () => {
    mockApi(() => baseStatus, () => ({ ...session, role: "viewer" }));
    renderPage("/settings/household");

    expect(await screen.findByLabelText("Household name")).toBeDisabled();
    expect(screen.getByLabelText("Default currency")).toBeDisabled();
    expect(screen.getByLabelText(/Automatically find a reference image/)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: /Members & invitations/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Only the household owner can change these settings/)).toBeVisible();
  });
});

describe("Settings › AI and online services: Intelligence summary", () => {
  it("shows a compact catalog count and never renders hundreds of model IDs", async () => {
    const catalog = Array.from(
      { length: 500 },
      (_, index) => `private/catalog-model-${index}`,
    );
    const calls = mockApi(
      () =>
        ({
          ...baseStatus,
          // Defensive: even if a stale/older API includes the catalog, Settings must not render it.
          models: catalog,
        }) as AiStatus,
    );
    renderPage("/settings/services");

    expect(
      await screen.findByText("Model listed by provider"),
    ).toBeVisible();
    expect(screen.getByText("500 models listed")).toBeVisible();
    expect(screen.getByText("OpenRouter")).toBeVisible();
    expect(screen.getByText("~openai/gpt-luna-latest")).toBeVisible();
    expect(screen.getByText("Remote/cloud — leaves this server")).toBeVisible();
    expect(screen.getByText("Given for remote inference")).toBeVisible();
    expect(screen.getByRole("link", { name: "Manage AI providers" })).toHaveAttribute(
      "href",
      "/settings/ai",
    );
    expect(screen.queryByText("Available models")).not.toBeInTheDocument();
    expect(screen.queryByText(catalog[499]!)).not.toBeInTheDocument();
    expect(screen.queryByText(catalog[0]!)).not.toBeInTheDocument();
    expect(calls.status).toBe(1);
  });

  it("reports a saved display label that is absent from the provider catalog without claiming readiness", async () => {
    mockApi(() => ({
      ...baseStatus,
      model: "GPT-6 Luna",
      available: false,
      error:
        "Model 'GPT-6 Luna' was not listed in the provider catalog. Choose a discovered model or enter the exact API model name.",
    }));
    renderPage("/settings/services");

    expect(await screen.findByText("Model not listed")).toBeVisible();
    expect(screen.getByText("GPT-6 Luna")).toBeVisible();
    expect(screen.getByText("500 models listed")).toBeVisible();
    expect(
      screen.getByText(/was not listed in the provider catalog/),
    ).toBeVisible();
    expect(
      screen.getByText(/does not send a test prompt/i),
    ).toBeVisible();
    expect(screen.queryByText("Model listed by provider")).not.toBeInTheDocument();
  });

  it("refreshes the summary when Check provider returns a changed catalog result", async () => {
    let current: AiStatus = {
      ...baseStatus,
      model: "GPT-6 Luna",
      available: false,
      error: "Model 'GPT-6 Luna' was not listed in the provider catalog.",
    };
    const calls = mockApi(() => current);
    renderPage("/settings/services");

    expect(await screen.findByText("Model not listed")).toBeVisible();
    current = { ...baseStatus, model: "~openai/gpt-luna-latest" };
    await userEvent.click(
      screen.getByRole("button", { name: /Check provider/ }),
    );
    await waitFor(() =>
      expect(screen.getByText("Model listed by provider")).toBeVisible(),
    );
    expect(screen.getByText("~openai/gpt-luna-latest")).toBeVisible();
    expect(calls.status).toBeGreaterThanOrEqual(2);
  });

  it("shows catalog failures separately from a model mismatch", async () => {
    mockApi(() => ({
      ...baseStatus,
      model: "~openai/gpt-luna-latest",
      available: false,
      catalog_checked: false,
      catalog_count: 0,
      error: "Provider returned HTTP 503: upstream unavailable",
    }));
    renderPage("/settings/services");

    expect(await screen.findByText("Catalog check failed")).toBeVisible();
    expect(screen.getByText(/HTTP 503/)).toBeVisible();
    expect(screen.queryByText("Model not listed")).not.toBeInTheDocument();
    expect(screen.queryByText(/models listed/)).not.toBeInTheDocument();
  });

  it("labels a disabled task without implying a missing model", async () => {
    mockApi(() => ({
      ...baseStatus,
      configured: false,
      available: false,
      catalog_checked: false,
      catalog_count: 0,
      error: "AI is disabled for this task.",
    }));
    renderPage("/settings/services");

    expect(await screen.findByText("Task disabled")).toBeVisible();
    expect(screen.getByText("AI is disabled for this task.")).toBeVisible();
    expect(screen.queryByText("Model not listed")).not.toBeInTheDocument();
    expect(screen.queryByText(/models listed/)).not.toBeInTheDocument();
  });
});

describe("Settings › AI and online services: online lookups", () => {
  it("shows one Online lookups section instead of separate lookup sections", async () => {
    mockApi(() => baseStatus);
    const fallback = vi.mocked(api.get).getMockImplementation()!;
    const channel = {
      enabled: false,
      configured: false,
      source: "none",
      provider: "brave",
      provider_label: null,
      reason: null,
    };
    const onlineSearch = {
      provider: "brave",
      supported_providers: ["brave"],
      manual_enabled: false,
      reference_enabled: false,
      has_api_key: false,
      environment_api_key_available: false,
      credential_source: "none",
      api_key_version: 0,
      credential_storage_ready: true,
      permitted_source_domains: [],
      max_permitted_domains: 50,
      manual: channel,
      reference: { ...channel, permitted_source_domains: [], policy_configured: true },
      environment_manual_available: false,
      environment_reference_available: false,
      updated_at: null,
      warning: null,
    } as unknown as OnlineSearchSettings;
    vi.mocked(api.get).mockImplementation(((path: string) =>
      path === "/settings/online-search"
        ? Promise.resolve(onlineSearch)
        : fallback(path)) as typeof api.get);
    renderPage("/settings/services");

    expect(
      await screen.findByRole("heading", { name: "Online manual search", level: 3 }),
    ).toBeVisible();
    const sections = screen
      .getAllByRole("heading", { level: 2 })
      .map((node) => node.textContent);
    expect(sections.filter((name) => name === "Online lookups")).toHaveLength(1);
    expect(sections).not.toContain("Online search");
    expect(sections).not.toContain("Online manual search");
    expect(sections).not.toContain("Reference-image search");
  });
});
