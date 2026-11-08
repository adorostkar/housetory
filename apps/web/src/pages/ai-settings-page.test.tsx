import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiSettingsPage } from "@/pages/ai-settings-page";
import { api } from "@/lib/api";
import type { AiProviderModel, AiProviderRecord, AiSettings, AiTaskSetting } from "@/lib/types";

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
    task("transcription", "provider-openai", "gpt-4o"),
  ],
  default_text: {
    provider_id: "provider-openai",
    provider_label: "OpenAI household",
    model: "gpt-4o",
    model_label: "GPT-4o",
    model_listed: true,
    compatibility: "compatible",
    configured: true,
    inherited_tasks: ["assistant", "documents", "imports", "search"],
    override_tasks: [],
    derived_from: "common",
  },
};

function providerModel(
  id: string,
  displayName: string,
  kind: AiProviderModel["kind"] = "chat",
  capabilities: string[] = ["text"],
): AiProviderModel {
  return {
    id,
    display_name: displayName,
    kind,
    capabilities,
    capability_source: "heuristic",
  };
}

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

let settingsData: AiSettings = settings;

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useSession: () => ({
      data: { role: "owner", authenticated: true },
      isPending: false,
    }),
    useAiSettings: () => ({
      data: settingsData,
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
      get: vi.fn(),
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
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AiSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  settingsData = settings;
  vi.mocked(api.get).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
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
    const client = renderPage();
    client.setQueryData(["ai", "status", "assistant"], { available: true });
    await userEvent.click(
      screen.getByText("Advanced task overrides"),
    );
    const input = screen.getByLabelText("Assistant model");
    await userEvent.click(input);
    await userEvent.type(input, "gpt-4o-mini{Enter}");
    const row = input.closest("div.grid") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/ai/tasks/assistant",
        expect.objectContaining({ model: "gpt-4o-mini", enabled: true }),
      ),
    );
    await waitFor(() =>
      expect(
        client.getQueryState(["ai", "status", "assistant"])?.isInvalidated,
      ).toBe(true),
    );
  });

  it("requires explicit confirmation before a live task test", async () => {
    vi.mocked(api.post).mockResolvedValue({
      task: "assistant",
      status: "passed",
      message: "The model returned the expected structured test response.",
      tested_at: "2026-11-06T12:00:00Z",
      model: "gpt-4o",
      provider_label: "OpenAI household",
    });
    renderPage();
    await userEvent.click(
      screen.getByText("Advanced task overrides"),
    );
    const label = screen.getByText("Assistant");
    const row = label.closest("div.grid") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Test" }));
    expect(
      screen.getByRole("heading", { name: "Run a live task test?" }),
    ).toBeVisible();
    expect(api.post).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Run test" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/ai/tasks/assistant/test", {
        confirm: true,
      }),
    );
  });

  it("saves a new provider, discovers models and chooses a default without a known ID", async () => {
    const created: AiProviderRecord = {
      ...settings.providers[0]!,
      id: "provider-new",
      display_name: "New OpenAI",
      default_model: null,
      api_key_version: 1,
    };
    vi.mocked(api.post).mockResolvedValue(created);
    vi.mocked(api.get).mockResolvedValue({
      provider_id: created.id,
      models: [
        providerModel("gpt-4o", "GPT-4o", "chat", [
          "text",
          "vision",
          "structured",
          "tools",
        ]),
        providerModel("text-embedding-3-small", "Embedding", "embedding", []),
      ],
      error: null,
      cached: false,
    });
    vi.mocked(api.patch).mockResolvedValue({
      ...created,
      default_model: "gpt-4o",
    });
    const client = renderPage();
    client.setQueryData(["ai", "status", "assistant"], { available: false });
    await userEvent.click(screen.getByRole("button", { name: "Add provider" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.clear(within(dialog).getByLabelText("Display name"));
    await userEvent.type(within(dialog).getByLabelText("Display name"), "New OpenAI");
    await userEvent.type(within(dialog).getByLabelText("API key"), "sk-new-secret");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Save provider & discover models/ }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/ai/providers",
        expect.objectContaining({
          provider: "openai",
          default_model: null,
          api_key: "sk-new-secret",
        }),
      ),
    );
    await waitFor(() =>
      expect(
        client.getQueryState(["ai", "status", "assistant"])?.isInvalidated,
      ).toBe(true),
    );
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        "/ai/providers/provider-new/models?refresh=true",
      ),
    );
    const defaultModel = await within(dialog).findByRole("combobox", {
      name: "Default model",
    });
    await userEvent.click(defaultModel);
    await userEvent.click(
      within(dialog).getByRole("option", { name: /GPT-4o/ }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Save selected model/ }),
    );
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/ai/providers/provider-new", {
        default_model: "gpt-4o",
      }),
    );
  });

  it("discovers models when editing with a saved key and keeps the key write-only", async () => {
    const modelCatalog = {
      provider_id: settings.providers[0]!.id,
      models: [
        providerModel("gpt-4o", "GPT-4o"),
        providerModel("gpt-4o-mini", "GPT-4o mini"),
      ],
      error: null,
      cached: false,
    };
    vi.mocked(api.get).mockResolvedValue(modelCatalog);
    vi.mocked(api.patch).mockResolvedValue({
      ...settings.providers[0]!,
      default_model: "gpt-4o-mini",
    });
    renderPage();
    const providerCards = screen.getAllByRole("article");
    await userEvent.click(
      within(providerCards[0]!).getByRole("button", { name: "Edit provider" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText(/API key/)).toHaveValue("");
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        "/ai/providers/provider-openai/models",
      ),
    );
    const defaultModel = await within(dialog).findByRole("combobox", {
      name: "Default model",
    });
    await userEvent.click(defaultModel);
    await userEvent.click(
      within(dialog).getByRole("option", { name: /GPT-4o mini/ }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Save selected model/ }),
    );
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/ai/providers/provider-openai", {
        default_model: "gpt-4o-mini",
      }),
    );
    expect(vi.mocked(api.patch).mock.calls[0]?.[1]).not.toHaveProperty("api_key");
  });

  it("shows one default text model and hides advanced overrides by default", async () => {
    renderPage();
    expect(
      screen.getByRole("heading", { name: "Default text model" }),
    ).toBeVisible();
    expect(screen.getByText(/Inherited:/)).toHaveTextContent(
      "Assistant, Document interpretation, Smart imports, Natural-language search",
    );
    expect(screen.getByText("Advanced task overrides")).toBeVisible();
    expect(screen.queryByLabelText("Assistant model")).not.toBeVisible();
  });

  it("saves the default text route without touching advanced overrides", async () => {
    const withOverride: AiSettings = {
      ...settings,
      tasks: settings.tasks.map((entry) =>
        entry.task === "documents"
          ? { ...entry, model: "o3-mini" }
          : entry,
      ),
      default_text: {
        ...settings.default_text!,
        override_tasks: ["documents"],
      },
    };
    settingsData = withOverride;
    vi.mocked(api.put).mockResolvedValue(withOverride);
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Save default" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/ai/default-text", {
        provider_id: "provider-openai",
        model: "gpt-4o",
      }),
    );
    expect(screen.getByText(/Custom overrides:/)).toHaveTextContent(
      "Document interpretation",
    );
  });

  it("resets a custom text override back to the effective default", async () => {
    const withOverride: AiSettings = {
      ...settings,
      tasks: settings.tasks.map((entry) =>
        entry.task === "documents"
          ? { ...entry, model: "o3-mini" }
          : entry,
      ),
      default_text: {
        ...settings.default_text!,
        override_tasks: ["documents"],
      },
    };
    settingsData = withOverride;
    vi.mocked(api.put).mockResolvedValue({
      ...task("documents", "provider-openai", "gpt-4o"),
    });
    renderPage();
    await userEvent.click(screen.getByText("Advanced task overrides"));
    await userEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/ai/tasks/documents", {
        provider_id: "provider-openai",
        model: "gpt-4o",
        enabled: true,
      }),
    );
  });

  it("clears a task model and discovers the new provider catalog on provider switch", async () => {
    vi.mocked(api.get).mockResolvedValue({
      provider_id: "provider-ollama",
      models: [providerModel("llava", "LLaVA", "chat", ["text", "vision"])],
      error: null,
      cached: false,
    });
    renderPage();
    await userEvent.click(
      screen.getByText("Advanced task overrides"),
    );
    const providerSelect = screen.getByLabelText("Assistant provider");
    await userEvent.selectOptions(providerSelect, "provider-ollama");
    const modelInput = screen.getByLabelText("Assistant model");
    expect(modelInput).toHaveValue("");
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith("/ai/providers/provider-ollama/models"),
    );
    await userEvent.click(modelInput);
    expect(screen.getByRole("option", { name: /LLaVA/ })).toBeVisible();
  });
});
