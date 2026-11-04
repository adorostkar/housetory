import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@/components/theme-provider";
import { api } from "@/lib/api";
import type { AiStatus, Overview, SessionState } from "@/lib/types";
import { SettingsPage } from "@/pages/settings-page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
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
    warranty_reminder_days: 30,
  },
  role: "owner",
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

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return client;
}

function mockApi(status: () => AiStatus) {
  const calls = { status: 0 };
  vi.mocked(api.get).mockImplementation(((path: string) => {
    if (path === "/auth/session") return Promise.resolve(session);
    if (path === "/overview") return Promise.resolve(overview);
    if (path.startsWith("/ai/status")) {
      calls.status += 1;
      return Promise.resolve(status());
    }
    return Promise.reject(new Error(`Unexpected request: ${path}`));
  }) as typeof api.get);
  return calls;
}

describe("SettingsPage Intelligence summary", () => {
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
    renderPage();

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
    renderPage();

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
    renderPage();

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
    renderPage();

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
    renderPage();

    expect(await screen.findByText("Task disabled")).toBeVisible();
    expect(screen.getByText("AI is disabled for this task.")).toBeVisible();
    expect(screen.queryByText("Model not listed")).not.toBeInTheDocument();
    expect(screen.queryByText(/models listed/)).not.toBeInTheDocument();
  });
});
