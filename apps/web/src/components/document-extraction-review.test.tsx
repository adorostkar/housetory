import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { DocumentExtractionReview } from "@/components/document-extraction-review";
import { DocumentProcessingStatus } from "@/components/document-processing-status";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queries";
import type {
  AiStatus,
  DocumentCaptureContext,
  DocumentProcessing,
  DocumentRecord,
  ExtractionApplyResponse,
  ExtractionRefinement,
  ExtractionReview,
} from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

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

const readyProcessing: DocumentProcessing = {
  correlation_id: "attempt-1", stage: "ready",
  started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:01Z",
  elapsed_ms: 1000, local_available: true, can_cancel: false, can_retry: true,
  worker_available: true, reason: null,
  timings: { local_queue_ms: 1, local_processing_ms: 2, ai_queue_ms: 3, provider_ms: 4, validation_ms: 5 },
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
  }), open = true, captureContext?: DocumentCaptureContext, processing = false) {
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {processing && <DocumentProcessingStatus documentId={document.id} onManualReview={vi.fn()} />}
        <DocumentExtractionReview document={document} captureContext={captureContext} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  if (open) await userEvent.click(await screen.findByRole("button", { name: "Review extraction" }));
  return result;
}

beforeEach(() => {
  vi.mocked(toast.message).mockClear();
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
  it.each([
    ["interpret", "Refine fields & lines"],
    ["matches", "Re-rank matches"],
  ] as const)("queues bounded %s work, prevents duplicates and keeps edited review usable through cancellation", async (operation, label) => {
    let processing = readyProcessing;
    let extraction = review;
    vi.mocked(api.get).mockImplementation(async (path) =>
      path.endsWith("/processing") ? processing : extraction);
    vi.mocked(api.post).mockImplementation(async (path, body) => {
      if (path.endsWith("/processing/retry")) {
        expect(body).toEqual({ operation });
        processing = { ...readyProcessing, correlation_id: "attempt-2",
          stage: "waiting", can_cancel: true, can_retry: false };
        extraction = { ...review, enhancement: {
          status: "queued", job_id: "job-2", version: review.version, reason: null,
          error: null, provider: "ollama", model: "test", ai_attempted: false, ai_succeeded: false,
        } };
        return processing;
      }
      if (path.endsWith("/processing/cancel")) {
        processing = { ...processing, stage: "cancelled", can_cancel: false, can_retry: true,
          updated_at: "2026-01-01T00:00:02Z", reason: "cancelled" };
        extraction = { ...extraction, enhancement: { ...extraction.enhancement!,
          status: "skipped", reason: "cancelled" }, suggested_refinement: null };
        return processing;
      }
      throw new Error(`Unexpected write: ${path}`);
    });
    await renderReview(undefined, true, undefined, true);
    await userEvent.clear(screen.getByLabelText(/^Merchant/));
    await userEvent.type(screen.getByLabelText(/^Merchant/), "My correction");
    const unitPrice = screen.getByLabelText(/^Unit price/);
    const processingReads = vi.mocked(api.get).mock.calls.filter(([path]) => path.endsWith("/processing")).length;
    const extractionReads = vi.mocked(api.get).mock.calls.filter(([path]) => path.endsWith("/extraction")).length;
    await userEvent.click(screen.getAllByRole("button", { name: label })[0]!);
    expect(await screen.findByText("Waiting for processing")).toBeVisible();
    expect(screen.getByDisplayValue("My correction")).toBeVisible();
    expect(unitPrice).toHaveValue(79.99);
    expect(unitPrice).toHaveAttribute("readonly");
    expect(screen.queryByText("AI refinement proposal")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review AI suggestions" })).not.toBeInTheDocument();
    for (const name of ["Refine fields & lines", "Re-rank matches"]) {
      for (const button of screen.getAllByRole("button", { name })) expect(button).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Refresh matches" })).toBeEnabled();
    await userEvent.click(screen.getAllByRole("button", { name: label })[0]!);
    expect(api.post).toHaveBeenCalledExactlyOnceWith(
      "/documents/document-1/processing/retry", { operation },
    );
    expect(api.get).toHaveBeenCalledWith(
      "/documents/document-1/processing", expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await waitFor(() => {
      expect(vi.mocked(api.get).mock.calls.filter(([path]) => path.endsWith("/processing")).length).toBeGreaterThan(processingReads);
      expect(vi.mocked(api.get).mock.calls.filter(([path]) => path.endsWith("/extraction")).length).toBeGreaterThan(extractionReads);
    });
    await userEvent.click(screen.getByRole("button", { name: "Cancel processing" }));
    expect(await screen.findByText("Processing cancelled")).toBeVisible();
    expect(screen.getByDisplayValue("My correction")).toBeVisible();
    await waitFor(() => expect(screen.getAllByRole("button", { name: label })[0]).toBeEnabled());
    expect(screen.queryByText("AI refinement proposal")).not.toBeInTheDocument();
    expect(vi.mocked(api.post).mock.calls.map(([path]) => path)).toEqual([
      "/documents/document-1/processing/retry",
      "/documents/document-1/processing/cancel",
    ]);
  });

  it.each([
    ["interpret", "Refine fields & lines"],
    ["matches", "Re-rank matches"],
  ] as const)("keeps %s enqueue failures visible without fabricating a proposal", async (operation, label) => {
    vi.mocked(api.post).mockRejectedValue(new Error("Processing queue unavailable"));
    await renderReview();
    await userEvent.clear(screen.getByLabelText(/^Merchant/));
    await userEvent.type(screen.getByLabelText(/^Merchant/), "Keep this edit");
    await userEvent.click(screen.getAllByRole("button", { name: label })[0]!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Processing queue unavailable");
    expect(screen.getByDisplayValue("Keep this edit")).toBeVisible();
    expect(screen.getAllByRole("button", { name: label })[0]).toBeEnabled();
    expect(screen.queryByText("AI refinement proposal")).not.toBeInTheDocument();
    expect(toast.message).not.toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledExactlyOnceWith(
      "/documents/document-1/processing/retry", { operation },
    );
  });

  it("does not let a delayed enqueue snapshot replace a cancelled attempt", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let finish!: (snapshot: DocumentProcessing) => void;
    const waiting = { ...readyProcessing, correlation_id: "attempt-2",
      stage: "waiting", can_cancel: true } satisfies DocumentProcessing;
    vi.mocked(api.post).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await renderReview(client);
    await userEvent.click(screen.getAllByRole("button", { name: "Refine fields & lines" })[0]!);
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    for (const name of ["Refine fields & lines", "Re-rank matches"]) {
      for (const button of screen.getAllByRole("button", { name })) expect(button).toBeDisabled();
    }
    await userEvent.clear(screen.getByLabelText(/^Merchant/));
    await userEvent.type(screen.getByLabelText(/^Merchant/), "Edited while enqueueing");
    act(() => client.setQueryData([...queryKeys.document(document.id), "processing"], {
      ...waiting, stage: "cancelled", can_cancel: false, can_retry: true,
      updated_at: "2026-01-01T00:00:02Z", reason: "cancelled",
    } satisfies DocumentProcessing));
    await act(async () => finish(waiting));
    expect(client.getQueryData<DocumentProcessing>(
      [...queryKeys.document(document.id), "processing"],
    )?.stage).toBe("cancelled");
    expect(screen.getByDisplayValue("Edited while enqueueing")).toBeVisible();
    expect(screen.queryByText("AI refinement proposal")).not.toBeInTheDocument();
    expect(toast.message).not.toHaveBeenCalled();
  });

  it("reviews a completed queued ranking before replacing any edited fields or candidate selection", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ranked: ExtractionRefinement = {
      document_id: document.id, base_version: review.version, version: "ranked-version",
      source_artifact: review.source_artifact, generated_at: review.generated_at,
      fields: review.fields, lines: review.lines, warnings: [], ai_status: aiStatus, ai_used: true,
      matches: [{ ...review.matches[0]!, candidates: [{
        ...review.matches[0]!.candidates[0]!, id: "item-2", name: "Alternate drill",
      }] }],
    };
    vi.mocked(api.post).mockResolvedValue({
      ...readyProcessing, correlation_id: "attempt-2", stage: "waiting", can_cancel: true,
    });
    await renderReview(client);
    await userEvent.click(screen.getAllByRole("button", { name: "Re-rank matches" })[0]!);
    await userEvent.clear(screen.getByLabelText(/^Merchant/));
    await userEvent.type(screen.getByLabelText(/^Merchant/), "Edited while ranking");
    act(() => client.setQueryData([...queryKeys.document(document.id), "extraction"], {
      ...review, enhancement: { status: "ready", job_id: "job-2", version: review.version,
        reason: null, error: null, provider: "ollama", model: "test",
        ai_attempted: true, ai_succeeded: true }, suggested_refinement: ranked,
    } satisfies ExtractionReview));
    await userEvent.click(await screen.findByRole("button", { name: "Review AI suggestions" }));
    expect(screen.getByText("Suggested inventory matches: Alternate drill")).toBeVisible();
    expect(screen.getByDisplayValue("Edited while ranking")).toBeVisible();
    expect(screen.getByRole("button", { name: /Cordless Drill.*Identifier verified/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Accept AI refinement" }));
    expect(screen.getByRole("button", { name: /Alternate drill.*Identifier verified/ })).toHaveAttribute("aria-pressed", "true");
    expect(api.post).toHaveBeenCalledExactlyOnceWith(
      "/documents/document-1/processing/retry", { operation: "matches" },
    );
  });

  it("uses the frozen Add destination as a visible default without adding upload fields", async () => {
    await renderReview(undefined, true, {
      documentId: document.id, roomId: "room-1", locationId: "location-1",
    });
    await userEvent.click(screen.getByRole("button", { name: "Create new item" }));
    expect(screen.getByLabelText(/^Destination room/)).toHaveValue("room-1");
    expect(screen.getByLabelText(/^Optional container/)).toHaveValue("location-1");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("preserves an edited local draft when a new extraction version arrives", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await renderReview(client);
    await userEvent.clear(screen.getByLabelText(/^Merchant/));
    await userEvent.type(screen.getByLabelText(/^Merchant/), "My correction");
    act(() => client.setQueryData([...queryKeys.document(document.id), "extraction"], {
      ...review, version: "version-2", fields: { ...review.fields, merchant: "Fresh extraction" },
    }));
    expect(await screen.findByText(/New document extraction is available/)).toBeVisible();
    expect(screen.getByDisplayValue("My correction")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply reviewed changes" })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Replace draft with refreshed extraction" }));
    expect(screen.getByDisplayValue("Fresh extraction")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply reviewed changes" })).toBeEnabled();
  });

  it("shows source financial checks and unknowns rather than fabricated zeroes", async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...review,
      financial_validation: {
        status: "needs_attention", tax_treatment: "unknown",
        computed: { product_total_cents: 15998, discount_cents: null, shipping_cents: null,
          tax_cents: null, expected_total_cents: null, total_difference_cents: null },
        checks: [{ code: "amount_mismatch", severity: "warning",
          message: "Verify quantity × unit price against the original.", line_ids: ["line-1"] }],
      },
    } satisfies ExtractionReview);
    await renderReview();
    expect(screen.getByRole("region", { name: "Financial checks" })).toHaveTextContent("Verify quantity");
    expect(screen.getByRole("link", { name: "Review line 2" })).toHaveAttribute("href", "#extraction-source-line-1");
    expect(screen.getByText(/Recorded subtotal/)).toHaveTextContent("shipping unknown");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("keeps credit amounts visible and blocks unsupported negative purchase apply", async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...review, fields: { ...review.fields, total_cents: -15998 },
      lines: [{ ...review.lines[0]!, unit_price_cents: -7999, line_total_cents: -15998 }],
    } satisfies ExtractionReview);
    await renderReview();
    expect(screen.getByLabelText(/^Total/)).toHaveValue(-159.98);
    expect(screen.getByLabelText(/^Unit price/)).toHaveValue(-79.99);
    expect(screen.getByText(/Credit notes remain evidence/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply reviewed changes" })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("does not round away manual sub-cent amounts when applying an invoice", async () => {
    await renderReview();
    await userEvent.clear(screen.getByLabelText(/^Total/));
    await userEvent.type(screen.getByLabelText(/^Total/), "1.005");
    expect(screen.getByText(/at most two decimal places/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply reviewed changes" })).toBeDisabled();
  });

  it("keeps unit-price evidence distinct from the editable quantity and line total", async () => {
    await renderReview();
    expect(screen.getByLabelText(/^Unit price/)).toHaveAttribute("readonly");
    expect(screen.getByLabelText(/^Unit price/)).toHaveAccessibleDescription(
      "Unit price is source evidence. Reviewed quantity and line total determine purchase allocation.",
    );
    expect(screen.getByLabelText(/^Line total/)).not.toHaveAttribute("readonly");
    expect(screen.getByLabelText(/^Qty/)).not.toHaveAttribute("readonly");
    expect(screen.getByLabelText(/^Unit price/)).toHaveValue(79.99);
    expect(screen.getByLabelText(/^Line total/)).toHaveValue(159.98);
  });

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

  it("starts with one AI-assisted form when suggestions arrive before manual review", async () => {
    const suggested: ExtractionRefinement = {
      document_id: document.id, base_version: review.version, version: "suggested",
      source_artifact: "original", generated_at: review.generated_at,
      fields: { ...review.fields, merchant: "AI shop" }, lines: review.lines,
      warnings: [], matches: review.matches, ai_status: aiStatus, ai_used: true,
    };
    vi.mocked(api.get).mockResolvedValue({
      ...review, enhancement: { status: "ready", reason: null, error: null },
      suggested_refinement: suggested,
    });
    await renderReview();
    expect(screen.getByDisplayValue("AI shop")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Review AI suggestions" })).not.toBeInTheDocument();
    expect(screen.queryByText("AI refinement proposal")).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Apply reviewed changes" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/documents/document-1/extraction/apply",
      expect.objectContaining({ extraction_version: "suggested" }),
    ));
  });

  it("keeps an edited AI-assisted draft intact while refreshed AI suggestions await comparison", async () => {
    const suggested: ExtractionRefinement = {
      document_id: document.id, base_version: review.version, version: "suggested",
      source_artifact: "original", generated_at: review.generated_at,
      fields: { ...review.fields, merchant: "AI shop" }, lines: review.lines,
      warnings: [], matches: review.matches, ai_status: aiStatus, ai_used: true,
    };
    vi.mocked(api.get).mockResolvedValue({
      ...review, enhancement: { status: "ready", reason: null, error: null },
      suggested_refinement: suggested,
    });
    vi.mocked(api.post).mockImplementation(async () => {
      vi.mocked(api.get).mockResolvedValue({
        ...review, enhancement: { status: "ready", reason: null, error: null },
        suggested_refinement: {
          ...suggested, version: "refreshed", fields: { ...suggested.fields, merchant: "Refreshed shop" },
        },
      });
      return readyProcessing;
    });
    await renderReview();
    await userEvent.clear(screen.getByLabelText(/^Merchant/));
    await userEvent.type(screen.getByLabelText(/^Merchant/), "My AI correction");
    await userEvent.click(screen.getAllByRole("button", { name: "Refine fields & lines" })[0]!);
    await userEvent.click(await screen.findByRole("button", { name: "Review AI suggestions" }));
    expect(await screen.findByText("AI refinement proposal")).toBeVisible();
    expect(screen.getByDisplayValue("My AI correction")).toBeVisible();
    expect(screen.getByRole("button", { name: "Accept AI refinement" })).toBeVisible();
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/documents/document-1/processing/retry", { operation: "interpret" });
  });

  it("offers an immediately usable manual form while AI is running", async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...review, enhancement: { status: "running", reason: null, error: null },
    });
    await renderReview(undefined, false);
    expect(await screen.findByText(/Preparing one AI-assisted review/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Use local/manual review now" }));
    expect(screen.getByDisplayValue("CORNER HARDWARE")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply reviewed changes" })).toBeVisible();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("keeps a failed dismissal visible and allows retry without changing the draft", async () => {
    const suggested: ExtractionRefinement = {
      document_id: document.id, base_version: review.version, version: "suggested",
      source_artifact: "original", generated_at: review.generated_at,
      fields: { ...review.fields, merchant: "AI shop" }, lines: review.lines,
      warnings: [], matches: review.matches, ai_status: aiStatus, ai_used: true,
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(api.post).mockRejectedValue(new Error("Dismissal failed"));
    await renderReview(client);
    await userEvent.clear(screen.getByLabelText(/^Merchant/));
    await userEvent.type(screen.getByLabelText(/^Merchant/), "Manual shop");
    act(() => client.setQueryData([...queryKeys.document(document.id), "extraction"], {
      ...review,
      enhancement: { status: "ready", reason: null, error: null },
      suggested_refinement: suggested,
    }));
    await userEvent.click(await screen.findByRole("button", { name: "Review AI suggestions" }));
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
      return readyProcessing;
    });
    await renderReview();
    await userEvent.click(screen.getAllByRole("button", { name: "Refine fields & lines" })[0]!);
    expect(await screen.findByText("AI review complete · no changes")).toBeVisible();
    expect(screen.queryByText("AI refinement proposal")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review AI suggestions" })).not.toBeInTheDocument();
    expect(api.post).toHaveBeenCalledExactlyOnceWith(
      "/documents/document-1/processing/retry", { operation: "interpret" },
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

  it("refreshes deterministic matches without enabling the legacy AI call", async () => {
    await renderReview();
    await screen.findByText("Product lines");
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh matches" }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/documents/document-1/extraction/matches",
        expect.objectContaining({ use_ai: false }),
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
      if (path.endsWith("/processing/retry")) {
        vi.mocked(api.get).mockResolvedValue({
          ...review, enhancement: { status: "ready", reason: null, error: null },
          suggested_refinement: refinement,
        });
        return readyProcessing;
      }
      return applied;
    });
    await renderReview();
    await screen.findByText("Product lines");
    await userEvent.click(
      screen.getAllByRole("button", { name: "Refine fields & lines" })[0]!,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Review AI suggestions" }));
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
