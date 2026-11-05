import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ItemManuals } from "@/components/item-manuals";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queries";
import type {
  DocumentRecord,
  ItemDetail,
  ItemManuals as ItemManualsData,
  ManualAnswer,
  ManualCandidateList,
  ManualDownloadResult,
  ManualOnlineAnswer,
  ManualProfile,
  SessionState,
} from "@/lib/types";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
    },
  };
});

const item: ItemDetail = {
  id: "item-1",
  name: "Cordless drill",
  description: null,
  brand: "Makita",
  model: "DCD791",
  quantity: 1,
  condition: "good",
  is_archived: false,
  room: null,
  location: null,
  location_path: [],
  category: null,
  tags: [],
  primary_photo: null,
  purchase: null,
  purchase_info_status: "unrecorded",
  purchase_info_missing_fields: [],
  warranty: null,
  current_value_cents: null,
  current_value_currency: "USD",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  serial_number: null,
  photos: [],
  documents: [],
  import_source: null,
};

const manualDocument: DocumentRecord = {
  id: "document-1",
  title: "DCD791 instruction manual",
  document_type: "manual",
  original_filename: "dcd791.pdf",
  content_type: "application/pdf",
  original_content_type: "application/pdf",
  byte_size: 4096,
  original_byte_size: 4096,
  document_date: null,
  merchant: "Makita",
  notes: null,
  extracted_text: "Safety. Unplug before changing the bit.",
  extracted_metadata: { ocr_page_count: 12 },
  ocr_status: "succeeded",
  ocr_error: null,
  ocr_confidence: 90,
  ocr_processed_at: "2026-01-01T01:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  items: [{ id: item.id, name: item.name }],
  item_count: 1,
  pages: [],
  page_count: 0,
  url: "/api/v1/documents/document-1/file",
  original_url: "/api/v1/documents/document-1/original",
};

const profile: ManualProfile = {
  id: "profile-1",
  item_id: item.id,
  manufacturer: "Makita",
  model_identifier: "DCD791",
  variant: null,
  confirmed_at: "2026-01-02T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

function manualsData(overrides: Partial<ItemManualsData> = {}): ItemManualsData {
  return {
    item_id: item.id,
    manuals: [manualDocument],
    search: {
      configured: false,
      provider_label: null,
      reason: "Online manual search is not configured.",
      profile: null,
      can_search: false,
    },
    ...overrides,
  };
}

function session(role: SessionState["role"] = "owner"): SessionState {
  return {
    authenticated: true,
    setup_required: false,
    user: { id: "user-1", name: "Ada", email: "ada@example.com", created_at: "2026-01-01" },
    household: { id: "household-1", name: "Ada's Home", warranty_reminder_days: 30 },
    role,
  };
}

function renderManuals(data: ItemManualsData, role: SessionState["role"] = "owner") {
  activeManuals = data;
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  client.setQueryData(queryKeys.session, session(role));
  client.setQueryData(queryKeys.itemManuals(item.id), data);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ItemManuals item={item} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

function answer(overrides: Partial<ManualAnswer> = {}): ManualAnswer {
  return {
    item_id: item.id,
    item_name: item.name,
    answer: "Unplug the drill before changing the bit.",
    mode: "extractive",
    citations: [
      {
        document_id: manualDocument.id,
        document_title: manualDocument.title,
        page: 7,
        section: null,
        excerpt: "Unplug the drill before changing the drill bit.",
        url: "/api/v1/documents/document-1/file#page=7",
      },
    ],
    manuals: [
      {
        id: manualDocument.id,
        title: manualDocument.title,
        url: manualDocument.url,
        ocr_status: "succeeded",
      },
    ],
    notices: ["Page-level text is available for this manual."],
    ai_status: {
      provider: "none",
      mode: "disabled",
      model: null,
      configured: false,
      available: false,
      catalog_checked: false,
      catalog_count: 0,
      cloud_enabled: false,
      cloud_consent: false,
      data_leaves_server: false,
      error: null,
      privacy_note: "AI is optional.",
    },
    source_kind: "attached_manual",
    ...overrides,
  };
}

let activeManuals = manualsData();

beforeEach(() => {
  activeManuals = manualsData();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.includes("/manual-search")) {
      return { item_id: item.id, candidates: [], notices: [] };
    }
    if (path.includes("/manuals")) return activeManuals;
    return { items: [], total: 0, limit: 100, offset: 0 };
  });
  vi.mocked(api.post).mockReset();
  vi.mocked(api.put).mockReset();
});

