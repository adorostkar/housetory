import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { DocumentExtractionReview } from "@/components/document-extraction-review";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queries";
import type {
  AiStatus,
  DocumentRecord,
  ExtractionApplyResponse,
  ExtractionRefinement,
  ExtractionReview,
} from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const room = {
  id: "room-1",
  name: "Office",
  description: null,
  parent_id: null,
  sort_order: 0,
  item_count: 1,
  location_count: 1,
  total_item_count: 1,
  total_location_count: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const location = {
  id: "location-1",
  room_id: "room-1",
  parent_id: null,
  name: "Drill box",
  description: null,
  kind: "box",
  is_container: true,
  container_type: "box",
  identifier: "BOX-001",
  label_generated_at: null,
  sort_order: 0,
  item_count: 1,
  total_item_count: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const aiStatus: AiStatus = {
  provider: "ollama",
  mode: "local",
  model: "document-model",
  configured: true,
  available: true,
  catalog_checked: false,
  catalog_count: 0,
  cloud_enabled: false,
  cloud_consent: false,
  data_leaves_server: false,
  error: null,
  privacy_note: "Local model",
};

const document: DocumentRecord = {
  id: "document-1",
  title: "Corner Hardware receipt",
  document_type: "receipt",
  original_filename: "receipt.pdf",
  content_type: "application/pdf",
  original_content_type: "application/pdf",
  byte_size: 1000,
  original_byte_size: 1000,
  document_date: null,
  merchant: null,
  notes: null,
  extracted_text: "CORNER HARDWARE\nCordless Drill 2 x 79.99 159.98",
  extracted_metadata: {},
  ocr_status: "succeeded",
  ocr_error: null,
  ocr_confidence: 90,
  ocr_processed_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  items: [],
  item_count: 0,
  pages: [],
  page_count: 0,
  url: "/api/v1/documents/document-1/file",
  original_url: "/api/v1/documents/document-1/original",
};

const review: ExtractionReview = {
  document_id: "document-1",
  version: "version-1",
  source_artifact: "original",
  document_type: "receipt",
  generated_at: "2026-01-01T00:00:00Z",
  purchase_eligible: true,
  fields: {
    merchant: "CORNER HARDWARE",
    purchase_date: "2026-02-14",
    document_date: "2026-02-14",
    currency: "USD",
    total_cents: 18844,
    subtotal_cents: 17448,
    tax_cents: 1396,
    discount_cents: 1000,
    shipping_cents: null,
    order_number: "INV-9001",
    brand: null,
    model: null,
    serial_numbers: ["SN-123"],
    warranty_provider: "Makita",
    warranty_start: "2026-02-14",
    warranty_end: null,
    warranty_months: 12,
    field_sources: { merchant: "CORNER HARDWARE", total_cents: "Total 188.44" },
    uncertain_fields: ["merchant"],
  },
  warnings: ["Tax, discount and shipping lines are kept separate."],
  lines: [
    {
      id: "line-1",
      line_number: 2,
      kind: "product",
      description: "Cordless Drill",
      quantity: 2,
      unit_price_cents: 7999,
      line_total_cents: 15998,
      evidence: {
        page: null,
        line_number: 2,
        text: "Cordless Drill 2 x 79.99 159.98",
      },
      warnings: [],
      purchase_eligible: true,
    },
    {
      id: "line-2",
      line_number: 3,
      kind: "tax",
      description: "Tax",
      quantity: null,
      unit_price_cents: null,
      line_total_cents: 1396,
      evidence: { page: null, line_number: 3, text: "Tax 13.96" },
      warnings: [],
      purchase_eligible: false,
    },
  ],
  matches: [
    {
      line_id: "line-1",
      quality: "exact_identifier",
      reasons: ["serial number matches SN-123"],
      candidates: [
        {
          id: "item-1",
          name: "Cordless Drill",
          brand: "Makita",
          model: "XPH12",
          serial_number: "SN-123",
          quantity: 1,
          on_loan_quantity: 0,
          room_name: "Office",
          location_name: "Drill box",
          purchase: null,
          warranty: null,
          reasons: ["serial number matches SN-123", "brand matches Makita"],
          match_quality: "exact_identifier",
          exact_identifier: true,
        },
      ],
    },
  ],
  duplicate_documents: [],
  applied: [],
  ai_status: aiStatus,
};

const applied: ExtractionApplyResponse = {
  document: { ...document, merchant: "Corner Hardware" },
  request_id: "request-1",
  created_item_ids: ["item-new"],
  updated_item_ids: ["item-1"],
  linked_item_ids: ["item-1"],
  skipped_line_ids: [],
  purchase_id: "purchase-1",
  warranty_item_ids: [],
  warnings: ["Tax evidence is not allocated to product lines."],
  applied_at: "2026-01-01T00:00:00Z",
  items: [{ id: "item-1", name: "Cordless Drill" }],
};

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => true,
    useInvalidateInventory: () => vi.fn(),
    useRooms: () => ({ data: { items: [room] } }),
    useLocations: () => ({ data: { items: [location] } }),
    useItems: () => ({
      data: { pages: [{ items: [review.matches[0]!.candidates[0]], total: 1, limit: 20, offset: 0 }] },
      isPending: false,
    }),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), post: vi.fn() },
  };
});

