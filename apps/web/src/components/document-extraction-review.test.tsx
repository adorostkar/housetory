import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup as cleanupRender, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { DocumentExtractionReview } from "@/components/document-extraction-review";
import { BarEditorBoundary } from "@/components/shell/bar-editor";
import { DocumentProcessingStatus } from "@/components/document-processing-status";
import { writerId } from "@/lib/review-draft-store";
import { api, ApiError } from "@/lib/api";
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

// Without a signed-in user there is no copy of a correction on this device.
let signedIn = false;
// Who stores a draft from this browser: the device, and the person when one is signed in.
const thisWriter = () => writerId(signedIn ? "user-1" : null);
const localCopies = () => Object.keys(localStorage).filter((key) => key.startsWith("housetory:review-draft:"));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useCanWrite: () => true,
    useSession: () => ({
      data: signedIn ? { user: { id: "user-1" }, household: { id: "house-1", default_currency: "USD" } } : undefined,
    }),
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
    api: { ...actual.api, get: vi.fn(), post: vi.fn(), put: vi.fn() },
  };
});

async function renderReview(client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  }), open = true, captureContext?: DocumentCaptureContext, processing = false, openLine = true) {
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {processing && <DocumentProcessingStatus documentId={document.id} onManualReview={vi.fn()} />}
        <DocumentExtractionReview document={document} captureContext={captureContext} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  if (open) await userEvent.click(await screen.findByRole("button", { name: "Review extraction" }));
  // Rows are closed by default. Most cases here are about the editor of the first line.
  if (open && openLine) {
    const edit = screen.queryAllByRole("button", { name: "Edit" })[0];
    if (edit) await userEvent.click(edit);
  }
  return result;
}

// A checkbox only selects a line for the bulk Apply.
async function selectLine(index = 0) {
  await userEvent.click(screen.getAllByRole("checkbox", { name: /^Select line/ })[index]!);
}

