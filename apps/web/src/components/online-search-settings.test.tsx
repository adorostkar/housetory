import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OnlineSearchSettingsCard } from "@/components/online-search-settings";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queries";
import type { OnlineSearchSettings } from "@/lib/types";

const baseSettings: OnlineSearchSettings = {
  provider: "brave",
  supported_providers: ["brave"],
  manual_enabled: true,
  reference_enabled: true,
  has_api_key: true,
  environment_api_key_available: false,
  credential_source: "household",
  api_key_version: 3,
  credential_storage_ready: true,
  permitted_source_domains: ["lg.com"],
  max_permitted_domains: 50,
  manual: {
    enabled: true,
    configured: true,
    source: "household",
    provider: "brave",
    provider_label: "Brave Search API",
    reason: null,
  },
  reference: {
    enabled: true,
    configured: true,
    source: "household",
    provider: "brave",
    provider_label: "Brave Image Search API",
    reason: null,
    permitted_source_domains: ["lg.com"],
    policy_configured: true,
  },
  environment_manual_available: false,
  environment_reference_available: false,
  updated_at: "2026-11-06T12:00:00Z",
  warning: null,
};

let settings: OnlineSearchSettings | null = baseSettings;
let queryError: Error | null = null;

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useOnlineSearchSettings: () => ({
      data: settings,
      isPending: false,
      isError: Boolean(queryError),
      error: queryError,
    }),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      put: vi.fn(async () => baseSettings),
      post: vi.fn(async () => ({
        ok: true,
        message: "Manual search connected. Reference-image search connected.",
        manual_ok: true,
        reference_ok: true,
        source: "household",
        provider_label: "Brave Search API",
        tested_at: "2026-11-06T12:00:00Z",
      })),
    },
  };
});

function renderCard(isOwner = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <OnlineSearchSettingsCard isOwner={isOwner} />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  settings = baseSettings;
  queryError = null;
  vi.mocked(api.put).mockClear();
  vi.mocked(api.post).mockClear();
});

describe("OnlineSearchSettingsCard", () => {
  it("shows a saved-key indicator and never renders the key itself", () => {
    renderCard();
    expect(screen.getByText("Key saved · v3")).toBeVisible();
    expect(
      screen.getByPlaceholderText(/Saved key · v3/),
    ).toHaveAttribute("type", "password");
    expect(screen.queryByDisplayValue(/secret/i)).not.toBeInTheDocument();
  });

  it("saves domain and channel edits while leaving a blank key untouched", async () => {
    renderCard();
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Enable reference-image search" }),
    );
    const domains = screen.getByLabelText(
      "Optional source restriction (advanced)",
    );
    await userEvent.clear(domains);
    await userEvent.type(domains, "lg.com{enter}example.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Save online search" }),
    );

    await waitFor(() =>
      expect(vi.mocked(api.put)).toHaveBeenCalledWith(
        "/settings/online-search",
        {
          manual_enabled: true,
          reference_enabled: false,
          permitted_source_domains: ["lg.com", "example.com"],
        },
      ),
    );
  });

  it("is ready for public-web lookup without requiring a domain list", async () => {
    settings = {
      ...baseSettings,
      permitted_source_domains: [],
      reference: {
        ...baseSettings.reference,
        permitted_source_domains: [],
        policy_configured: true,
      },
    };
    renderCard();
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Needs domains/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Add at least one permitted source domain/),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Save online search" }),
    );
    await waitFor(() =>
      expect(vi.mocked(api.put)).toHaveBeenCalledWith(
        "/settings/online-search",
        expect.objectContaining({
          permitted_source_domains: [],
          reference_enabled: true,
        }),
      ),
    );
  });

  it("invalidates system health after saving online search settings", async () => {
    const client = renderCard();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await userEvent.click(
      screen.getByRole("button", { name: "Save online search" }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.systemStatusSummary,
      }),
    );
  });

  it("treats a typed replacement key as write-only input", async () => {
    renderCard();
    await userEvent.type(
      screen.getByLabelText("Replace Brave Search API key"),
      "brave-replacement-secret",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save online search" }),
    );

    await waitFor(() =>
      expect(vi.mocked(api.put)).toHaveBeenCalledWith(
        "/settings/online-search",
        expect.objectContaining({
          api_key: "brave-replacement-secret",
          manual_enabled: true,
          reference_enabled: true,
          permitted_source_domains: ["lg.com"],
        }),
      ),
    );
    expect(screen.queryByDisplayValue("brave-replacement-secret")).not.toBeInTheDocument();
  });

  it("removes the saved key only after explicit confirmation and disables both channels", async () => {
    const removed = {
      ...baseSettings,
      has_api_key: false,
      api_key_version: 4,
      manual_enabled: false,
      reference_enabled: false,
    };
    vi.mocked(api.put).mockImplementationOnce(async () => {
      settings = removed;
      return removed;
    });
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Remove key" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/installation fallback will not reactivate/i),
    ).toBeVisible();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove key" }),
    );

    await waitFor(() =>
      expect(vi.mocked(api.put)).toHaveBeenCalledWith(
        "/settings/online-search",
        {
          manual_enabled: false,
          reference_enabled: false,
          clear_api_key: true,
          permitted_source_domains: ["lg.com"],
        },
      ),
    );
    expect(screen.queryByText(/Key saved/)).not.toBeInTheDocument();
  });

  it("runs the connection test only after confirmation", async () => {
    renderCard();
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Run connection test" }),
    );

    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        "/settings/online-search/test",
        { confirm: true },
      ),
    );
    expect(
      await screen.findByText(/Manual search connected/),
    ).toBeVisible();
  });

  it("explains when the installation fallback is active", () => {
    settings = {
      ...baseSettings,
      credential_source: "environment",
      has_api_key: false,
      api_key_version: 0,
      manual_enabled: false,
      reference_enabled: false,
      manual: {
        ...baseSettings.manual,
        enabled: false,
        source: "environment",
      },
      reference: {
        ...baseSettings.reference,
        enabled: false,
        source: "environment",
      },
      environment_manual_available: true,
      environment_reference_available: true,
    };
    renderCard();
    expect(screen.getByText("Installation fallback is active.")).toBeVisible();
    expect(screen.getByText(/Saving this card overrides/)).toBeVisible();
  });

  it("does not render for members or viewers", () => {
    renderCard(false);
    expect(screen.queryByText("Online search")).not.toBeInTheDocument();
  });

  it("shows a loading error without exposing configuration", () => {
    settings = null;
    queryError = new Error("Settings unavailable");
    renderCard();
    expect(screen.getByText("Online search")).toBeVisible();
    expect(screen.getByText("Settings unavailable")).toBeVisible();
  });
});