async function renderReview(client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  }), open = true) {
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DocumentExtractionReview document={document} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  if (open) await userEvent.click(await screen.findByRole("button", { name: "Review extraction" }));
  return result;
}

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockResolvedValue(review);
  vi.mocked(api.post).mockImplementation(async (path) => {
    if (path.endsWith("/extraction/matches")) {
      return {
        document_id: "document-1",
        version: "version-1",
        matches: review.matches,
        ai_status: aiStatus,
        ai_used: true,
        warnings: [],
      };
    }
    return applied;
  });
});

describe("DocumentExtractionReview", () => {
  it("starts compact with warning indicators and preserves edits when hidden", async () => {
    await renderReview(undefined, false);
    expect(await screen.findByText("Review warnings")).toBeVisible();
    expect(screen.queryByLabelText(/^Merchant/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review extraction" }));
    await userEvent.clear(screen.getByLabelText(/^Merchant/));
    await userEvent.type(screen.getByLabelText(/^Merchant/), "Manual shop");
    await userEvent.click(screen.getByRole("button", { name: "Hide extraction" }));
    expect(screen.getByDisplayValue("Manual shop")).not.toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Review extraction" }));
    expect(screen.getByDisplayValue("Manual shop")).toBeVisible();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("keeps a failed dismissal visible and allows retry without changing the draft", async () => {
    const suggested: ExtractionRefinement = {
      document_id: document.id, base_version: review.version, version: "suggested",
      source_artifact: "original", generated_at: review.generated_at,
      fields: { ...review.fields, merchant: "AI shop" }, lines: review.lines,
      warnings: [], matches: review.matches, ai_status: aiStatus, ai_used: true,
    };
    vi.mocked(api.get).mockResolvedValue({
      ...review,
      enhancement: { status: "ready", reason: null, error: null },
      suggested_refinement: suggested,
    });
    vi.mocked(api.post).mockRejectedValue(new Error("Dismissal failed"));
    await renderReview();
    await userEvent.clear(screen.getByLabelText(/^Merchant/));
    await userEvent.type(screen.getByLabelText(/^Merchant/), "Manual shop");
    await userEvent.click(screen.getByRole("button", { name: "Review AI suggestions" }));
    await userEvent.click(screen.getByRole("button", { name: "Reject AI suggestion" }));
    expect(await screen.findByText("Dismissal failed")).toBeVisible();
    expect(toast.error).toHaveBeenCalledWith("Dismissal failed");
    expect(screen.getByText("AI refinement proposal")).toBeVisible();
    expect(screen.getByDisplayValue("Manual shop")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reject AI suggestion" })).toBeEnabled();
  });

  it("reports an explicit identical result as complete without proposing or applying it", async () => {
    const completed = {
      ...review,
      enhancement: { status: "skipped" as const, reason: "no_changes", error: null },
    };
    vi.mocked(api.post).mockImplementation(async () => {
      vi.mocked(api.get).mockResolvedValue(completed);
      return {
        document_id: document.id, base_version: review.version, version: review.version,
        source_artifact: "original", generated_at: review.generated_at,
        fields: review.fields, lines: review.lines, warnings: [],
        matches: review.matches, ai_status: aiStatus, ai_used: false,
      };
    });
    await renderReview();
    await userEvent.click(screen.getAllByRole("button", { name: "Refine fields & lines" })[0]!);
    expect(await screen.findByText("AI review complete · no changes")).toBeVisible();
    expect(screen.queryByText("AI refinement proposal")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review AI suggestions" })).not.toBeInTheDocument();
    expect(api.post).toHaveBeenCalledExactlyOnceWith(
      "/documents/document-1/extraction/refine", {},
    );
    expect(screen.getByDisplayValue("CORNER HARDWARE")).toBeVisible();
  });

  it.each([
    ["off", null, "AI off"],
    ["failed", "read_timeout", "AI timed out · local results kept"],
    ["skipped", "cancelled", "AI suggestions cancelled"],
  ] as const)("keeps local review usable when enhancement is %s", async (status, reason, label) => {
    vi.mocked(api.get).mockResolvedValue({
      ...review,
      enhancement: {
        status, reason, job_id: "job-1", version: review.version, error: null,
        provider: "ollama", model: "test", ai_attempted: status !== "off", ai_succeeded: false,
      },
    } satisfies ExtractionReview);
    await renderReview();
    expect(await screen.findByText(label)).toBeVisible();
    expect(screen.getByDisplayValue("CORNER HARDWARE")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply reviewed changes" })).toBeVisible();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("announces a delayed suggestion without replacing or applying manual edits", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await renderReview(client);
    await screen.findByText("Product lines");
    const merchant = screen.getByLabelText(/^Merchant/);
    await userEvent.clear(merchant);
    await userEvent.type(merchant, "Manual shop");
    const refinement: ExtractionRefinement = {
      document_id: document.id, base_version: review.version, version: "automatic-refinement",
      source_artifact: "original", generated_at: review.generated_at,
      fields: { ...review.fields, merchant: "AI shop" }, lines: review.lines,
      warnings: [], matches: review.matches, ai_status: aiStatus, ai_used: true,
    };
    act(() => client.setQueryData([...queryKeys.document(document.id), "extraction"], {
      ...review,
      enhancement: {
        status: "ready", job_id: "job-1", version: review.version, reason: null,
        error: null, provider: "ollama", model: "test", ai_attempted: true, ai_succeeded: true,
      },
      suggested_refinement: refinement,
    } satisfies ExtractionReview));
    expect(await screen.findByText("AI suggestions available")).toBeVisible();
    expect(screen.queryByText("AI refinement proposal")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review AI suggestions" }));
    expect(screen.getByRole("button", { name: "Accept AI refinement" })).toBeVisible();
    expect(screen.getByDisplayValue("Manual shop")).toBeVisible();
    expect(api.post).not.toHaveBeenCalled();
    const dismissed = { ...review, enhancement: {
      status: "skipped" as const, reason: "cancelled", job_id: "job-1", version: review.version,
      error: null, provider: "ollama", model: "test", ai_attempted: true, ai_succeeded: true,
    }, suggested_refinement: null };
    vi.mocked(api.post).mockResolvedValue(dismissed);
    vi.mocked(api.get).mockResolvedValue(dismissed);
    await userEvent.click(screen.getByRole("button", { name: "Reject AI suggestion" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/documents/document-1/extraction/enhancement/cancel",
    ));
    expect(screen.getByDisplayValue("Manual shop")).toBeVisible();
    await waitFor(() => expect(screen.queryByText("AI refinement proposal")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Review AI suggestions" })).not.toBeInTheDocument();
    await act(async () => { await client.invalidateQueries({
      queryKey: [...queryKeys.document(document.id), "extraction"],
    }); });
    expect(screen.queryByRole("button", { name: "Review AI suggestions" })).not.toBeInTheDocument();
  });

  it("shows line items, matches, charges and applies edited values and choices", async () => {
    await renderReview();
    expect(await screen.findByText("Product lines")).toBeVisible();
    expect(screen.getByDisplayValue("Cordless Drill")).toBeVisible();
    expect(screen.getByText("Identifier verified")).toBeVisible();
    expect(screen.getByText(/serial number matches SN-123/)).toBeVisible();
    expect(screen.getByText(/Tax, discount and shipping/)).toBeVisible();
    expect(screen.getByText(/not allocated to products/)).toBeVisible();

    const merchant = screen.getByLabelText(/^Merchant/);
    await userEvent.clear(merchant);
    await userEvent.type(merchant, "Edited Shop");
    const quantity = screen.getByLabelText(/^Qty/);
    await userEvent.clear(quantity);
    await userEvent.type(quantity, "3");
    await userEvent.click(screen.getByRole("button", { name: "Apply reviewed changes" }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/documents/document-1/extraction/apply",
        expect.objectContaining({
          extraction_version: "version-1",
          document_fields: {
            merchant: "Edited Shop",
            document_date: "2026-02-14",
          },
          purchase_action: "create",
          lines: [
            expect.objectContaining({
              line_id: "line-1",
              action: "link",
              item_id: "item-1",
              quantity: 3,
            }),
          ],
        }),
      ),
    );
    expect(await screen.findByText("Applied")).toBeVisible();
  });

  it("creates a new item with an explicit room and optional warranty", async () => {
    await renderReview();
    await screen.findByText("Product lines");
    await userEvent.click(screen.getByRole("button", { name: "Create new item" }));
    await userEvent.selectOptions(screen.getByLabelText("Destination room"), "room-1");
    await userEvent.selectOptions(
      screen.getByLabelText("Optional container"),
      "location-1",
    );
    await userEvent.click(screen.getByRole("checkbox", { name: /Apply extracted warranty evidence/ }));
    await userEvent.click(screen.getByRole("button", { name: "Apply reviewed changes" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/documents/document-1/extraction/apply",
        expect.objectContaining({
          lines: [
            expect.objectContaining({
              line_id: "line-1",
              action: "create",
              new_item: expect.objectContaining({
                name: "Cordless Drill",
                quantity: 2,
                room_id: "room-1",
                storage_location_id: "location-1",
              }),
              warranty: expect.objectContaining({
                provider: "Makita",
                duration_months: 12,
              }),
            }),
          ],
        }),
      ),
    );
  });

  it("re-ranks supplied candidates through the optional AI action", async () => {
    await renderReview();
    await screen.findByText("Product lines");
    await userEvent.click(
      screen.getAllByRole("button", { name: "Re-rank matches" })[0]!,
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/documents/document-1/extraction/matches",
        expect.objectContaining({ use_ai: true }),
      ),
    );
  });

  it("shows AI field/line refinement separately and only applies it after acceptance", async () => {
    const refinement: ExtractionRefinement = {
      document_id: "document-1",
      base_version: "version-1",
      version: "refined-version-1",
      source_artifact: "original",
      generated_at: "2026-01-01T00:00:00Z",
      fields: {
        ...review.fields,
        merchant: "Corner Hardware AI",
        total_cents: 18844,
      },
      lines: [
        {
          ...review.lines[0]!,
          id: "refined-line-1",
          description: "Cordless Drill XPH12",
          evidence: {
            ...review.lines[0]!.evidence,
            text: "Cordless Drill XPH12 2 x 79.99 159.98",
          },
        },
      ],
      warnings: ["AI proposal requires review."],
      matches: [
        {
          ...review.matches[0]!,
          line_id: "refined-line-1",
        },
      ],
      ai_status: aiStatus,
      ai_used: true,
    };
    vi.mocked(api.post).mockImplementation(async (path) => {
      if (path.endsWith("/extraction/refine")) return refinement;
      return applied;
    });
    await renderReview();
    await screen.findByText("Product lines");
    await userEvent.click(
      screen.getAllByRole("button", { name: "Refine fields & lines" })[0]!,
    );
    expect(await screen.findByText("AI refinement proposal")).toBeVisible();
    expect(screen.getAllByText("AI proposal requires review.")[0]).toBeVisible();
    expect(screen.getByDisplayValue("CORNER HARDWARE")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Accept AI refinement" }));
    expect(screen.getByText("AI-refined proposal")).toBeVisible();
    expect(screen.getByDisplayValue("Corner Hardware AI")).toBeVisible();
    expect(screen.getByDisplayValue("Cordless Drill XPH12")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Apply reviewed changes" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/documents/document-1/extraction/apply",
        expect.objectContaining({
          extraction_version: "refined-version-1",
          lines: [
            expect.objectContaining({
              line_id: "refined-line-1",
              action: "link",
              item_id: "item-1",
            }),
          ],
        }),
      ),
    );
  });
});