beforeEach(() => {
  signedIn = false;
  localStorage.clear();
  vi.mocked(toast.message).mockClear();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.put).mockResolvedValue({ line_states: {}, applied_version: null });
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

  it("keeps the place of a restored draft over the place chosen at capture", async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...review,
      line_states: { "line-1": { status: "pending", draft: {
        action: "create", newItem: { name: "Cordless Drill", roomId: "", locationId: "" },
      } } },
    });
    await renderReview(undefined, true, {
      documentId: document.id, roomId: "room-1", locationId: "location-1",
    });
    await userEvent.click(screen.getByRole("button", { name: "Create new item" }));
    expect(screen.getByLabelText(/^Destination room/)).toHaveValue("");
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
    expect(screen.getByRole("button", { name: /^Apply: / })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Replace draft with refreshed extraction" }));
    expect(screen.getByDisplayValue("Fresh extraction")).toBeVisible();
    await selectLine();
    expect(screen.getByRole("button", { name: /^Apply: / })).toBeEnabled();
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
    expect(screen.getByRole("button", { name: /^Apply: / })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("does not round away manual sub-cent amounts when applying an invoice", async () => {
    await renderReview();
    await userEvent.clear(screen.getByLabelText(/^Total/));
    await userEvent.type(screen.getByLabelText(/^Total/), "1.005");
    expect(screen.getByText(/at most two decimal places/)).toBeVisible();
    expect(screen.getByRole("button", { name: /^Apply: / })).toBeDisabled();
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
    await selectLine();
    await userEvent.click(screen.getByRole("button", { name: /^Apply: / }));
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
    expect(screen.getByRole("button", { name: /^Apply: / })).toBeVisible();
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
    expect(screen.getByRole("button", { name: /^Apply: / })).toBeVisible();
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
    // The name is in the row and in its editor.
    expect(screen.getAllByDisplayValue("Cordless Drill")).toHaveLength(2);
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
    await selectLine();
    await userEvent.click(screen.getByRole("button", { name: "Apply: link 1 item, record the purchase" }));

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
    // The row's own button now adds an item. What is missing is said in the row,
    // and nothing is sent.
    const row = screen.getByRole("article", { name: "Cordless Drill" });
    await userEvent.click(within(row).getByRole("button", { name: "Add item" }));
    expect(within(row).getByRole("alert")).toHaveTextContent("A new item needs a room.");
    expect(api.post).not.toHaveBeenCalled();
    await selectLine();
    expect(screen.getByRole("button", { name: /^Apply: add 1 item/ })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Destination room"), "room-1");
    expect(within(row).queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByLabelText("Optional container"),
      "location-1",
    );
    await userEvent.click(screen.getByRole("checkbox", { name: /Apply extracted warranty evidence/ }));
    await userEvent.click(screen.getByRole("button", { name: "Apply: add 1 item, record the purchase" }));
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
    await selectLine();
    await userEvent.click(screen.getByRole("button", { name: /^Apply: / }));
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
  const twoLines: ExtractionReview = {
    ...review,
    lines: [
      review.lines[0]!,
      { ...review.lines[0]!, id: "line-2", line_number: 3, description: "Drill Bit Set", quantity: 1,
        unit_price_cents: 2450, line_total_cents: 2450 },
      ...review.lines.slice(1),
    ],
  };
  const applyCalls = () => vi.mocked(api.post).mock.calls.filter(([path]) => path.endsWith("/extraction/apply"));

  it("starts with closed rows and nothing selected; a strong match is only the suggestion", async () => {
    vi.mocked(api.get).mockResolvedValue(twoLines);
    await renderReview(undefined, true, undefined, false, false);
    const drill = screen.getByRole("article", { name: "Cordless Drill" });
    const bits = screen.getByRole("article", { name: "Drill Bit Set" });
    for (const box of screen.getAllByRole("checkbox", { name: /^Select line/ })) expect(box).not.toBeChecked();
    // No editor is open, and the old Skip line choice is gone.
    expect(screen.queryByLabelText(/^Unit price/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip line" })).not.toBeInTheDocument();
    // Each row says what it would do, and its button does exactly that.
    expect(within(drill).getByText("Cordless Drill", { selector: "span" }).closest("li")).toHaveTextContent("Link to: Cordless Drill");
    expect(within(drill).getByRole("button", { name: "Link to item" })).toBeEnabled();
    expect(within(bits).getByText("not chosen").closest("li")).toHaveTextContent(/Room: not chosen\s*· check/);
    expect(within(bits).getByRole("button", { name: "Add item" })).toBeEnabled();

    const apply = screen.getByRole("button", { name: "Apply: nothing selected" });
    expect(apply).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText(/^2 selected · lines that are not selected stay pending/)).toBeVisible();
    // The new item still needs a room, so the bulk action waits and the row says why.
    expect(screen.getByRole("button", { name: "Apply: add 1 item, link 1 item, record the purchase" })).toBeDisabled();
    expect(within(bits).getByRole("alert")).toHaveTextContent("A new item needs a room.");
    await userEvent.click(screen.getByRole("checkbox", { name: /^Select line 3/ }));
    expect(screen.getByRole("button", { name: "Apply: link 1 item, record the purchase" })).toBeEnabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("applies one row alone, leaves the other pending, and an applied row cannot be applied again", async () => {
    let extraction: ExtractionReview & { line_states?: object; applied_version?: string } = twoLines;
    vi.mocked(api.get).mockImplementation(async () => extraction);
    vi.mocked(api.post).mockImplementation(async (path) => {
      if (path.endsWith("/extraction/apply")) {
        extraction = {
          ...twoLines,
          applied: [{ request_id: "request-1", applied_at: "2026-01-02T00:00:00Z", created_item_ids: [],
            updated_item_ids: [], linked_item_ids: ["item-1"], skipped_line_ids: [], purchase_id: "purchase-1" }],
          applied_version: "version-1",
          line_states: { "line-1": { status: "applied", action: "link", item: { id: "item-1", name: "Cordless Drill" } } },
        };
      }
      return applied;
    });
    await renderReview(undefined, true, undefined, false, false);
    await userEvent.click(
      within(screen.getByRole("article", { name: "Cordless Drill" })).getByRole("button", { name: "Link to item" }),
    );
    await waitFor(() => expect(applyCalls()).toHaveLength(1));
    // Only that line is sent. The other line is not sent as a skip.
    expect(applyCalls()[0]![1]).toEqual(expect.objectContaining({
      purchase_action: "create",
      allow_reapply: false,
      lines: [expect.objectContaining({ line_id: "line-1", action: "link", item_id: "item-1" })],
    }));

    const done = await screen.findByRole("article", { name: "Cordless Drill" });
    await waitFor(() => expect(within(done).getByText("Linked")).toBeVisible());
    expect(within(done).queryByRole("button", { name: "Link to item" })).not.toBeInTheDocument();
    expect(within(done).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(done).getByRole("link", { name: "Open item" })).toHaveAttribute("href", "/items/item-1");
    expect(screen.getByText("Part of this document is applied")).toBeVisible();

    // The other line is still pending and joins the purchase that was recorded.
    const bits = screen.getByRole("article", { name: "Drill Bit Set" });
    expect(within(bits).getByRole("button", { name: "Add item" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText(/^1 selected · lines that are not selected stay pending/)).toBeVisible();
    expect(screen.getByRole("button", { name: /^Apply: add 1 item, add to the recorded purchase/ })).toBeInTheDocument();
    expect(applyCalls()).toHaveLength(1);
  });

  it("skips a line into Skipped with its edits and restores it after a reload", async () => {
    let extraction: ExtractionReview & { line_states?: object } = twoLines;
    vi.mocked(api.get).mockImplementation(async () => extraction);
    vi.mocked(api.post).mockImplementation(async (path, body) => {
      const skipped = path.endsWith("/lines/line-2/skip");
      extraction = {
        ...twoLines,
        line_states: skipped ? { "line-2": { status: "skipped", ...(body as object) } } : {},
      };
      return { line_states: extraction.line_states, applied_version: null };
    });
    const view = await renderReview(undefined, true, undefined, false, false);
    const name = screen.getByRole("textbox", { name: "Name of line 3" });
    await userEvent.clear(name);
    await userEvent.type(name, "Bit set, 20 pieces");
    await userEvent.click(
      within(screen.getByRole("article", { name: "Bit set, 20 pieces" })).getByRole("button", { name: "Skip" }),
    );
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/documents/document-1/extraction/lines/line-2/skip",
      expect.objectContaining({ description: "Bit set, 20 pieces", quantity: 1, line_total_cents: 2450 }),
    ));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Bit set, 20 pieces" })).not.toBeInTheDocument());
    expect(screen.getByText("Skipped (1)")).toBeVisible();
    const undo = vi.mocked(toast.success).mock.calls.at(-1)?.[1] as { action: { label: string } };
    expect(undo.action.label).toBe("Undo");

    // A reload has only what the server kept: the skip, with the edited name.
    view.unmount();
    await renderReview(undefined, true, undefined, false, false);
    expect(screen.queryByRole("article", { name: "Bit set, 20 pieces" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("Skipped (1)"));
    await userEvent.click(screen.getByRole("button", { name: "Restore Bit set, 20 pieces" }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith(
      "/documents/document-1/extraction/lines/line-2/restore", undefined,
    ));
    const restored = await screen.findByRole("article", { name: "Bit set, 20 pieces" });
    expect(within(restored).getByRole("checkbox")).not.toBeChecked();
    expect(screen.queryByText(/^Skipped \(/)).not.toBeInTheDocument();
  });
  it("keeps the complete draft of a skipped line: action, target, updates, new item and amounts", async () => {
    let extraction: ExtractionReview & { line_states?: object } = twoLines;
    vi.mocked(api.get).mockImplementation(async () => extraction);
    vi.mocked(api.post).mockImplementation(async (path, body) => {
      const sent = body as { draft?: object } | undefined;
      const lineId = path.split("/").at(-2)!;
      extraction = { ...twoLines, line_states: {
        [lineId]: path.endsWith("/skip")
          ? { status: "skipped", ...sent }
          : { ...(extraction.line_states as Record<string, object>)[lineId], status: "pending" },
      }, matches: extraction.matches };
      return { line_states: extraction.line_states, applied_version: null };
    });
    const view = await renderReview(undefined, true, undefined, false, false);

    // Line 2 becomes an update of the matched drill, with a new name, a changed total
    // and extra stock. Line 3 becomes a new item with a room and a brand.
    const drill = screen.getByRole("article", { name: "Cordless Drill" });
    await userEvent.click(within(drill).getByRole("button", { name: "Edit" }));
    await userEvent.click(within(drill).getByRole("button", { name: "Update details" }));
    await userEvent.type(within(drill).getByLabelText(/^Name\s*Optional$/), "Drill, serviced");
    await userEvent.clear(within(drill).getByLabelText(/^Line total/));
    await userEvent.type(within(drill).getByLabelText(/^Line total/), "140.5");
    await userEvent.click(within(drill).getByRole("checkbox", { name: /Add this quantity as new stock/ }));
    await userEvent.click(within(drill).getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const bits = screen.getByRole("article", { name: "Drill Bit Set" });
    await userEvent.click(within(bits).getByRole("button", { name: "Edit" }));
    await userEvent.selectOptions(within(bits).getByLabelText("Destination room"), "room-1");
    await userEvent.click(within(bits).getByText("More details"));
    await userEvent.type(within(bits).getByLabelText(/^Brand/), "Bosch");
    await userEvent.click(within(bits).getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));

    const [drillSkip, bitsSkip] = vi.mocked(api.post).mock.calls.map(([, body]) => (body as { draft: Record<string, unknown> }).draft);
    expect(drillSkip).toEqual(expect.objectContaining({
      action: "update", itemId: "item-1", addQuantity: true, lineTotal: "140.5",
      updates: expect.objectContaining({ name: "Drill, serviced" }),
      candidate: expect.objectContaining({ id: "item-1", name: "Cordless Drill" }),
    }));
    expect(bitsSkip).toEqual(expect.objectContaining({
      action: "create",
      newItem: expect.objectContaining({ name: "Drill Bit Set", roomId: "room-1", brand: "Bosch" }),
    }));

    // Reload with what the server kept for the drill line, then Restore it.
    extraction = { ...twoLines, matches: [], line_states: { "line-1": { status: "skipped", draft: drillSkip } } };
    view.unmount();
    await renderReview(undefined, true, undefined, false, false);
    await userEvent.click(screen.getByText("Skipped (1)"));
    await userEvent.click(screen.getByRole("button", { name: "Restore Cordless Drill" }));
    const restored = await screen.findByRole("article", { name: "Cordless Drill" });
    // The row is back with its action and target, its old → new value and its amounts,
    // although the item is no longer among the proposed matches.
    expect(within(restored).getByRole("button", { name: "Apply changes" })).toBeEnabled();
    expect(within(restored).getByText("Drill, serviced").closest("li")).toHaveTextContent(
      /Name: Cordless Drill.*Drill, serviced/,
    );
    expect(within(restored).getByText("140.5")).toBeVisible();
    expect(within(restored).getByText("+2").closest("li")).toHaveTextContent("Stock: +2");

    // Another reload after Restore still has the draft: Restore did not delete it.
    view.unmount();
    cleanupRender();
    await renderReview(undefined, true, undefined, false, false);
    const again = await screen.findByRole("article", { name: "Cordless Drill" });
    expect(within(again).getByRole("button", { name: "Apply changes" })).toBeEnabled();
    expect(within(again).getByText("Drill, serviced")).toBeVisible();
  });
  describe("kept corrections", () => {
    afterEach(() => vi.useRealTimers());
    const draftPath = (id: string) => `/documents/${document.id}/extraction/lines/${id}/draft`;
    const pass = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    const line = (name: string) => screen.getByRole("article", { name });
    const note = "Your corrections are not saved yet. Trying again.";
    type KeptLine = {
      status: string; draft?: unknown; revision?: number; writer?: string | null;
      line_total_cents?: number; [key: string]: unknown;
    };
    let extraction: ExtractionReview & {
      line_states?: Record<string, KeptLine>; applied_version?: string | null;
      header_draft?: { version: string; draft: object } | null;
      header_revision?: number; header_writer?: string | null;
    };
    const headerPath = `/documents/${document.id}/extraction/draft`;
    // Like the server: the draft of a waiting line is kept with the line, which stays
    // pending, and the fields at the top are kept with their version. Each has a
    // revision. A draft is kept when it was made on that revision, or when the kept
    // one is from the same device. The same draft again changes nothing. Anything
    // else is a conflict, and nothing is kept.
    const keep = async (path: string, body: unknown) => {
      const { expected_revision: expected, writer, ...sent } =
        body as { expected_revision?: number; writer?: string; version?: string; draft?: object | null };
      const refuse = (revision: number, by: string | null | undefined, same: boolean) => {
        if (!same && expected !== revision && writer !== by) {
          throw new ApiError(409, "draft_conflict", "This row was also corrected on another device.");
        }
        return !same;
      };
      if (path === headerPath) {
        const revision = extraction.header_revision ?? 0;
        const same = JSON.stringify(sent.draft ?? null) === JSON.stringify(extraction.header_draft?.draft ?? null);
        if (refuse(revision, extraction.header_writer, same)) {
          extraction = { ...extraction, header_revision: revision + 1, header_writer: writer ?? null,
            header_draft: sent.draft ? { version: sent.version!, draft: sent.draft } : null };
        }
        return { header_draft: extraction.header_draft, header_revision: extraction.header_revision,
          header_writer: extraction.header_writer };
      }
      const id = path.split("/").at(-2)!;
      const state = extraction.line_states?.[id];
      const revision = state?.revision ?? 0;
      if (refuse(revision, state?.writer, JSON.stringify(sent.draft ?? null) === JSON.stringify(state?.draft ?? null))) {
        extraction = { ...extraction, line_states: { ...extraction.line_states,
          [id]: { status: "pending", ...sent, revision: revision + 1, writer: writer ?? null } } };
      }
      return { line_states: extraction.line_states, applied_version: null };
    };
    // Another device corrects a line or the fields at the top.
    const correctElsewhere = (change: Partial<typeof extraction>) => {
      extraction = { ...extraction, ...change } as typeof extraction;
    };
    beforeEach(() => {
      extraction = twoLines;
      vi.mocked(api.get).mockImplementation(async () => extraction);
      vi.mocked(api.put).mockImplementation(keep);
    });
    // The review is loaded with real time; the clock is held only for the corrections.
    const load = async () => {
      const view = await renderReview(undefined, true, undefined, false, false);
      vi.useFakeTimers();
      return view;
    };
    const correctBits = () => {
      const bits = line("Drill Bit Set");
      fireEvent.click(within(bits).getByRole("button", { name: "Edit" }));
      fireEvent.change(within(bits).getByLabelText("Destination room"), { target: { value: "room-1" } });
      fireEvent.change(within(bits).getByLabelText(/^Brand/), { target: { value: "Bosch" } });
      fireEvent.change(within(bits).getByLabelText(/^Line total/), { target: { value: "19.90" } });
    };

    it("keeps the whole draft of a waiting line a short moment after its last change, in one request", async () => {
      await load();
      await pass(2000);
      // Nothing is sent for lines that were not touched.
      expect(api.put).not.toHaveBeenCalled();
      correctBits();
      await pass(599);
      expect(api.put).not.toHaveBeenCalled();
      await pass(1);
      expect(api.put).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.put).mock.calls[0]).toEqual([draftPath("line-2"), {
        description: "Drill Bit Set", quantity: 1, line_total_cents: 1990,
        draft: expect.objectContaining({
          action: "create", lineTotal: "19.90",
          newItem: expect.objectContaining({ name: "Drill Bit Set", roomId: "room-1", brand: "Bosch" }),
        }),
        // The revision of the line's draft that the row was built from, and this device.
        expected_revision: 0, writer: thisWriter(),
      }, undefined]);
      // The line still waits, is not selected, its editor is still open, and nothing was applied.
      expect(within(line("Drill Bit Set")).getByLabelText("Destination room")).toHaveValue("room-1");
      expect(within(line("Drill Bit Set")).getByRole("checkbox", { name: /^Select line/ })).not.toBeChecked();
      expect(api.post).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(screen.queryByText(note)).not.toBeInTheDocument();

      // Selecting a line is not a correction.
      fireEvent.click(within(line("Drill Bit Set")).getByRole("checkbox", { name: /^Select line/ }));
      await pass(2000);
      expect(api.put).toHaveBeenCalledTimes(1);
    });

    it("keeps the action and its target, and a reload shows the line as it was corrected", async () => {
      const view = await load();
      const drill = line("Cordless Drill");
      fireEvent.click(within(drill).getByRole("button", { name: "Edit" }));
      fireEvent.click(within(drill).getByRole("button", { name: "Update details" }));
      fireEvent.change(within(drill).getByLabelText(/^Name\s*Optional$/), { target: { value: "Drill, serviced" } });
      fireEvent.click(within(drill).getByRole("checkbox", { name: /Add this quantity as new stock/ }));
      correctBits();
      await pass(600);
      expect(vi.mocked(api.put).mock.calls.map((call) => call[0]).sort()).toEqual([draftPath("line-1"), draftPath("line-2")]);
      const drillDraft = vi.mocked(api.put).mock.calls.find((call) => call[0] === draftPath("line-1"))![1];
      expect(drillDraft).toEqual(expect.objectContaining({ draft: expect.objectContaining({
        action: "update", itemId: "item-1", addQuantity: true,
        updates: expect.objectContaining({ name: "Drill, serviced" }),
        candidate: expect.objectContaining({ id: "item-1", name: "Cordless Drill" }),
      }) }));

      // A reload has only what the server kept. The item is no longer among the matches,
      // and the place that was chosen at capture does not replace the kept one.
      view.unmount();
      vi.useRealTimers();
      cleanupRender();
      vi.mocked(api.put).mockClear();
      extraction = { ...extraction, matches: [] };
      await renderReview(undefined, true, {
        documentId: document.id, roomId: "", locationId: "",
      }, false, false);
      const reloaded = line("Cordless Drill");
      expect(within(reloaded).getByRole("button", { name: "Apply changes" })).toBeEnabled();
      expect(within(reloaded).getByText("Drill, serviced").closest("li")).toHaveTextContent(
        /Name: Cordless Drill.*Drill, serviced/,
      );
      expect(within(reloaded).getByText("+2").closest("li")).toHaveTextContent("Stock: +2");
      const bits = line("Drill Bit Set");
      expect(within(bits).getByText("19.90")).toBeVisible();
      expect(within(bits).getByText("Office")).toBeVisible();
      for (const box of screen.getAllByRole("checkbox", { name: /^Select line/ })) expect(box).not.toBeChecked();
      // What was loaded is what the server has: nothing is sent again.
      vi.useFakeTimers();
      await pass(2000);
      expect(api.put).not.toHaveBeenCalled();
      // The row's own button does what was chosen before the reload.
      fireEvent.click(within(reloaded).getByRole("button", { name: "Apply changes" }));
      await pass(0);
      expect(applyCalls()[0]![1]).toEqual(expect.objectContaining({ lines: [expect.objectContaining({
        line_id: "line-1", action: "update", item_id: "item-1", add_quantity: true,
        updates: expect.objectContaining({ name: "Drill, serviced" }),
      })] }));
    });

    it("shows the corrections when the document is opened again before the server has answered", async () => {
      const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
      const view = await renderReview(client, true, undefined, false, false);
      vi.useFakeTimers();
      // The save is on its way and has not come back.
      vi.mocked(api.put).mockImplementation(() => new Promise(() => undefined));
      correctBits();
      await pass(600);
      expect(api.put).toHaveBeenCalledTimes(1);
      view.unmount();
      vi.useRealTimers();
      cleanupRender();
      await renderReview(client, true, undefined, false, false);
      const bits = line("Drill Bit Set");
      expect(within(bits).getByText("19.90")).toBeVisible();
      expect(within(bits).getByText("Office")).toBeVisible();
    });

    const headerCalls = () => vi.mocked(api.put).mock.calls.filter(([path]) => path === headerPath);
    const field = (label: RegExp) => screen.getByLabelText(label);

    it("keeps the fields at the top like a line, and a reload fills them again without applying anything", async () => {
      const view = await load();
      await pass(2000);
      expect(api.put).not.toHaveBeenCalled();
      fireEvent.change(field(/^Merchant/), { target: { value: "Corner" } });
      fireEvent.change(field(/^Merchant/), { target: { value: "Corner Hardware AB" } });
      fireEvent.change(field(/^Purchase date/), { target: { value: "2026-02-15" } });
      fireEvent.change(field(/^Total/), { target: { value: "190.5" } });
      fireEvent.change(field(/^Order or invoice number/), { target: { value: "ORD-7" } });
      fireEvent.click(screen.getByRole("button", { name: "No purchase change" }));
      await pass(599);
      expect(api.put).not.toHaveBeenCalled();
      await pass(1);
      // One request with the whole set of fields, for the version on screen.
      expect(vi.mocked(api.put).mock.calls).toEqual([[headerPath, { version: "version-1", draft: {
        merchant: "Corner Hardware AB", purchase_date: "2026-02-15", document_date: "2026-02-14",
        currency: "USD", total: "190.5", order_number: "ORD-7", purchase_action: "none",
      }, expected_revision: 0, writer: thisWriter() }, undefined]]);
      expect(api.post).not.toHaveBeenCalled();

      // A reload has only what the server kept. The fields are filled; nothing is applied.
      view.unmount();
      vi.useRealTimers();
      cleanupRender();
      vi.mocked(api.put).mockClear();
      await renderReview(undefined, true, undefined, false, false);
      expect(field(/^Merchant/)).toHaveValue("Corner Hardware AB");
      expect(field(/^Purchase date/)).toHaveValue("2026-02-15");
      expect(field(/^Document date/)).toHaveValue("2026-02-14");
      expect(field(/^Total/)).toHaveValue(190.5);
      expect(field(/^Order or invoice number/)).toHaveValue("ORD-7");
      expect(screen.getByRole("button", { name: "No purchase change" })).toHaveAttribute("aria-pressed", "true");
      for (const box of screen.getAllByRole("checkbox", { name: /^Select line/ })) expect(box).not.toBeChecked();
      vi.useFakeTimers();
      await pass(2000);
      expect(api.put).not.toHaveBeenCalled();
      expect(api.post).not.toHaveBeenCalled();

      // Typing the first reading back removes the kept draft.
      fireEvent.change(field(/^Merchant/), { target: { value: "CORNER HARDWARE" } });
      fireEvent.change(field(/^Purchase date/), { target: { value: "2026-02-14" } });
      fireEvent.change(field(/^Total/), { target: { value: "188.44" } });
      fireEvent.change(field(/^Order or invoice number/), { target: { value: "INV-9001" } });
      fireEvent.click(screen.getByRole("button", { name: "Create purchase" }));
      await pass(600);
      expect(headerCalls()).toEqual([[headerPath, {
        version: "version-1", draft: null, expected_revision: 1, writer: thisWriter(),
      }, undefined]]);
    });

    it("does not use fields that were kept for another version of the reading", async () => {
      extraction = { ...extraction, header_draft: { version: "version-0", draft: { merchant: "Old shop" } } } as typeof extraction;
      await load();
      expect(field(/^Merchant/)).toHaveValue("CORNER HARDWARE");
    });

    it("puts corrections back after a reload when their requests were lost, and applies nothing", async () => {
      signedIn = true;
      vi.mocked(api.put).mockRejectedValue(new ApiError(0, "network_error", "No connection."));
      const view = await load();
      fireEvent.change(field(/^Merchant/), { target: { value: "Corner Hardware AB" } });
      fireEvent.change(field(/^Total/), { target: { value: "190.5" } });
      correctBits();
      // The copies are on this device before anything is sent.
      expect(api.put).not.toHaveBeenCalled();
      expect(localCopies().sort()).toEqual([
        "housetory:review-draft:v2:user-1:house-1:document:document-1:header",
        "housetory:review-draft:v2:user-1:house-1:document:document-1:line-2",
      ]);
      view.unmount();

      // A reload: the server never got them, and nothing of this visit is in memory.
      vi.useRealTimers();
      cleanupRender();
      const sent: Array<[string, unknown]> = [];
      vi.mocked(api.put).mockReset();
      vi.mocked(api.put).mockImplementation(async (path, body) => { sent.push([path, body]); return {}; });
      expect(extraction).toBe(twoLines);
      await renderReview(undefined, true, undefined, false, false);
      expect(field(/^Merchant/)).toHaveValue("Corner Hardware AB");
      expect(field(/^Total/)).toHaveValue(190.5);
      const bits = line("Drill Bit Set");
      expect(within(bits).getByText("19.90")).toBeVisible();
      expect(within(bits).getByText("Office")).toBeVisible();
      // The line still waits and is not selected. Nothing was applied by putting it back.
      expect(within(bits).getByRole("checkbox", { name: /^Select line/ })).not.toBeChecked();
      expect(within(bits).getByRole("button", { name: "Add item" })).toBeEnabled();
      expect(api.post).not.toHaveBeenCalled();
      // They are sent again by themselves. When the server has them, the copies go.
      await waitFor(() => expect(sent.map(([path]) => path).sort()).toEqual([headerPath, draftPath("line-2")]), { timeout: 3000 });
      expect(sent.find(([path]) => path === headerPath)![1]).toEqual({ version: "version-1", draft: expect.objectContaining({
        merchant: "Corner Hardware AB", total: "190.5",
      }), expected_revision: 0, writer: thisWriter() });
      await waitFor(() => expect(localCopies()).toEqual([]), { timeout: 3000 });
      expect(api.post).not.toHaveBeenCalled();
    });

    const notice = (inside: HTMLElement) => within(inside).getByRole("group", { name: "Two corrections" });

    it("keeps corrections of this device beside a line and the fields that another device corrected, and lets the person choose", async () => {
      signedIn = true;
      vi.mocked(api.put).mockRejectedValue(new ApiError(0, "network_error", "No connection."));
      const view = await load();
      fireEvent.change(field(/^Merchant/), { target: { value: "Corner Hardware AB" } });
      correctBits();
      const drill = line("Cordless Drill");
      fireEvent.click(within(drill).getByRole("button", { name: "Edit" }));
      fireEvent.change(within(drill).getByLabelText(/^Line total/), { target: { value: "140.5" } });
      expect(localCopies()).toHaveLength(3);
      view.unmount();
      vi.useRealTimers();
      cleanupRender();
      vi.mocked(api.put).mockReset();
      vi.mocked(api.put).mockImplementation(keep);
      // Before this device is opened again, the bit set and the fields at the top are
      // corrected on a laptop. The drill line is as it was.
      correctElsewhere({
        header_draft: { version: "version-1", draft: { merchant: "Shop from the laptop" } },
        header_revision: 1, header_writer: "laptop-0123456789",
        line_states: { "line-2": { status: "pending", description: "Drill Bit Set", quantity: 1, line_total_cents: 3000,
          draft: { lineTotal: "30.00" }, revision: 1, writer: "laptop-0123456789" } },
      } as Partial<typeof extraction>);
      await renderReview(undefined, true, undefined, false, false);
      // The page shows what the server has. The corrections of this device are not
      // lost: each waits in one plain notice beside its part.
      expect(field(/^Merchant/)).toHaveValue("Shop from the laptop");
      const bits = () => line("Drill Bit Set").parentElement!;
      expect(within(line("Drill Bit Set")).getByText("30.00")).toBeVisible();
      expect(within(line("Drill Bit Set")).queryByText("19.90")).not.toBeInTheDocument();
      expect(within(notice(bits())).getByRole("status")).toHaveTextContent(
        "This line was also corrected on another device. Yours: «Drill Bit Set», quantity 1, total 19.90.",
      );
      const fields = () => screen.getByRole("heading", { name: "Document fields" }).closest("section")!;
      expect(within(notice(fields())).getByRole("status")).toHaveTextContent(
        "These details were also corrected on another device. Yours: merchant «Corner Hardware AB».",
      );
      // The drill line was not touched anywhere else: its copy is used by itself.
      expect(within(line("Cordless Drill")).getByText("140.5")).toBeVisible();
      await waitFor(() => expect(localCopies()).toHaveLength(2), { timeout: 3000 });
      await new Promise((resolve) => setTimeout(resolve, 900));
      // Only the drill line was sent. Nothing went over what the laptop saved.
      expect(vi.mocked(api.put).mock.calls.map((call) => call[0])).toEqual([draftPath("line-1")]);
      expect(extraction.header_draft!.draft).toEqual({ merchant: "Shop from the laptop" });
      expect(extraction.line_states!["line-2"]!.draft).toEqual({ lineTotal: "30.00" });

      // "Use mine" on the line: it goes back into the row and is saved on the
      // revision the server has now. The line still waits; nothing is applied.
      vi.mocked(api.put).mockClear();
      fireEvent.click(within(notice(bits())).getByRole("button", { name: "Use mine" }));
      expect(within(line("Drill Bit Set")).getByText("19.90")).toBeVisible();
      await waitFor(() => expect(extraction.line_states!["line-2"]).toEqual(
        expect.objectContaining({ line_total_cents: 1990, revision: 2, writer: thisWriter() }),
      ), { timeout: 3000 });
      expect(vi.mocked(api.put).mock.calls).toEqual([[draftPath("line-2"), expect.objectContaining({
        expected_revision: 1, line_total_cents: 1990,
      }), undefined]]);
      await waitFor(() => expect(localCopies()).toHaveLength(1), { timeout: 3000 });
      expect(within(bits()).queryByRole("group", { name: "Two corrections" })).not.toBeInTheDocument();
      expect(within(line("Drill Bit Set")).getByRole("checkbox", { name: /^Select line/ })).not.toBeChecked();

      // "Keep the other" for the fields: the copy is removed and nothing is sent.
      vi.mocked(api.put).mockClear();
      fireEvent.click(within(notice(fields())).getByRole("button", { name: "Keep the other" }));
      expect(screen.queryByRole("group", { name: "Two corrections" })).not.toBeInTheDocument();
      expect(localCopies()).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(api.put).not.toHaveBeenCalled();
      expect(field(/^Merchant/)).toHaveValue("Shop from the laptop");
      expect(api.post).not.toHaveBeenCalled();
    });

    it("shows the other device's fields when a save meets a newer one, and applies only what is shown", async () => {
      signedIn = true;
      await load();
      // Both devices have the review open. The laptop saves the fields first.
      fireEvent.change(field(/^Merchant/), { target: { value: "Corner Hardware AB" } });
      correctElsewhere({
        header_draft: { version: "version-1", draft: { merchant: "Shop from the laptop" } },
        header_revision: 1, header_writer: "laptop-0123456789",
      } as Partial<typeof extraction>);
      await pass(600);
      await pass(0);
      // The server kept nothing of this save. The fields show the laptop's value,
      // with the correction of this device beside them. It is not sent again.
      expect(headerCalls()).toHaveLength(1);
      expect(field(/^Merchant/)).toHaveValue("Shop from the laptop");
      const fields = screen.getByRole("heading", { name: "Document fields" }).closest("section")!;
      expect(within(notice(fields)).getByRole("status")).toHaveTextContent("Yours: merchant «Corner Hardware AB».");
      expect(screen.queryByText(note)).not.toBeInTheDocument();
      await pass(60_000);
      expect(headerCalls()).toHaveLength(1);
      expect(extraction.header_draft!.draft).toEqual({ merchant: "Shop from the laptop" });

      // "Use mine": saved on the revision the server has now.
      fireEvent.click(within(notice(fields)).getByRole("button", { name: "Use mine" }));
      expect(field(/^Merchant/)).toHaveValue("Corner Hardware AB");
      await pass(600);
      expect(headerCalls().at(-1)![1]).toEqual(expect.objectContaining({
        expected_revision: 1, draft: expect.objectContaining({ merchant: "Corner Hardware AB" }),
      }));
      expect(extraction.header_draft!.draft).toEqual(expect.objectContaining({ merchant: "Corner Hardware AB" }));
      expect(screen.queryByRole("group", { name: "Two corrections" })).not.toBeInTheDocument();
      expect(localCopies()).toEqual([]);
      expect(api.post).not.toHaveBeenCalled();
    });

    it("goes on from a line that this page skipped and restored, without a question", async () => {
      // Like the server: a skip keeps the line as it was sent, one revision on, from no device.
      vi.mocked(api.post).mockImplementation(async (path, body) => {
        const id = path.split("/").at(-2)!;
        const state = extraction.line_states?.[id];
        extraction = { ...extraction, line_states: { ...extraction.line_states, [id]: path.endsWith("/skip")
          ? { ...(body as object), status: "skipped", revision: (state?.revision ?? 0) + 1, writer: null }
          : { ...state!, status: "pending" } } };
        return { line_states: extraction.line_states, applied_version: null };
      });
      await load();
      correctBits();
      await pass(600);
      expect(extraction.line_states!["line-2"]!.revision).toBe(1);
      fireEvent.click(within(line("Drill Bit Set")).getByRole("button", { name: "Skip" }));
      await pass(0);
      expect(extraction.line_states!["line-2"]).toEqual(expect.objectContaining({ status: "skipped", revision: 2 }));
      const undo = vi.mocked(toast.success).mock.calls.at(-1)![1] as unknown as { action: { onClick: () => void } };
      act(() => undo.action.onClick());
      await pass(0);
      // The line is back as it was skipped here. The next correction is made on the
      // revision the skip left, so the server keeps it and nothing is asked.
      const bits = line("Drill Bit Set");
      if (!within(bits).queryByLabelText(/^Line total/)) fireEvent.click(within(bits).getByRole("button", { name: "Edit" }));
      fireEvent.change(within(line("Drill Bit Set")).getByLabelText(/^Line total/), { target: { value: "21" } });
      await pass(600);
      expect(vi.mocked(api.put).mock.calls.at(-1)![1]).toEqual(expect.objectContaining({
        expected_revision: 2, line_total_cents: 2100,
      }));
      expect(extraction.line_states!["line-2"]).toEqual(expect.objectContaining({ line_total_cents: 2100, revision: 3 }));
      expect(screen.queryByRole("group", { name: "Two corrections" })).not.toBeInTheDocument();
    });

    it("keeps newer corrections when older ones of this browser reached the server without an answer", async () => {
      signedIn = true;
      // A slow link: each request reaches the server, but its answer never reaches the page.
      const reach = vi.mocked(api.put).getMockImplementation()!;
      vi.mocked(api.put).mockImplementation(async (path, body) => {
        await reach(path, body);
        return new Promise(() => undefined);
      });
      const view = await load();
      fireEvent.change(field(/^Merchant/), { target: { value: "Corner" } });
      correctBits();
      await pass(600);
      expect(extraction.line_states!["line-2"]!.line_total_cents).toBe(1990);
      // The person types more. The tab dies before any of that is sent.
      fireEvent.change(field(/^Merchant/), { target: { value: "Corner Hardware AB" } });
      fireEvent.change(within(line("Drill Bit Set")).getByLabelText(/^Line total/), { target: { value: "21" } });
      vi.mocked(api.put).mockImplementation(() => Promise.reject(new ApiError(0, "network_error", "No connection.")));
      view.unmount();

      // The review is opened again. The server has the first corrections, which this
      // browser sent itself, so the newer ones are still good: they are shown and sent.
      vi.useRealTimers();
      cleanupRender();
      const sent: Array<[string, unknown]> = [];
      vi.mocked(api.put).mockReset();
      vi.mocked(api.put).mockImplementation(async (path, body) => { sent.push([path, body]); return {}; });
      await renderReview(undefined, true, undefined, false, false);
      expect(field(/^Merchant/)).toHaveValue("Corner Hardware AB");
      expect(within(line("Drill Bit Set")).getByText("21")).toBeVisible();
      await waitFor(() => expect(sent.map(([path]) => path).sort()).toEqual([headerPath, draftPath("line-2")]), { timeout: 3000 });
      expect(sent.find(([path]) => path === draftPath("line-2"))![1]).toEqual(expect.objectContaining({ line_total_cents: 2100 }));
      await waitFor(() => expect(localCopies()).toEqual([]), { timeout: 3000 });
      expect(api.post).not.toHaveBeenCalled();
    });

    it("sends what still waits when the page is hidden and when the review goes away", async () => {
      const view = await load();
      correctBits();
      window.dispatchEvent(new Event("pagehide"));
      expect(api.put).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.put).mock.calls[0]![2]).toEqual({ keepalive: true });
      fireEvent.change(within(line("Drill Bit Set")).getByLabelText(/^Line total/), { target: { value: "21" } });
      view.unmount();
      expect(api.put).toHaveBeenCalledTimes(2);
      expect(vi.mocked(api.put).mock.calls[1]).toEqual([
        draftPath("line-2"), expect.objectContaining({ line_total_cents: 2100 }), { keepalive: true },
      ]);
    });

    it("says quietly when a correction could not be kept, tries again, and never blocks the row", async () => {
      await load();
      vi.mocked(api.put).mockRejectedValueOnce(new ApiError(0, "network_error", "No connection."));
      correctBits();
      await pass(600);
      expect(screen.getByText(note)).toHaveAttribute("role", "status");
      expect(within(line("Drill Bit Set")).getByLabelText(/^Brand/)).toHaveValue("Bosch");
      expect(within(line("Drill Bit Set")).getByRole("button", { name: "Add item" })).toBeEnabled();
      expect(within(line("Drill Bit Set")).getByRole("button", { name: "Skip" })).toBeEnabled();
      expect(toast.error).not.toHaveBeenCalled();
      await pass(5000);
      expect(api.put).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(note)).not.toBeInTheDocument();
    });

    it("applies a line right after a correction with the corrected values, and the waiting draft does no harm", async () => {
      vi.mocked(api.post).mockImplementation(async (path) => {
        if (path.endsWith("/extraction/apply")) {
          extraction = { ...extraction, applied_version: "version-1", line_states: {
            ...extraction.line_states, "line-2": { status: "applied", action: "create", item: { id: "item-7", name: "Drill Bit Set" } },
          } };
        }
        return applied;
      });
      await load();
      correctBits();
      fireEvent.click(within(line("Drill Bit Set")).getByRole("button", { name: "Add item" }));
      await pass(0);
      expect(applyCalls()).toHaveLength(1);
      expect(applyCalls()[0]![1]).toEqual(expect.objectContaining({ lines: [expect.objectContaining({
        line_id: "line-2", action: "create", line_total_cents: 1990,
        new_item: expect.objectContaining({ room_id: "room-1", brand: "Bosch" }),
      })] }));
      await pass(5000);
      expect(api.put).not.toHaveBeenCalled();

      // A draft that was on its way when the line was skipped gets 409 and is ignored.
      let refuse!: (error: unknown) => void;
      vi.mocked(api.put).mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
      const drill = line("Cordless Drill");
      fireEvent.click(within(drill).getByRole("button", { name: "Edit" }));
      fireEvent.change(within(drill).getByLabelText(/^Line total/), { target: { value: "140.5" } });
      await pass(600);
      expect(api.put).toHaveBeenCalledTimes(1);
      fireEvent.click(within(drill).getByRole("button", { name: "Skip" }));
      await pass(0);
      refuse(new ApiError(409, "extraction_line_skipped", "This line is skipped."));
      await pass(5000);
      const skip = vi.mocked(api.post).mock.calls.find(([path]) => path.endsWith("/lines/line-1/skip"))!;
      expect(skip[1]).toEqual(expect.objectContaining({ line_total_cents: 14050 }));
      expect(api.put).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(note)).not.toBeInTheDocument();
      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  it("changes a tapped value of a closed line through the bar, with the same checks", async () => {
    vi.mocked(api.get).mockResolvedValue(twoLines);
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BarEditorBoundary>
            <DocumentExtractionReview document={document} />
          </BarEditorBoundary>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Review extraction" }));
    const bits = screen.getByRole("article", { name: "Drill Bit Set" });
    const barField = async () => {
      const field = within(await screen.findByTestId("bar-editor")).getByRole("textbox");
      await waitFor(() => expect(field).toHaveFocus());
      return field;
    };

    await userEvent.click(within(bits).getByRole("button", { name: "Edit line total of line 3" }));
    let field = await barField();
    await userEvent.clear(field);
    await userEvent.type(field, "-5{Enter}");
    expect(within(screen.getByTestId("bar-editor")).getByRole("alert")).toHaveTextContent("Enter an amount");
    await userEvent.clear(field);
    await userEvent.type(field, "19.90{Enter}");
    expect(within(bits).getByRole("button", { name: "Edit line total of line 3" })).toHaveTextContent("19.90");

    await userEvent.click(within(bits).getByRole("button", { name: "Edit name of line 3" }));
    field = await barField();
    await userEvent.clear(field);
    await userEvent.type(field, "Bit set, 20 pieces{Enter}");
    // The new item follows the corrected name, as with the field in the row.
    const renamed = screen.getByRole("article", { name: "Bit set, 20 pieces" });
    expect(within(renamed).getByRole("button", { name: "Edit name of the new item of line 3" })).toHaveTextContent("Bit set, 20 pieces");
    // Selection still works after the edits, and nothing was sent.
    await userEvent.click(within(renamed).getByRole("checkbox"));
    expect(renamed).toHaveAttribute("data-selected", "true");
    expect(api.post).not.toHaveBeenCalled();
  });
});