describe("ItemManuals", () => {
  it("shows attached manuals and renders grounded answers with real citations", async () => {
    renderManuals(manualsData());
    expect(screen.getByText("DCD791 instruction manual")).toBeVisible();
    expect(screen.getByText("12 pages")).toBeVisible();
    expect(screen.getByText(/Exact make\/model is not confirmed/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Add manual" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Find manual" })).toBeVisible();

    vi.mocked(api.post).mockResolvedValue(answer());
    await userEvent.click(screen.getByRole("button", { name: "Ask about this item" }));
    await userEvent.type(screen.getByLabelText("Question"), "How do I change the bit?");
    await userEvent.click(screen.getByRole("button", { name: "Ask attached manuals" }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`/items/${item.id}/manual-questions`, {
        question: "How do I change the bit?",
      }),
    );
    expect(await screen.findByText("Page 7")).toBeVisible();
    expect(screen.getByText(/Unplug the drill before changing the drill bit/)).toBeVisible();
    expect(screen.getByText("Extracted from manual text")).toBeVisible();
    expect(screen.getByRole("link", { name: /Page 7/ })).toHaveAttribute(
      "href",
      "/api/v1/documents/document-1/file#page=7",
    );
  });

  it("keeps no-AI and unconfigured online states honest", async () => {
    renderManuals(manualsData());
    vi.mocked(api.post).mockResolvedValue(
      answer({
        answer: "The attached manuals do not contain a matching passage.",
        mode: "no_evidence",
        citations: [],
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Ask about this item" }));
    await userEvent.type(screen.getByLabelText("Question"), "What is the charger warranty?");
    await userEvent.click(screen.getByRole("button", { name: "Ask attached manuals" }));
    expect(await screen.findByText("No matching manual evidence")).toBeVisible();
    expect(
      screen.getByText(/AI assistance is optional and not configured/),
    ).toBeVisible();
    expect(screen.queryByText("Ask configured online sources")).not.toBeInTheDocument();
  });

  it("requires deliberate identity confirmation before online search", async () => {
    renderManuals(
      manualsData({
        search: {
          configured: true,
          provider_label: "Test search",
          reason: null,
          profile: null,
          can_search: false,
        },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Find manual" }));
    expect(screen.getByRole("button", { name: "Search for exact model" })).toBeDisabled();
    expect(
      screen.getByText(/Confirm the exact product identity above before searching online/),
    ).toBeVisible();

    await userEvent.clear(screen.getByLabelText("Manufacturer"));
    await userEvent.type(screen.getByLabelText("Manufacturer"), "Makita");
    await userEvent.clear(screen.getByLabelText("Complete model identifier"));
    await userEvent.type(screen.getByLabelText("Complete model identifier"), "DCD791");
    const confirm = screen.getByRole("checkbox");
    expect(screen.getByRole("button", { name: "Save confirmed identity" })).toBeDisabled();
    await userEvent.click(confirm);
    vi.mocked(api.put).mockResolvedValue(profile);
    await userEvent.click(screen.getByRole("button", { name: "Save confirmed identity" }));

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(`/items/${item.id}/manual-profile`, {
        manufacturer: "Makita",
        model_identifier: "DCD791",
        variant: null,
        confirmed: true,
      }),
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it("searches only after confirmation, then requires candidate review before saving", async () => {
    renderManuals(
      manualsData({
        search: {
          configured: true,
          provider_label: "Test search",
          reason: null,
          profile,
          can_search: true,
        },
      }),
    );
    const candidate: ManualCandidateList["candidates"][number] = {
      id: "candidate-1",
      item_id: item.id,
      title: "Makita DCD791 instruction manual",
      source_url: "https://www.makita.example/DCD791",
      file_url: "https://www.makita.example/DCD791.pdf",
      publisher: "Makita",
      language: "en",
      source_type: "manufacturer",
      model_coverage: ["DCD791"],
      snippet: "Exact model coverage.",
      retrieved_at: "2026-01-03T00:00:00Z",
      document_id: null,
      created_at: "2026-01-03T00:00:00Z",
    };
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (path === `/items/${item.id}/manual-search`) {
        return { item_id: item.id, candidates: [candidate], notices: [] };
      }
      if (path === `/items/${item.id}/manual-search/candidate-1/download`) {
        return {
          document: manualDocument,
          candidate: { ...candidate, document_id: manualDocument.id },
          duplicate_documents: [],
        } satisfies ManualDownloadResult;
      }
      throw new Error(`Unexpected POST ${path}`);
    });

    await userEvent.click(screen.getByRole("button", { name: "Find manual" }));
    await userEvent.click(screen.getByRole("button", { name: "Search for exact model" }));
    expect(await screen.findByText("Makita DCD791 instruction manual")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Review & download" }));
    expect(
      screen.getByText(/I reviewed this candidate and verified that it covers/),
    ).toBeVisible();
    const confirm = screen.getByRole("checkbox");
    await userEvent.click(confirm);
    await userEvent.click(screen.getByRole("button", { name: /Download & attach/ }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/items/${item.id}/manual-search/candidate-1/download`,
        expect.objectContaining({
          confirm_model: true,
          request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
      ),
    );
  });

  it("offers an explicit online question only when a profile and search are configured", async () => {
    renderManuals(
      manualsData({
        search: {
          configured: true,
          provider_label: "Test search",
          reason: null,
          profile,
          can_search: true,
        },
      }),
    );
    const onlineAnswer: ManualOnlineAnswer = {
      item_id: item.id,
      answer: "The manufacturer lists an 18 V battery.",
      mode: "extractive",
      citations: [
        {
          title: "Makita DCD791 battery specification",
          url: "https://www.makita.example/DCD791",
          publisher: "Makita",
          language: "en",
          source_type: "manufacturer",
          excerpt: "18 V LXT battery.",
        },
      ],
      notices: [],
      ai_status: answer().ai_status,
      source_kind: "online",
    };
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (path.endsWith("/manual-questions/online")) return onlineAnswer;
      return answer({
        answer: "The attached manuals do not contain a matching passage.",
        mode: "no_evidence",
        citations: [],
      });
    });
    await userEvent.click(screen.getByRole("button", { name: "Ask about this item" }));
    await userEvent.type(screen.getByLabelText("Question"), "What battery does it use?");
    await userEvent.click(screen.getByRole("button", { name: "Ask attached manuals" }));
    expect(await screen.findByText("No matching manual evidence")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Review online request" }));
    expect(
      screen.getByText(/Borrower, loan and household data are never included/),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Send online question" }));
    expect(await screen.findByText("18 V LXT battery.")).toBeVisible();
    expect(screen.getByText("Online sources")).toBeVisible();
    expect(screen.getByRole("link", { name: /Makita DCD791 battery specification/ })).toHaveAttribute(
      "href",
      "https://www.makita.example/DCD791",
    );
  });

  it("keeps write actions out of viewers' reach while leaving manual questions readable", () => {
    renderManuals(manualsData(), "viewer");
    expect(screen.getByRole("button", { name: "Ask about this item" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add manual" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Find manual" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Attach existing" }),
    ).not.toBeInTheDocument();
  });
});
