import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiSettingsPage } from "@/pages/ai-settings-page";
import { api } from "@/lib/api";
import type { AiSettings, AiTaskSetting } from "@/lib/types";

const settings: AiSettings = {
  credential_key_configured: true,
  environment_provider: "disabled",
  warning: null,
  providers: [
    {
      id: "provider-openai",
      provider: "openai",
      display_name: "OpenAI household",
      base_url: "https://api.openai.com/v1",
      default_model: "gpt-4o",
      has_api_key: true,
      api_key_version: 1,
      enabled: true,
      cloud_consent: true,
      is_local: false,
      endpoint_scope: "remote",
      capabilities: ["text", "vision", "structured", "tools"],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    {
      id: "provider-ollama",
      provider: "ollama",
      display_name: "Home Ollama",
      base_url: "http://host.docker.internal:11434",
      default_model: "llava",
      has_api_key: false,
      api_key_version: 1,
      enabled: true,
      cloud_consent: false,
      is_local: true,
      endpoint_scope: "local",
      capabilities: ["text", "structured", "vision"],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ],
  tasks: [
    task("assistant", "provider-openai", "gpt-4o"),
    task("imports", "provider-openai", "gpt-4o"),
    task("documents", "provider-openai", "gpt-4o"),
    task("search", "provider-openai", "gpt-4o"),
    task("vision", "provider-openai", "gpt-4o"),
    task("labels", "provider-openai", "gpt-4o"),
  ],
};

function task(name: string, providerId: string, model: string): AiTaskSetting {
  return {
    task: name,
    provider_id: providerId,
    provider_label: "OpenAI household",
    model,
    enabled: true,
    capabilities: ["text", "vision", "structured", "tools"],
    updated_at: "2026-01-01T00:00:00Z",
  };
}

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useSession: () => ({
      data: { role: "owner", authenticated: true },
      isPending: false,
    }),
    useAiSettings: () => ({
      data: settings,
      isPending: false,
      isError: false,
      error: null,
    }),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
  };
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AiSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.put).mockReset();
  vi.mocked(api.post).mockReset();
});

describe("AiSettingsPage", () => {
  it("shows encrypted providers, local/cloud distinction and consent boundary", () => {
    renderPage();
    expect(
      screen.getByRole("heading", { name: "AI providers", level: 1 }),
    ).toBeVisible();
    expect(screen.getAllByText("OpenAI household").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Home Ollama").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Local").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Remote/cloud").length).toBeGreaterThan(0);
    expect(screen.getByText("Data consent on")).toBeVisible();
    expect(
      screen.getByText(/Configuring a cloud API key/).closest("p")?.textContent,
    ).toContain("authorize sending household");
    expect(screen.getAllByText("Vision").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Rotate credentials" })).toBeVisible();
  });

  it("adds a local Ollama provider without a cloud consent control", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Add provider" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText("Provider"), "ollama");
    expect(within(dialog).queryByText(/consent to sending household data/i)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Base URL")).toHaveValue(
      "http://host.docker.internal:11434",
    );
    expect(within(dialog).getByText("Enable this provider")).toBeVisible();
  });

  it("requires consent when an Ollama endpoint is not local", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Add provider" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Provider", { exact: true }),
      "ollama",
    );
    await userEvent.clear(within(dialog).getByLabelText("Base URL"));
    await userEvent.type(
      within(dialog).getByLabelText("Base URL"),
      "https://ollama.example.com",
    );
    expect(
      within(dialog).getByText(/I consent to sending household data/i),
    ).toBeVisible();
    expect(
      within(dialog).getByText(/This endpoint is not on the Housetory host/i),
    ).toBeVisible();
  });

  it("saves a task-specific model through the task defaults form", async () => {
    vi.mocked(api.put).mockResolvedValue({
      ...task("assistant", "provider-openai", "gpt-4o-mini"),
    });
    renderPage();
    const input = screen.getByLabelText("General assistant model");
    await userEvent.clear(input);
    await userEvent.type(input, "gpt-4o-mini");
    const row = input.closest("div.grid") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/ai/tasks/assistant",
        expect.objectContaining({ model: "gpt-4o-mini", enabled: true }),
      ),
    );
  });
});
