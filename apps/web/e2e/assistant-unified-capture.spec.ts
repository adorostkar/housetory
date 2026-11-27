import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

const household = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "Synthetic household",
  default_currency: "USD",
  warranty_reminder_days: 30,
};

const importBatch = {
  id: "00000000-0000-0000-0000-000000000003",
  title: "Assistant item description",
  source_type: "text",
  status: "review",
  original_filename: null,
  content_type: null,
  byte_size: null,
  error: null,
  warnings: [],
  total_entries: 1,
  imported_entries: 0,
  skipped_entries: 0,
  failed_entries: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  completed_at: null,
  source_url: null,
  entry_count: 1,
  entries: [{
    id: "00000000-0000-0000-0000-000000000004",
    source_file_id: null,
    source_path: null,
    source_excerpt: "three Ethernet cables",
    note_title: null,
    proposed: {
      name: "Ethernet cables",
      description: null,
      quantity: 3,
      category: null,
      brand: null,
      model: null,
      serial_number: null,
      room: null,
      storage_location: null,
      purchase: null,
      warranty: null,
      tags: [],
      notes: null,
      collection: null,
      relationships: {},
      field_sources: {},
      confidence: null,
    },
    field_sources: {},
    confidence: null,
    status: "proposed",
    duplicate_candidates: [],
    duplicate_resolution: null,
    matched_item_id: null,
    imported_item_id: null,
    error: null,
    position: 0,
  }],
  files: [],
  vault_tree: [],
  ignored_notes: [],
  broken_links: [],
  metadata: {},
};

const assistantDocumentId = "00000000-0000-0000-0000-000000000013";
const extractionItemId = "00000000-0000-0000-0000-000000000005";
const assistantDocument = {
  id: assistantDocumentId,
  title: "Validation invoice",
  document_type: "invoice",
  original_filename: "invoice.pdf",
  content_type: "application/pdf",
  original_content_type: "application/pdf",
  byte_size: 1024,
  original_byte_size: 1024,
  document_date: null,
  merchant: null,
  notes: "Invoice for the kitchen fridge",
  ocr_status: "succeeded",
  ocr_error: null,
  ocr_confidence: 0.96,
  ocr_processed_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  items: [],
  item_count: 0,
  page_count: 1,
  url: "/documents/assistant-document.pdf",
  original_url: "/documents/assistant-document.pdf",
  extracted_text: "Cordless drill 12.99",
  extracted_metadata: {},
  pages: [],
};
const assistantExtraction = {
  document_id: assistantDocumentId,
  version: "synthetic-extraction-v1",
  source_artifact: "synthetic-local-ocr",
  document_type: "invoice",
  generated_at: "2026-01-01T00:00:00Z",
  purchase_eligible: false,
  fields: {
    merchant: null,
    purchase_date: null,
    document_date: null,
    currency: "USD",
    total_cents: 1299,
    subtotal_cents: 1299,
    tax_cents: 0,
    discount_cents: 0,
    shipping_cents: 0,
    order_number: null,
    brand: "Acme",
    model: null,
    serial_numbers: [],
    warranty_provider: null,
    warranty_start: null,
    warranty_end: null,
    warranty_months: null,
    field_sources: {},
    uncertain_fields: [],
  },
  lines: [{
    id: "synthetic-invoice-line-1",
    line_number: 1,
    kind: "product",
    description: "Cordless drill",
    quantity: 1,
    unit_price_cents: 1299,
    line_total_cents: 1299,
    evidence: { page: 1, line_number: 1, text: "Cordless drill 12.99" },
    warnings: [],
    purchase_eligible: false,
  }],
  warnings: [],
  matches: [{
    line_id: "synthetic-invoice-line-1",
    candidates: [{
      id: extractionItemId,
      name: "Cordless drill",
      brand: "Acme",
      model: "D-1",
      serial_number: null,
      quantity: 1,
      on_loan_quantity: 0,
      room_name: "Garage",
      location_name: "Box 2",
      purchase: null,
      warranty: null,
      reasons: ["Matching item"],
      match_quality: "strong",
      exact_identifier: false,
    }],
    quality: "strong",
    reasons: ["Matching item"],
  }],
  duplicate_documents: [],
  applied: [],
  ai_status: {
    configured: false,
    available: false,
    mode: "disabled",
    provider: "none",
    provider_label: null,
    cloud_consent: false,
    error: null,
  },
};

async function fakeMicrophone(page: Page) {
  await page.addInitScript(() => {
    const getUserMedia = async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      return destination.stream;
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
  });
}

async function fixture(
  page: Page,
  path = "/assistant",
  onSearchQuery?: (body: Record<string, unknown>) => void,
  aiAvailable = false,
  simulateImportRecovery = false,
  simulateImportCompletion = false,
  simulateDocumentRetry = false,
) {
  const errors: string[] = [];
  let activeImportBatch = importBatch;
  const capturedBatches = new Map<string, typeof importBatch>();
  /** The import batch the tool engine queues for a typed item description. */
  const captureItems = (query: string) => {
    const name = /Ethernet/i.test(query) ? "Ethernet cables" : "Validation Monitor";
    const quantity = /(?:three|3)\s+/i.test(query) ? 3 : 1;
    const destinationName = /box 2/i.test(query) ? "Box 2" : "Storage";
    activeImportBatch = {
      ...importBatch,
      id: /Alpha|Beta/.test(query)
        ? /Alpha/.test(query) ? "00000000-0000-0000-0000-000000000021" : "00000000-0000-0000-0000-000000000022"
        : importBatch.id,
      title: /Alpha|Beta/.test(query) ? /Alpha/.test(query) ? "Alpha" : "Beta" : importBatch.title,
      status: simulateImportCompletion ? "processing" : "review",
      entries: importBatch.entries.map((entry) => ({
        ...entry,
        id: /Alpha|Beta/.test(query)
          ? /Alpha/.test(query) ? "00000000-0000-0000-0000-000000000023" : "00000000-0000-0000-0000-000000000024"
          : entry.id,
        source_excerpt: query,
        proposed: {
          ...entry.proposed,
          name,
          quantity,
          room: {
            text: "Utility Room",
            entity_type: "room",
            identifier: null,
            status: "matched",
            matched_id: "00000000-0000-0000-0000-000000000010",
            name: "Utility Room",
            room_id: "00000000-0000-0000-0000-000000000010",
            parent_id: null,
            suggested_parent_id: null,
            candidates: [],
          },
          storage_location: {
            text: destinationName,
            entity_type: "storage_location",
            identifier: null,
            status: "matched",
            matched_id: "00000000-0000-0000-0000-000000000011",
            name: destinationName,
            room_id: "00000000-0000-0000-0000-000000000010",
            parent_id: null,
            suggested_parent_id: null,
            candidates: [],
          },
          purchase: null,
        },
      })),
    };
    if (/Alpha|Beta/.test(query)) {
      activeImportBatch.entries[0]!.proposed.name = /Alpha/.test(query) ? "Alpha cable" : "Beta adapter";
    }
    capturedBatches.set(activeImportBatch.id, activeImportBatch);
    return activeImportBatch;
  };
  let documentPending = false;
  let documentStage = simulateDocumentRetry ? "failed" : "ready";
  let documentGeneration = "synthetic-document-processing";
  let recoveryPolls = 0;
  let voiceReads = 0;
  let recoveryBatch = {
    ...importBatch,
    status: "review",
    metadata: {
      assistant_capture: true,
      ai_used: false,
      ai_error: "AI extraction was interrupted; deterministic proposals are ready to review or retry.",
      progress: { stage: "review", message: "Review the deterministic item description fallback" },
    },
    enhancement: {
      status: "failed",
      job_id: "00000000-0000-0000-0000-000000000012",
      version: "synthetic-version",
      reason: "worker_interrupted",
      error: "AI extraction was interrupted; deterministic proposals are ready to review or retry.",
      provider: "synthetic",
      model: "synthetic-model",
      ai_attempted: true,
      ai_succeeded: false,
      proposals: [] as Array<Record<string, unknown>>,
    },
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/auth/session") {
      return route.fulfill({ json: {
        authenticated: true,
        setup_required: false,
        user: { id: "00000000-0000-0000-0000-000000000002", name: "Reviewer", email: "reviewer@example.invalid", created_at: "2026-01-01T00:00:00Z" },
        household,
        households: [{ ...household, role: "owner", is_current: true, property_count: 0 }],
        role: "owner",
      } });
    }
    if (url.pathname === "/api/v1/search/scopes") {
      return route.fulfill({ json: { items: [{ id: household.id, name: household.name, properties: [] }] } });
    }
    if (url.pathname === "/api/v1/inventory-review/summary") {
      return route.fulfill({
        json: {
          pending_count: 3,
          status_counts: { pending: 3 },
          type_counts: {},
          last_run: null,
          schedule: null,
        },
      });
    }
    if (url.pathname === "/api/v1/inventory-review/captures") {
      if (url.searchParams.get("dismissed") === "true") return route.fulfill({ json: [] });
      const imports = [...capturedBatches.values()].filter((batch) => batch.status !== "completed").map((batch) => ({
        id: batch.id, kind: "import", title: batch.title, status: batch.status,
        generation: "synthetic-import-attempt-1",
      }));
      // A queued capture finishes processing once the review queue has shown it in progress.
      if (simulateImportCompletion && capturedBatches.get(activeImportBatch.id)?.status === "processing") {
        activeImportBatch = { ...activeImportBatch, status: "review" };
        capturedBatches.set(activeImportBatch.id, activeImportBatch);
      }
      return route.fulfill({ json: [
        ...imports,
        ...(documentPending ? [{
          id: assistantDocumentId, kind: "document", title: assistantDocument.title,
          status: documentStage, generation: documentGeneration,
        }] : []),
      ] });
    }
    if (url.pathname === "/api/v1/documents" && route.request().method() === "POST") {
      documentPending = true;
      return route.fulfill({ status: 201, json: assistantDocument });
    }
    if (url.pathname === `/api/v1/documents/${assistantDocumentId}`) {
      return route.fulfill({ json: assistantDocument });
    }
    if (url.pathname === `/api/v1/documents/${assistantDocumentId}/processing`) {
      return route.fulfill({
        json: {
          correlation_id: documentGeneration,
          stage: documentStage,
          started_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:01Z",
          elapsed_ms: 1000,
          local_available: true,
          can_cancel: false,
          can_retry: documentStage === "failed",
          worker_available: true,
          reason: documentStage === "failed" ? "Synthetic worker failure" : null,
          timings: {
            local_queue_ms: 0,
            local_processing_ms: 500,
            ai_queue_ms: null,
            provider_ms: null,
            validation_ms: 0,
          },
        },
      });
    }
    if (url.pathname === `/api/v1/documents/${assistantDocumentId}/processing/retry`) {
      documentGeneration = "synthetic-document-processing-retry";
      documentStage = "ready";
      return route.fulfill({ json: {
        correlation_id: documentGeneration, stage: documentStage, elapsed_ms: 0,
        local_available: true, can_retry: false, can_cancel: false, reason: null,
      } });
    }
    if (url.pathname === `/api/v1/documents/${assistantDocumentId}/extraction/apply`) {
      documentPending = false;
      const body = route.request().postDataJSON() as { request_id: string };
      return route.fulfill({
        json: {
          document: assistantDocument,
          request_id: body.request_id,
          created_item_ids: [],
          updated_item_ids: [],
          linked_item_ids: [extractionItemId],
          skipped_line_ids: [],
          purchase_id: null,
          warranty_item_ids: [],
          warnings: [],
          applied_at: "2026-01-01T00:00:02Z",
          items: [{ id: extractionItemId, name: "Cordless drill" }],
        },
      });
    }
    if (url.pathname === `/api/v1/documents/${assistantDocumentId}/extraction`) {
      return route.fulfill({ json: assistantExtraction });
    }
    if (url.pathname === "/api/v1/ai/status") {
      return route.fulfill({ json: { configured: aiAvailable, available: aiAvailable, data_leaves_server: false, privacy_note: aiAvailable ? "Synthetic AI" : "AI off" } });
    }
    if (url.pathname === "/api/v1/voice/config") {
      return route.fulfill({
        json: {
          transcription_configured: aiAvailable,
          max_duration_seconds: 120,
          max_upload_mb: 20,
          supported_formats: ["audio/webm"],
          retention_note: "Synthetic voice fixture",
        },
      });
    }
    if (url.pathname === "/api/v1/voice" && route.request().method() === "POST") {
      return route.fulfill({
        status: 201,
        json: {
          id: "header-voice-note",
          status: "queued",
          transcript: null,
          transcript_error: null,
        },
      });
    }
    if (url.pathname === "/api/v1/voice/header-voice-note") {
      voiceReads += 1;
      const transcribed = voiceReads > 1;
      return route.fulfill({
        json: {
          id: "header-voice-note",
          status: transcribed ? "transcribed" : "transcribing",
          transcript: transcribed ? "Where is my drill?" : null,
          transcript_error: null,
        },
      });
    }
    if (url.pathname === "/api/v1/assistant/runs") {
      if (route.request().method() === "GET") return route.fulfill({ json: [] });
      if (!aiAvailable) {
        return route.fulfill({ status: 409, json: { detail: {
          code: "assistant_tools_unavailable", message: "Configure AI before retrying.",
        } } });
      }
      // The synthetic tool engine: creation becomes an item capture, Transfer a move proposal.
      const request = route.request().postDataJSON() as { query: string; parent_id?: string };
      const prepared = (name: string, result: Record<string, unknown>) => ({
        state: "awaiting_approval", message: "Prepared for your review.", answer: "",
        steps: [{ call: { name, arguments: {} }, result: { references: [], ...result } }],
      });
      const outcome = /^(?:(?:please|could you|can you|would you)\s+)*(?:add|create)\b|(?:bought|purchased)\b/i.test(request.query)
        ? prepared("prepare_item_capture", {
            summary: "Item capture queued. Review extracted proposals before saving.",
            capture: { kind: "items", id: captureItems(request.query).id },
          })
        : /^Transfer\b/.test(request.query)
          ? prepared("prepare_action", {
              summary: "Move proposal prepared.",
              proposal: {
                id: "00000000-0000-0000-0000-000000000006",
                kind: "move_items",
                state: "ready",
                scope_label: household.name,
                targets: [{
                  id: "00000000-0000-0000-0000-000000000007",
                  name: "Validation Hammer Drill",
                }],
                destination: {
                  id: "00000000-0000-0000-0000-000000000008",
                  name: "Storage",
                },
                changes: {},
                before: {},
              },
            })
          : { state: "completed", message: `Synthetic answer for ${request.query}`, answer: null, steps: [] };
      return route.fulfill({
        json: {
          id: crypto.randomUUID(),
          parent_id: request.parent_id ?? null,
          household_id: household.id,
          property_id: null,
          query: request.query,
          generation: 1,
          model_calls: outcome.steps.length + 1,
          max_model_calls: 8,
          can_retry: false,
          worker_available: true,
          ...outcome,
        },
      });
    }
    if (url.pathname === "/api/v1/search/quick") {
      const query = url.searchParams.get("q") ?? "";
      const results = /\brecord\s+player\b/i.test(query)
        ? [{
            id: "00000000-0000-0000-0000-000000000009",
            kind: "item",
            title: "Record Player",
            subtitle: "Acme · RP-1",
            context: "Living room",
            url: "/items/00000000-0000-0000-0000-000000000009",
            household: null,
            loan: null,
          }]
        : /^transfer\b/i.test(query)
          ? [{
              id: "00000000-0000-0000-0000-000000000007",
              kind: "item",
              title: "Validation Hammer Drill",
              subtitle: "Acme · V-1",
              context: "Garage",
              url: "/items/00000000-0000-0000-0000-000000000007",
              household: null,
              loan: null,
            }]
          : query.trim().toLocaleLowerCase() === "drill"
          ? [{
              id: "00000000-0000-0000-0000-000000000005",
              kind: "item",
              title: "Cordless drill",
              subtitle: "Acme · D-1",
              context: "Garage · Box 2",
              url: "/items/00000000-0000-0000-0000-000000000005",
              household: null,
              loan: null,
            }]
          : [];
      return route.fulfill({
        json: {
          query,
          effective_query: null,
          question_like: query.includes("?") || /^(where|what|when|who|why|how)\b/i.test(query),
          results,
        },
      });
    }
    if (url.pathname === "/api/v1/search/query") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      onSearchQuery?.(body);
      return route.fulfill({
        json: {
          query: body.query,
          mode: "fallback",
          ai_used: false,
          ai_attempted: false,
          direct_match: false,
          ambiguous: false,
          needs_clarification: false,
          answer: `Synthetic answer for ${String(body.query)}`,
          answer_kind: "text",
          interpretation: "",
          filters: {},
          items: [],
          quick_results: [],
          borrowed: [],
          borrowed_total: 0,
          total: 0,
          documents: [],
          locations: [],
          references: [],
          notices: [],
          facts: {},
          tool: null,
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
            privacy_note: "AI off",
          },
          context: {
            scope_key: null,
            last_query: body.query,
            resolved_items: [],
            candidate_items: [],
            loans: [],
          },
        },
      });
    }
    const batchMatch = url.pathname.match(/^\/api\/v1\/imports\/([^/]+)(\/apply)?$/);
    const storedBatch = batchMatch?.[1] ? capturedBatches.get(batchMatch[1]) : undefined;
    if (storedBatch && batchMatch?.[2]) {
      const body = route.request().postDataJSON() as { entries: Array<{ action: string }> };
      const created = body.entries.filter((entry) => entry.action === "import").length;
      const skipped = body.entries.filter((entry) => entry.action === "skip").length;
      const completed = { ...storedBatch, status: "completed", imported_entries: created, skipped_entries: skipped };
      capturedBatches.set(storedBatch.id, completed);
      return route.fulfill({ json: { batch: completed, created, merged: 0, skipped, rejected: 0, failed: 0, failures: [] } });
    }
    if (storedBatch && storedBatch.id !== activeImportBatch.id) return route.fulfill({ json: storedBatch });
    if (url.pathname === `/api/v1/imports/${activeImportBatch.id}/apply`) {
      const body = route.request().postDataJSON() as {
        entries: Array<{ action: string }>;
      };
      const created = body.entries.filter((entry) => entry.action === "import").length;
      const skipped = body.entries.filter((entry) => entry.action === "skip").length;
      activeImportBatch = {
        ...activeImportBatch,
        status: "completed",
        imported_entries: created,
        skipped_entries: skipped,
        completed_at: "2026-01-01T00:01:00Z",
      };
      return route.fulfill({
        json: {
          batch: activeImportBatch,
          created,
          merged: 0,
          skipped,
          rejected: 0,
          failed: 0,
          failures: [],
        },
      });
    }
    if (
      url.pathname === `/api/v1/imports/${activeImportBatch.id}/enhancement/retry` &&
      route.request().method() === "POST"
    ) {
      recoveryBatch = {
        ...recoveryBatch,
        enhancement: { ...recoveryBatch.enhancement, status: "queued", reason: null },
      };
      return route.fulfill({ json: recoveryBatch });
    }
    if (
      url.pathname === `/api/v1/imports/${activeImportBatch.id}/enhancement/accept` &&
      route.request().method() === "POST"
    ) {
      recoveryBatch = {
        ...recoveryBatch,
        entries: recoveryBatch.entries.map((entry) => ({
          ...entry,
          proposed: { ...entry.proposed, name: "AI suggested cables" },
        })),
        enhancement: { ...recoveryBatch.enhancement, status: "accepted" },
      };
      return route.fulfill({ json: recoveryBatch });
    }
    if (url.pathname === `/api/v1/imports/${activeImportBatch.id}`) {
      if (simulateImportRecovery) {
        recoveryPolls += 1;
        if (recoveryPolls === 1) {
          return route.fulfill({
            json: {
              ...importBatch,
              status: "processing",
              metadata: {
                assistant_capture: true,
                ai_used: false,
                progress: { stage: "interpreting", message: "Interpreting your item description" },
              },
              enhancement: {
                status: "running",
                job_id: "00000000-0000-0000-0000-000000000012",
                version: "synthetic-version",
                reason: null,
                error: null,
                provider: "synthetic",
                model: "synthetic-model",
                ai_attempted: true,
                ai_succeeded: false,
                proposals: [],
              },
            },
          });
        }
        if (recoveryBatch.enhancement.status === "queued") {
          recoveryBatch = {
            ...recoveryBatch,
            enhancement: {
              ...recoveryBatch.enhancement,
              status: "ready",
              proposals: [{
                entry_id: importBatch.entries[0]!.id,
                entity_type: "item",
                legacy_identifier: null,
                source_excerpt: "AI suggestion",
                source_path: null,
                source_file_id: null,
                proposed: { ...importBatch.entries[0]!.proposed, name: "AI suggested cables" },
              }],
            },
          };
        }
        return route.fulfill({ json: recoveryBatch });
      }
      return route.fulfill({ json: activeImportBatch });
    }
    if (["/api/v1/items", "/api/v1/properties", "/api/v1/rooms", "/api/v1/storage-locations", "/api/v1/categories", "/api/v1/tags"].includes(url.pathname)) {
      return route.fulfill({ json: { items: [], total: 0, limit: 24, offset: 0 } });
    }
    return route.fulfill({ status: 404, json: { detail: { message: "No synthetic fixture" } } });
  });
  await page.goto(path);
  if (path === "/assistant") {
    await expect(page.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
  }
  return errors;
}

/** The item list's link in the list of rooms: "All items" in the sidebar, "All" in the phone rail. */
const allItems = (page: Page) =>
  page.getByRole("navigation", { name: "Rooms" }).getByRole("link", { name: /^All( items)?$/ });

/**
 * Opens a capture that waits for review. The waiting captures are listed on the Review
 * page, which the assistant's "Review queue" link opens. "Review" there opens the
 * capture in the assistant.
 */
async function openWaitingCapture(page: Page, title: string) {
  await page.getByTestId("assistant-panel").getByRole("link", { name: "Review queue" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await page.getByRole("region", { name: "Pending captures" })
    .getByRole("button", { name: `Review ${title}`, exact: true }).click();
  await expect(page.getByTestId("assistant-panel")).toBeVisible();
}

test("desktop and keyboard-open mobile screenshots show the shared capture composer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await fixture(page, "/");
  const sidebarButton = page.getByRole("button", { name: "Add items" });
  await expect(sidebarButton).toBeVisible();
  expect((await sidebarButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await page.getByTestId("bottom-bar").getByTestId("quick-search-attachment-input").setInputFiles({
    name: "invoice.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 synthetic"),
  });
  const panel = page.getByTestId("assistant-panel");
  await expect(panel.getByText("invoice.pdf")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve("..", "..", "docs", "assistant-unified-capture-desktop.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  const composer = panel.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await composer.focus();
  await expect(panel.getByRole("button", { name: "Attach a file" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve("..", "..", "docs", "assistant-unified-capture-mobile.png") });

  await page.setViewportSize({ width: 390, height: 520 });
  const composerBox = await composer.boundingBox();
  expect(composerBox).not.toBeNull();
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(520);
  await page.screenshot({ path: resolve("..", "..", "docs", "assistant-unified-capture-mobile-keyboard.png") });
  expect(errors).toEqual([]);
});

test("phone bar and rail controls are touch sized, do not overlap, and all work", async ({ page }) => {
  // The five-tab bar was removed on purpose. Its jobs are now done by one bottom bar
  // (rooms button, search field, Add) and by the rail of rooms (All, On loan, More).
  const errors = await fixture(page, "/items");
  await page.setViewportSize({ width: 390, height: 844 });

  const bar = page.getByTestId("bottom-bar");
  const rail = page.getByTestId("room-rail");
  const controls = [
    bar.getByRole("button", { name: "Hide rooms" }),
    bar.locator('button[title="Open assistant"]'),
    bar.getByRole("button", { name: "Attach a file" }),
    bar.getByRole("button", { name: "Record voice search" }),
    bar.getByRole("button", { name: "Add items" }),
  ];
  const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
  expect(boxes.every((box) => box !== null)).toBe(true);
  const slots = boxes.filter((box) => box !== null);
  for (const slot of slots) {
    expect(slot.width).toBeGreaterThanOrEqual(44);
    expect(slot.height).toBeGreaterThanOrEqual(44);
    expect(slot.x).toBeGreaterThanOrEqual(0);
    expect(slot.x + slot.width).toBeLessThanOrEqual(390);
  }
  for (let left = 0; left < slots.length; left += 1) {
    for (let right = left + 1; right < slots.length; right += 1) {
      expect(
        slots[left]!.x + slots[left]!.width <= slots[right]!.x + 0.5 ||
          slots[right]!.x + slots[right]!.width <= slots[left]!.x + 0.5,
      ).toBe(true);
    }
  }
  // The bar ends at the bottom edge of the screen.
  const barBox = await bar.boundingBox();
  expect(barBox).not.toBeNull();
  expect(Math.abs(barBox!.y + barBox!.height - 844)).toBeLessThan(1);

  await rail.getByRole("link", { name: /^On loan/ }).click();
  await expect(page).toHaveURL("/loans");
  await rail.getByRole("link", { name: "All", exact: true }).click();
  await expect(page).toHaveURL("/items");
  await controls[4]!.click();
  await expect(page.getByRole("dialog", { name: "Add items" })).toBeVisible();
  await page.keyboard.press("Escape");
  await rail.getByRole("button", { name: "More", exact: true }).click();
  await rail.getByTestId("rail-more").getByRole("link", { name: "Places" }).click();
  await expect(page).toHaveURL("/rooms");
  expect(errors).toEqual([]);
});

test("header dictation transcribes into an editable query without auto-submitting", async ({ page }) => {
  await fakeMicrophone(page);
  const errors = await fixture(page, "/", undefined, true);
  await page.setViewportSize({ width: 1440, height: 900 });

  const input = page.locator('input[data-quick-search-variant="top"]');
  const attach = page.getByRole("button", { name: "Attach a file" }).first();
  const mic = page.getByRole("button", { name: "Record voice search" }).first();
  expect(await input.inputValue()).toBe("");
  await expect(attach).toBeVisible();
  await expect(mic).toBeVisible();
  const attachBox = await attach.boundingBox();
  const micBox = await mic.boundingBox();
  expect(attachBox).not.toBeNull();
  expect(micBox).not.toBeNull();
  expect(attachBox!.x + attachBox!.width).toBeLessThanOrEqual(micBox!.x);

  const submittedQueries: string[] = [];
  let uploadCount = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && ["/api/v1/assistant/runs", "/api/v1/search/query"].includes(url.pathname)) {
      submittedQueries.push(request.postDataJSON().query);
    }
    if (url.pathname === "/api/v1/voice" && request.method() === "POST") uploadCount += 1;
  });

  await mic.click();
  const recording = page.getByRole("group", { name: "Recording voice search" });
  await expect(recording).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Stop recording" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Transcribing your recording" })).toBeVisible();
  await expect(input).toHaveValue("Where is my drill?", { timeout: 10_000 });
  await expect(page.getByText(/Transcript ready\. Review or edit it/)).toBeVisible();
  await expect(input).toBeFocused();
  expect(uploadCount).toBe(1);
  expect(submittedQueries).toEqual([]);
  await expect(page.getByTestId("assistant-panel")).toHaveCount(0);
  // The transcript is in the field, so it filters the item list. It was not sent.
  await expect(page).toHaveURL("/items?q=Where+is+my+drill%3F");

  await input.fill("Where is my blue drill?");
  await input.press("Enter");
  await expect(page.getByTestId("assistant-panel")).toBeVisible();
  await expect(page.getByText("Synthetic answer for Where is my blue drill?")).toBeVisible();
  expect(submittedQueries).toEqual(["Where is my blue drill?"]);
  expect(errors).toEqual([]);
});

test("cancelling header dictation sends no audio or search", async ({ page }) => {
  await fakeMicrophone(page);
  const errors = await fixture(page, "/", undefined, true);
  const input = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  const mic = page.getByRole("button", { name: "Record voice search" }).first();
  let uploads = 0;
  let searches = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/voice" && request.method() === "POST") uploads += 1;
    if (request.method() === "POST" && ["/api/v1/assistant/runs", "/api/v1/search/query"].includes(url.pathname)) searches += 1;
  });
  await mic.click();
  await expect(page.getByRole("group", { name: "Recording voice search" })).toBeVisible();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Cancel recording" }).click();
  await expect(page.getByText("Recording cancelled. Nothing was sent.")).toBeVisible();
  await expect(mic).toBeFocused();
  expect(await input.inputValue()).toBe("");
  expect(uploads).toBe(0);
  expect(searches).toBe(0);
  await expect(page.getByTestId("assistant-panel")).toHaveCount(0);
  await expect(page).toHaveURL("/items");
  expect(errors).toEqual([]);
});

test("header microphone explains unavailable transcription and links to AI settings", async ({ page }) => {
  await fixture(page, "/", undefined, false);
  const mic = page.getByRole("button", { name: "Record voice search" }).first();
  await expect(mic).toBeVisible();
  await mic.click();
  await expect(page.getByRole("alert")).toContainText("Voice transcription is not configured");
  await expect(page.getByRole("link", { name: "AI settings" })).toHaveAttribute("href", "/settings/ai");
});

test("mobile header keeps microphone and attachment controls inside the search box", async ({ page }) => {
  await fixture(page, "/");
  await page.setViewportSize({ width: 390, height: 844 });

  const input = page.locator('input[data-quick-search-input="true"]');
  const attach = page.getByRole("button", { name: "Attach a file" });
  const mic = page.getByRole("button", { name: "Record voice search" });
  await expect(input).toBeVisible();
  await expect(attach).toBeVisible();
  await expect(mic).toBeVisible();

  const [inputBox, attachBox, micBox] = await Promise.all([
    input.boundingBox(),
    attach.boundingBox(),
    mic.boundingBox(),
  ]);
  expect(inputBox).not.toBeNull();
  expect(attachBox).not.toBeNull();
  expect(micBox).not.toBeNull();
  // The search box is the bordered field. The text input and the two buttons sit in it, in a row.
  const fieldBox = await input.locator("xpath=..").boundingBox();
  expect(fieldBox).not.toBeNull();
  expect(inputBox!.x).toBeGreaterThanOrEqual(fieldBox!.x);
  expect(inputBox!.x + inputBox!.width).toBeLessThanOrEqual(attachBox!.x);
  expect(attachBox!.x + attachBox!.width).toBeLessThanOrEqual(micBox!.x);
  expect(micBox!.x + micBox!.width).toBeLessThanOrEqual(fieldBox!.x + fieldBox!.width);
  expect(micBox!.y + micBox!.height / 2).toBeCloseTo(fieldBox!.y + fieldBox!.height / 2, 0);
});

test("the header entry opens the assistant panel without separate assistant navigation", async ({ page }) => {
  const errors = await fixture(page, "/");
  await expect(page.getByRole("link", { name: "Assistant", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open assistant panel" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add items" })).toBeVisible();
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("Where is my drill?");
  const assistantRequest = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/v1/assistant/runs" && request.method() === "POST",
  );
  await page.getByRole("option", { name: /Ask the assistant:/ }).click();
  await assistantRequest;
  const panel = page.getByTestId("assistant-panel");
  await expect(panel.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
  // A question that was sent leaves the field, and no longer filters the item list.
  await expect(page).toHaveURL(/\/items#assistant$/);
  await expect(headerSearch).toHaveValue("");
  await headerSearch.fill("What is in my garage?");
  await expect(headerSearch).toHaveValue("What is in my garage?");
  await panel.getByRole("button", { name: "Close assistant" }).click();
  await expect(headerSearch).toBeVisible();
  expect(errors).toEqual([]);
});

test("assistant launcher resumes without typing, shows unresolved reviews, and closes with browser Back", async ({ page }) => {
  const errors = await fixture(page, "/");
  let interpreted = 0;
  let searches = 0;
  let reviewWrites = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/assistant/runs" && request.method() === "POST") interpreted += 1;
    if (path === "/api/v1/search/query") searches += 1;
    if (path.startsWith("/api/v1/inventory-review/suggestions") && request.method() !== "GET") reviewWrites += 1;
  });

  await expect(page).toHaveURL(/\/items$/);
  const launcher = page.getByRole("button", { name: "Open assistant, 3 unresolved reviews" });
  await expect(launcher).toBeVisible();
  await expect(launcher).toContainText("3");
  await launcher.click();
  await expect(page.getByTestId("assistant-panel")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
  await expect(page).toHaveURL(/\/items#assistant$/);
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await expect(headerSearch).toBeVisible();
  await headerSearch.fill("record player");
  await expect(headerSearch).toHaveValue("record player");
  await expect(page.getByTestId("assistant-panel")).toBeVisible();
  await headerSearch.fill("");
  await page.goBack();
  await expect(page).toHaveURL(/\/items$/);
  await expect(page.getByTestId("assistant-panel")).toHaveCount(0);
  await expect(launcher).toBeFocused();
  await expect(launcher).toContainText("3");
  expect(interpreted).toBe(0);
  expect(searches).toBe(0);
  expect(reviewWrites).toBe(0);
  expect(errors).toEqual([]);
});

test("legacy Search and Assistant URLs redirect into the unified shell", async ({ page }) => {
  const errors = await fixture(page, "/search?q=drill");
  await expect(page).toHaveURL(/\/items\?q=drill$/);
  await expect(page.getByTestId("assistant-panel")).toHaveCount(0);

  await page.goto("/assistant?q=Where%20is%20my%20drill%3F");
  const panel = page.getByTestId("assistant-panel");
  await expect(panel.getByText("Synthetic answer for Where is my drill?")).toBeVisible();
  await expect(page).toHaveURL(/\/items#assistant$/);
  await expect(page.getByTestId("assistant-panel")).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile search entry stays reachable while scrolling and the assistant sheet fits a resized viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await fixture(page, "/");
  const input = page.locator('input[data-quick-search-input="true"]');
  const launcher = page.getByRole("button", { name: "Open assistant, 3 unresolved reviews" });
  await expect(input).toBeVisible();
  await expect(launcher).toBeVisible();
  // Search has no page of its own: it is not among the More choices of the rail.
  const rail = page.getByTestId("room-rail");
  await rail.getByRole("button", { name: "More", exact: true }).click();
  await expect(rail.getByTestId("rail-more").getByRole("link")).not.toHaveCount(0);
  await expect(rail.getByTestId("rail-more").getByRole("link", { name: "Search", exact: true })).toHaveCount(0);
  await rail.getByRole("button", { name: "Close", exact: true }).click();

  await page.evaluate(() => window.scrollTo(0, 900));
  await expect(input).toBeInViewport();
  await launcher.click();
  const panel = page.getByTestId("assistant-panel");
  await expect(panel).toBeVisible();
  await page.setViewportSize({ width: 390, height: 430 });
  const composer = panel.getByRole("textbox", { name: "Ask the Housetory assistant" });
  const send = panel.getByRole("button", { name: "Send question" });
  await expect.poll(async () => {
    const box = await composer.boundingBox();
    return box ? box.y + box.height : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(430);
  await expect.poll(async () => {
    const box = await send.boundingBox();
    return box ? box.y + box.height : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(430);
  await expect(panel.getByRole("button", { name: "Close assistant" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("completed item capture notifies once and opens its review without resolving it", async ({ page }) => {
  await page.clock.install();
  const errors = await fixture(page, "/", undefined, true, false, true);
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("Add a Validation Monitor to Storage");
  await headerSearch.press("Enter");
  const panel = page.getByTestId("assistant-panel");
  await expect(panel.getByLabel("Assistant capture status"))
    .toContainText("Item capture queued. Review extracted proposals before saving.");
  await panel.getByRole("button", { name: "Close assistant" }).click();
  await allItems(page).click();
  await expect(page).toHaveURL(/\/items$/);

  // A capture queued by the tool engine is first noticed by the review queue's idle poll.
  await page.clock.fastForward(30_000);
  await expect(page.getByText("Assistant item description ready for review")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Assistant item description ready for review")).toHaveCount(1);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("region", { name: "Assistant item review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open assistant, 4 unresolved reviews" })).toContainText("4");
  await expect(page.getByText("Assistant item description ready for review")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("attached invoice flows through extraction, notification, and explicit approval", async ({ page }) => {
  const errors = await fixture(page, "/");
  let applyRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/v1/documents/${assistantDocumentId}/extraction/apply`) {
      applyRequests += 1;
    }
  });
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("This is for the kitchen fridge");
  await page.getByTestId("quick-search-attachment-input").setInputFiles({
    name: "invoice.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 synthetic invoice"),
  });
  const panel = page.getByTestId("assistant-panel");
  const composer = panel.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await expect(composer).toHaveValue("This is for the kitchen fridge");
  await expect(panel.getByText("invoice.pdf")).toBeVisible();
  await panel.getByLabel("Document type").selectOption("invoice");
  await panel.getByRole("button", { name: "Send question" }).click();

  await expect(panel.getByText("Document saved. Its reading state and what was read are shown below.")).toBeVisible();
  await expect(page.getByText("Validation invoice ready for review")).toHaveCount(1);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(panel.getByRole("region", { name: "Assistant document review" })).toContainText("Validation invoice");
  await expect(page.getByRole("button", { name: "Open assistant, 4 unresolved reviews" })).toContainText("4");
  await panel.getByRole("button", { name: "Review extraction" }).click();
  // Lines are closed rows and nothing is selected to begin with.
  await expect(panel.getByRole("button", { name: /^Edit name of line/ }).first()).toHaveText("Cordless drill");
  expect(applyRequests).toBe(0);
  await panel.getByRole("button", { name: "Select all" }).click();
  await panel.getByRole("button", { name: /^Apply: / }).click();
  await expect.poll(() => applyRequests).toBe(1);
  await expect(page.getByText("Reviewed extraction applied")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open assistant, 3 unresolved reviews" })).toContainText("3");

  await page.reload();
  await page.evaluate(() => {
    const detail = {
      id: "00000000-0000-0000-0000-000000000013",
      kind: "document",
      householdId: "00000000-0000-0000-0000-000000000001",
      generation: "synthetic-document-processing",
      title: "Validation invoice ready for review",
      description: "Review the extracted details before applying.",
    };
    window.dispatchEvent(new CustomEvent("housetory:assistant-task-completed", { detail }));
  });
  await expect(page.getByText("Validation invoice ready for review")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("normal header submission opens the assistant without selecting its prompt", async ({ page }) => {
  const errors = await fixture(page, "/");
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("Where is my drill?");
  await headerSearch.press("Enter");
  await expect(page.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
  await expect(headerSearch).toBeVisible();
  await expect(page).toHaveURL(/\/items#assistant$/);
  expect(errors).toEqual([]);
});

test("ordinary lookup submitted from Items stays on the lightweight item search", async ({ page }) => {
  const errors = await fixture(page, "/items");
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("drill");
  await expect(page.getByRole("option", { name: /Cordless drill/ })).toBeVisible();
  await headerSearch.press("Enter");
  await expect(page).toHaveURL(/\/items\?q=drill$/);
  await expect(page.getByTestId("assistant-panel")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("ordinary lookup submitted from Overview uses results without opening conversation", async ({ page }) => {
  const errors = await fixture(page, "/");
  let interpreted = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && ["/api/v1/search/query", "/api/v1/assistant/runs"].includes(path)) interpreted += 1;
  });
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("drill");
  await expect(page.getByRole("option", { name: /Cordless drill/ })).toBeVisible();
  await headerSearch.press("Enter");
  await expect(page).toHaveURL(/\/items\?q=drill/);
  await expect(page.getByTestId("assistant-panel")).toHaveCount(0);
  expect(interpreted).toBe(0);
  expect(errors).toEqual([]);
});

test("selecting a quick match opens its item record without assistant interpretation", async ({ page }) => {
  const errors = await fixture(page, "/");
  let interpreted = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && ["/api/v1/search/query", "/api/v1/assistant/runs"].includes(path)) interpreted += 1;
  });
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("drill");
  await page.getByRole("option", { name: /Cordless drill/ }).click();
  await expect(page).toHaveURL(/\/items\/00000000-0000-0000-0000-000000000005$/);
  expect(interpreted).toBe(0);
  expect(errors).toEqual([]);
});

test("question submitted from Overview enters conversation on ordinary Enter", async ({ page }) => {
  const errors = await fixture(page, "/");
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("Where is my drill?");
  await headerSearch.press("Enter");
  const panel = page.getByTestId("assistant-panel");
  await expect(panel.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
  await expect(panel.getByText("Synthetic answer for Where is my drill?")).toBeVisible();
  expect(errors).toEqual([]);
});

test("question submitted from Items enters conversation on ordinary Enter", async ({ page }) => {
  const errors = await fixture(page, "/items");
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("Where is my drill?");
  await headerSearch.press("Enter");
  const panel = page.getByTestId("assistant-panel");
  await expect(panel.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
  await expect(panel.getByText("Synthetic answer for Where is my drill?")).toBeVisible();
  await expect(page).toHaveURL(/\/items(?:\?|#)/);
  expect(errors).toEqual([]);
});

test("an item capture prepared by the assistant is reviewed and explicitly applied", async ({ page }) => {
  const errors = await fixture(page, "/", undefined, true);
  const query = "I bought three Ethernet cables; put them in box 2.";
  const assistantQueries: string[] = [];
  const legacyRequests: string[] = [];
  const applyBodies: Array<{ entries: Array<{ action: string; proposed: { name: string; quantity: number } }> }> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/assistant/runs" && request.method() === "POST") {
      assistantQueries.push(request.postDataJSON().query);
    }
    // The browser neither searches the text nor uploads it as an import itself.
    if (request.method() === "POST" && ["/api/v1/search/query", "/api/v1/imports"].includes(url.pathname)) {
      legacyRequests.push(url.pathname);
    }
    if (/\/api\/v1\/imports\/[^/]+\/apply$/.test(url.pathname)) {
      applyBodies.push(request.postDataJSON());
    }
  });

  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill(query);
  expect(assistantQueries).toEqual([]);
  await headerSearch.press("Enter");

  const panel = page.getByTestId("assistant-panel");
  const composer = panel.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await expect(composer).toBeVisible();
  await panel.getByRole("button", { name: "Review items" }).click();
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  const itemName = panel.getByLabel("Item name");
  await expect(itemName).toHaveValue("Ethernet cables");
  await expect(panel.getByLabel("Quantity", { exact: true })).toHaveValue("3");
  await expect(panel.getByText(/Utility Room.*Box 2/).first()).toBeVisible();
  await expect(panel.getByRole("note", { name: "Local search mode" })).toHaveCount(0);
  expect(assistantQueries).toEqual([query]);
  expect(legacyRequests).toEqual([]);
  expect(applyBodies).toEqual([]);

  await itemName.fill("Reviewed Ethernet cables");
  await panel.getByRole("checkbox", { name: "Select Reviewed Ethernet cables" }).check();
  await panel.getByRole("button", { name: /^Add \d+ selected items?$/ }).first().click();
  // One row was added by itself: a short message says so.
  await expect(page.getByText("1 item added", { exact: true })).toBeVisible();
  expect(applyBodies).toHaveLength(1);
  expect(applyBodies[0].entries[0]).toMatchObject({
    action: "import",
    proposed: { name: "Reviewed Ethernet cables", quantity: 3 },
  });
  expect(errors).toEqual([]);
});

test("without an assistant model a typed item description is only searched", async ({ page }) => {
  const errors = await fixture(page, "/", undefined, false);
  const requests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && ["/api/v1/assistant/runs", "/api/v1/search/query", "/api/v1/imports"].includes(path)) {
      requests.push(path);
    }
  });
  const query = "Add one Validation Monitor to Storage";
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill(query);
  await headerSearch.press("Enter");
  const panel = page.getByTestId("assistant-panel");
  await expect(panel.getByText(`Synthetic answer for ${query}`)).toBeVisible();
  await expect(panel.getByRole("note", { name: "Local search mode" })).toBeVisible();
  await expect(panel.getByLabel("Assistant capture status")).toHaveCount(0);
  expect(requests).toEqual(["/api/v1/assistant/runs", "/api/v1/search/query"]);
  expect(errors).toEqual([]);
});

test("interrupted primary capture polling reaches local review and retry", async ({ page }) => {
  const errors = await fixture(
    page,
    `/imports/${importBatch.id}`,
    undefined,
    false,
    true,
  );

  await expect(page.getByText("Local results are ready to review. Optional AI never applies inventory changes.")).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const itemName = page.getByLabel("Item name");
  await expect(itemName).toHaveValue("Ethernet cables");
  await itemName.fill("User-edited Ethernet cables");
  await expect(page.getByRole("button", { name: "Retry AI only" })).toBeVisible();
  await page.getByRole("button", { name: "Retry AI only" }).click();
  const reviewSuggestions = page.getByText("Review AI suggestions", { exact: true });
  await expect(reviewSuggestions).toBeVisible();
  await expect(itemName).toHaveValue("User-edited Ethernet cables");
  await reviewSuggestions.click();
  await page.getByRole("button", { name: "Load suggestions into review" }).click();
  await expect(itemName).toHaveValue("User-edited Ethernet cables");
  await expect(page.getByText("Suggestions loaded into review. Manual edits were kept; apply is still separate.")).toBeVisible();
  expect(errors).toEqual([]);
});

test("assistant composer and Send stay inside short desktop and keyboard-sized mobile viewports", async ({ page }) => {
  const errors = await fixture(page, "/");
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  const panel = page.getByTestId("assistant-panel");

  await page.setViewportSize({ width: 1440, height: 600 });
  await headerSearch.fill("Where is my drill?");
  await headerSearch.press("Enter");
  const composer = panel.getByRole("textbox", { name: "Ask the Housetory assistant" });
  const send = panel.getByRole("button", { name: "Send question" });
  await expect(composer).toBeVisible();
  await expect(send).toBeVisible();

  const assertControlsFit = async (height: number) => {
    for (const control of [composer, send]) {
      await expect.poll(async () => {
        const bounds = await control.boundingBox();
        return Boolean(bounds && bounds.y >= 0 && bounds.y + bounds.height <= height);
      }).toBe(true);
    }
  };
  await assertControlsFit(600);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.setViewportSize({ width: 390, height: 520 });
  await expect(composer).toBeVisible();
  await expect(send).toBeVisible();
  await assertControlsFit(520);
  expect(errors).toEqual([]);
});

test("Transfer action submitted from Items reaches review without applying automatically", async ({ page }) => {
  const errors = await fixture(page, "/items", undefined, true);
  const assistantQueries: string[] = [];
  const applyRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/assistant/runs" && request.method() === "POST") {
      assistantQueries.push(request.postDataJSON().query);
    }
    if (/\/api\/v1\/assistant\/actions\/proposals\/[^/]+\/apply$/.test(url.pathname)) {
      applyRequests.push(url.pathname);
    }
  });
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  const query = "Transfer Validation Hammer Drill to Storage";
  await headerSearch.fill(query);
  await expect(page.getByRole("option", { name: /^Validation Hammer Drill/ })).toBeVisible();
  expect(assistantQueries).toEqual([]);
  await headerSearch.press("Enter");

  const panel = page.getByTestId("assistant-panel");
  await expect(panel.getByLabel("Action review")).toContainText("Validation Hammer Drill");
  await expect(panel.getByLabel("Action review")).toContainText("Storage");
  await expect(panel.getByRole("button", { name: "Apply" })).toBeVisible();
  await expect(page).toHaveURL(/\/items(?:\?|#|$)/);
  expect(assistantQueries).toEqual([query]);
  expect(applyRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("record player remains a lightweight lookup from Items", async ({ page }) => {
  const errors = await fixture(page, "/items");
  const assistantQueries: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/assistant/runs" && request.method() === "POST") {
      assistantQueries.push(request.postDataJSON().query);
    }
  });
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("record player");
  await expect(page.getByRole("option", { name: /Record Player/ })).toBeVisible();
  await headerSearch.press("Enter");

  await expect(page.getByTestId("assistant-panel")).toHaveCount(0);
  await expect(page).toHaveURL(/\/items\?/);
  expect(assistantQueries).toEqual([]);
  expect(errors).toEqual([]);
});

test("record player remains a lightweight lookup from Overview", async ({ page }) => {
  const errors = await fixture(page, "/");
  const assistantQueries: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/assistant/runs" && request.method() === "POST") {
      assistantQueries.push(request.postDataJSON().query);
    }
  });
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("record player");
  await expect(page.getByRole("option", { name: /Record Player/ })).toBeVisible();
  await headerSearch.press("Enter");

  await expect(page.getByTestId("assistant-panel")).toHaveCount(0);
  await expect(page).toHaveURL(/\/items\?/);
  expect(assistantQueries).toEqual([]);
  expect(errors).toEqual([]);
});

test("fresh header requests start without prior turns while panel follow-ups retain context", async ({ page }) => {
  const searchBodies: Record<string, unknown>[] = [];
  const errors = await fixture(page, "/", (body) => searchBodies.push(body));
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  const firstQuestion = "Where is my drill?";
  await headerSearch.fill(firstQuestion);
  const firstSearch = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/v1/search/query" &&
    request.postDataJSON().query === firstQuestion,
  );
  await headerSearch.press("Enter");
  await firstSearch;
  const panel = page.getByTestId("assistant-panel");
  const composer = panel.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await expect(panel.getByText(`Synthetic answer for ${firstQuestion}`)).toBeVisible();
  expect(searchBodies[0]).toMatchObject({ query: firstQuestion, history: [] });
  expect(searchBodies[0]).not.toHaveProperty("context");

  const followUp = "And when did I last use it?";
  await composer.fill(followUp);
  const followUpSearch = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/v1/search/query" &&
    request.postDataJSON().query === followUp,
  );
  await composer.press("Enter");
  await followUpSearch;
  await expect(panel.getByText(`Synthetic answer for ${followUp}`)).toBeVisible();
  await composer.fill("I still need to add the extension cord.");
  expect(searchBodies[1]?.history).toEqual([
    { role: "user", content: firstQuestion },
    { role: "assistant", content: `Synthetic answer for ${firstQuestion}` },
  ]);

  const freshQuestion = "What else is in my garage?";
  await headerSearch.fill(freshQuestion);
  const freshSearch = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/v1/search/query" &&
    request.postDataJSON().query === freshQuestion,
  );
  await headerSearch.press("Enter");
  await freshSearch;
  await expect(panel.getByText(`Synthetic answer for ${freshQuestion}`)).toBeVisible();
  await expect(panel.getByText(`Synthetic answer for ${firstQuestion}`)).toBeVisible();
  await expect(panel.getByText(`Synthetic answer for ${followUp}`)).toBeVisible();
  await expect(composer).toHaveValue("I still need to add the extension cord.");
  expect(searchBodies[2]).toMatchObject({ query: freshQuestion, history: [] });
  expect(searchBodies[2]).not.toHaveProperty("context");
  expect(errors).toEqual([]);
});

test("item review edits survive closing the panel and switching views", async ({ page }) => {
  const errors = await fixture(page, "/", undefined, true);
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("I bought three Ethernet cables; put them in box 2.");
  await headerSearch.press("Enter");

  const panel = page.getByTestId("assistant-panel");
  const itemName = panel.getByLabel("Item name");
  await panel.getByRole("button", { name: "Review items" }).click();
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(itemName).toHaveValue("Ethernet cables");
  await itemName.fill("Blue Ethernet cable");
  await panel.getByRole("checkbox", { name: "Select Blue Ethernet cable" }).uncheck();

  await panel.getByRole("button", { name: "Close assistant" }).click();
  await allItems(page).click();
  await expect(page).toHaveURL(/\/items$/);
  await page.evaluate((path) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/imports/${importBatch.id}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const fullPageReview = page.getByLabel("Item name");
  await expect(fullPageReview).toHaveValue("Blue Ethernet cable");
  await expect(
    page.getByRole("checkbox", { name: "Select Blue Ethernet cable" }),
  ).not.toBeChecked();
  expect(errors).toEqual([]);
});

test("browser file picker displays a preview that can be removed", async ({ page }) => {
  const errors = await fixture(page);
  await page.locator('form input[type="file"]').setInputFiles({
    name: "invoice.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 synthetic"),
  });
  await expect(page.getByText("invoice.pdf")).toBeVisible();
  await page.getByRole("button", { name: "Remove attachment" }).click();
  await expect(page.getByText("invoice.pdf")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("attaching from the header keeps the accompanying text in the capture composer", async ({ page }) => {
  const errors = await fixture(page, "/");
  await page.getByRole("combobox", { name: "Search or ask about your inventory" })
    .fill("This invoice is for the kitchen fridge");
  await page.getByTestId("bottom-bar").getByTestId("quick-search-attachment-input").setInputFiles({
    name: "invoice.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 synthetic"),
  });
  const composer = page.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await expect(composer).toHaveValue("This invoice is for the kitchen fridge");
  await expect(page.getByText("invoice.pdf")).toBeVisible();
  expect(errors).toEqual([]);
});

test("parked attachment survives a fresh header question without uploading or consuming the draft", async ({ page }) => {
  const errors = await fixture(page, "/", undefined, true);
  let documentUploads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/documents" && request.method() === "POST") {
      documentUploads += 1;
    }
  });

  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("This invoice is for the kitchen fridge");
  await page.getByTestId("quick-search-attachment-input").setInputFiles({
    name: "invoice.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 synthetic invoice"),
  });
  const panel = page.getByTestId("assistant-panel");
  const composer = panel.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await expect(composer).toHaveValue("This invoice is for the kitchen fridge");
  await expect(panel.getByText("invoice.pdf")).toBeVisible();
  await panel.getByRole("button", { name: "Close assistant" }).click();
  await allItems(page).click();
  await expect(page).toHaveURL(/\/items$/);
  // Opening the list again clears the field, which had filtered the list. Wait for that
  // before typing the next question.
  await expect(headerSearch).toHaveValue("");
  await headerSearch.fill("Where is my drill?");
  await headerSearch.press("Enter");
  await expect(panel.getByText("Synthetic answer for Where is my drill?")).toBeVisible();
  await expect(composer).toHaveValue("This invoice is for the kitchen fridge");
  await expect(panel.getByText("invoice.pdf")).toBeVisible();
  await headerSearch.fill("Add one Validation Monitor to Storage");
  await headerSearch.press("Enter");
  await panel.getByRole("button", { name: "Review items" }).click();
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(panel.getByLabel("Item name")).toHaveValue("Validation Monitor");
  await expect(composer).toHaveValue("This invoice is for the kitchen fridge");
  await expect(panel.getByText("invoice.pdf")).toBeVisible();
  expect(documentUploads).toBe(0);
  expect(errors).toEqual([]);
});

test("multiple captures restore after reload and an older notification opens its exact review until Apply resolves it", async ({ page }) => {
    await page.clock.install();
    const errors = await fixture(page, "/", undefined, true);
    const header = page.getByRole("combobox", { name: "Search or ask about your inventory" });
    const panel = page.getByTestId("assistant-panel");
    await header.fill("Add an Alpha cable to Storage");
    await header.press("Enter");
    await expect(panel.getByLabel("Assistant capture status")).toBeVisible();
    await panel.getByRole("button", { name: "Close assistant" }).click();
    await header.fill("Add a Beta adapter to Storage");
    await header.press("Enter");
    await expect(panel.getByLabel("Assistant capture status")).toHaveCount(2);
    // Captures queued by the tool engine are first noticed by the review queue's idle poll.
    await page.clock.fastForward(30_000);
    await expect(page.getByText("Alpha ready for review", { exact: true })).toBeVisible();
    await expect(page.getByText("Beta ready for review", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open assistant, 5 unresolved reviews" })).toBeVisible();
    await page.locator("[data-sonner-toast][data-front='true']").hover();
    await page.locator("[data-sonner-toast]").filter({ hasText: "Alpha ready for review" }).getByRole("button", { name: "Review", exact: true }).click();
    await panel.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(panel.getByLabel("Item name")).toHaveValue("Alpha cable");
    await panel.getByLabel("Item name").fill("Reviewed Alpha cable");
    await panel.getByRole("button", { name: "Close assistant" }).click();
    await allItems(page).click();
    await page.getByRole("button", { name: "Open assistant, 5 unresolved reviews" }).click();
    await expect(panel.getByLabel("Item name")).toHaveValue("Reviewed Alpha cable");
    await header.fill("ordinary lookup");
    await expect(page).toHaveURL(/q=ordinary\+lookup.*#assistant$/);
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel("Item name")).toHaveValue("Reviewed Alpha cable");
    await page.reload();
    await expect(page.getByRole("button", { name: "Open assistant, 5 unresolved reviews" })).toBeVisible();
    await openWaitingCapture(page, "Alpha");
    await panel.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(panel.getByLabel("Item name")).toHaveValue("Alpha cable");
    await expect(page.getByRole("button", { name: "Open assistant, 5 unresolved reviews" })).toBeVisible();
    await panel.getByRole("checkbox", { name: "Select Alpha cable" }).check();
    await panel.getByRole("button", { name: /^Add \d+ selected items?$/ }).first().click();
    await expect(page.getByRole("button", { name: "Open assistant, 4 unresolved reviews" })).toBeVisible();
    // The applied capture has left the list of waiting captures. The other one is still there.
    await panel.getByRole("link", { name: "Review queue" }).click();
    const waiting = page.getByRole("region", { name: "Pending captures" });
    await expect(waiting.getByRole("button", { name: "Review Beta", exact: true })).toBeVisible();
    await expect(waiting.getByRole("button", { name: "Review Alpha", exact: true })).toHaveCount(0);
    await waiting.getByRole("button", { name: "Review Beta", exact: true }).click();
    await panel.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(panel.getByRole("textbox", { name: "Item name", exact: true })).toHaveValue("Beta adapter");
    expect(errors).toEqual([]);
  });

  test("mobile assistant traps focus, restores it on Back and keeps touch controls inside a narrow keyboard viewport", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 520 });
    const errors = await fixture(page, "/");
    for (const name of ["Attach a file", "Record voice search"]) {
      const box = await page.getByRole("button", { name }).boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const launcher = page.getByRole("button", { name: "Open assistant, 3 unresolved reviews" });
    await launcher.click();
    const panel = page.getByTestId("assistant-panel");
    await expect(panel).toBeVisible();
    for (let index = 0; index < 25; index += 1) {
      await page.keyboard.press(index % 2 ? "Tab" : "Shift+Tab");
      expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    // The page behind the sheet, with its rail of rooms and its bar, is out of reach.
    for (const part of ["room-rail", "bottom-bar"]) {
      expect(await page.getByTestId(part).evaluate((element) =>
        Boolean(element.closest('[aria-hidden="true"], [inert]')),
      )).toBe(true);
    }
    for (const name of ["Attach a file", "Dictate question", "Send question", "Close assistant"]) {
      const box = await panel.getByRole("button", { name, exact: true }).boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      expect(box!.y + box!.height).toBeLessThanOrEqual(520);
    }
    await page.goBack();
    await expect(panel).toHaveCount(0);
    await expect(launcher).toBeFocused();
    await launcher.click();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(launcher).toBeFocused();
    expect(errors).toEqual([]);
  });

  test("a failed document reopens after reload and retry completion notifies once for the new attempt", async ({ page }) => {
    await page.clock.install();
    const errors = await fixture(page, "/", undefined, true, false, false, true);
    await page.getByTestId("quick-search-attachment-input").setInputFiles({
      name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 synthetic"),
    });
    const panel = page.getByTestId("assistant-panel");
    await panel.getByLabel("Document type").selectOption("invoice");
    await panel.getByRole("button", { name: "Send question" }).click();
    await expect(page.getByText("Validation invoice needs attention", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Close assistant" }).click();
    await page.reload();
    await page.getByRole("button", { name: "Open assistant, 4 unresolved reviews" }).click();
    await openWaitingCapture(page, "Validation invoice");
    await panel.getByRole("button", { name: "Retry processing" }).click();
    // The review in the panel shows the new attempt at once. The message comes when the
    // list of waiting captures is read again, which it is every half minute when idle.
    await page.clock.fastForward(30_000);
    await expect(page.getByText("Validation invoice ready for review", { exact: true })).toHaveCount(1);
    await panel.getByRole("button", { name: "Close assistant" }).click();
    await allItems(page).click();
    await expect(page.getByText("Validation invoice ready for review", { exact: true })).toHaveCount(1);
    await page.reload();
    await expect(page.getByText("Validation invoice ready for review", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Open assistant, 4 unresolved reviews" }).click();
    await openWaitingCapture(page, "Validation invoice");
    await panel.getByRole("button", { name: "Review extraction" }).click();
    await panel.getByRole("button", { name: "Select all" }).click();
    await panel.getByRole("button", { name: /^Apply: / }).click();
    await expect(page.getByRole("button", { name: "Open assistant, 3 unresolved reviews" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("photo processing survives closure and reload, recovers a failed attempt and resolves only after approved import", async ({ page }) => {
    const errors = await fixture(page, "/");
    let photoId = "00000000-0000-0000-0000-000000000030";
    let exists = false;
    let status = "queued";
    let attempt = 1;
    let converted = false;
    let applied = false;
    let conversions = 0;
    const caption = "A synthetic test box in Storage.";
    const roomId = "00000000-0000-0000-0000-000000000040";
    const photoBatch = {
      ...importBatch,
      title: "Recovered photo",
      metadata: { ai_used: true, extraction_method: "vision", ai_provider: "synthetic", ai_model: "synthetic-vision" },
      entries: importBatch.entries.map((entry) => ({
        ...entry,
        proposed: {
          ...entry.proposed,
          name: "Cardboard box",
          quantity: 1,
          room: { text: "Storage", entity_type: "room", status: "matched", matched_id: roomId, name: "Storage", room_id: roomId, candidates: [] },
        },
      })),
    };
    const uploadBodies: string[] = [];
    const applyBodies: Array<{ entries: Array<{ proposed: { name: string; room: { matched_id: string } } }> }> = [];
    await page.route("**/api/v1/ai/recognitions**", async (route) => {
      if (route.request().method() === "DELETE") {
        exists = false;
        return route.fulfill({ status: 204 });
      }
      if (route.request().method() === "POST") {
        exists = true;
        if (route.request().url().endsWith("/retry")) attempt += 1;
        status = "queued";
      }
      return route.fulfill({ json: {
        id: photoId, status, error: status === "failed" ? "Synthetic worker failure" : null,
        result: { _add_items: { assistant_capture: true, processing_attempt: `photo-${attempt}`, ...(converted ? { import_batch_id: importBatch.id } : {}) } },
      } });
    });
    await page.route("**/api/v1/inventory-review/captures", (route) => route.fulfill({ json:
      exists && !applied ? [{
        id: converted ? importBatch.id : photoId, kind: converted ? "import" : "photo",
        title: "Recovered photo", status: converted ? "review" : status, generation: `photo-${attempt}`,
      }] : [],
    }));
    await page.route(`**/api/v1/imports/from-recognition/${photoId}`, (route) => {
      conversions += 1;
      converted = true;
      return route.fulfill({ json: photoBatch });
    });
    await page.route(`**/api/v1/imports/${importBatch.id}`, (route) => route.fulfill({ json: {
      ...photoBatch, status: applied ? "completed" : "review",
    } }));
    page.on("request", (request) => {
      if (request.url().endsWith(`/imports/${importBatch.id}/apply`)) {
        applyBodies.push(request.postDataJSON());
        applied = true;
      }
      if (request.url().endsWith("/ai/recognitions") && request.method() === "POST") {
        uploadBodies.push(request.postData() ?? "");
      }
    });
    await page.getByRole("combobox", { name: "Search or ask about your inventory" }).fill(caption);
    await page.getByTestId("quick-search-attachment-input").setInputFiles({
      name: "photo.jpg", mimeType: "image/jpeg", buffer: Buffer.from("synthetic image"),
    });
    const panel = page.getByTestId("assistant-panel");
    await panel.getByRole("radio", { name: "Inventory photo" }).check();
    await panel.getByRole("button", { name: "Send question" }).click();
    await panel.getByRole("button", { name: "Close assistant" }).click();
    await allItems(page).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "Open assistant, 4 unresolved reviews" })).toBeVisible();
    status = "failed";
    await expect(page.getByText("Recovered photo needs attention", { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Open assistant, 4 unresolved reviews" }).click();
    await openWaitingCapture(page, "Recovered photo");
    await panel.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(panel.getByText("Waiting to interpret inventory photo…", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Close assistant" }).click();
    status = "succeeded";
    await expect.poll(() => conversions, { timeout: 10_000 }).toBe(1);
    await expect(page.getByText("Recovered photo ready for review", { exact: true })).toHaveCount(1);
    // The earlier "needs attention" message can still be on screen. Use the new one.
    await page.locator("[data-sonner-toast]").filter({ hasText: "Recovered photo ready for review" })
      .getByRole("button", { name: "Review", exact: true }).click();
    await expect(panel.getByText("AI-assisted", { exact: true })).toBeVisible();
    await expect(panel.getByRole("region", { name: "Assistant item review" })).toContainText("Storage");
    expect(applyBodies).toEqual([]);
    expect(uploadBodies[0]).toContain(caption);
    await page.reload();
    // The assistant was open, so it is open again after the reload.
    await expect(page.getByRole("button", { name: "Open assistant, 4 unresolved reviews" })).toBeVisible();
    await expect(panel).toBeVisible();
    await openWaitingCapture(page, "Recovered photo");
    await expect(panel.getByRole("region", { name: "Assistant item review" })).toContainText("Storage");
    await expect(panel.getByText("AI-assisted", { exact: true })).toBeVisible();
    await panel.getByRole("checkbox", { name: "Select Cardboard box" }).check();
    await panel.getByRole("button", { name: /^Add \d+ selected items?$/ }).first().click();
    await expect(page.getByRole("button", { name: "Open assistant, 3 unresolved reviews" })).toBeVisible();
    expect(conversions).toBe(1);
    expect(applyBodies).toHaveLength(1);
    expect(applyBodies[0].entries[0].proposed).toMatchObject({ name: "Cardboard box", room: { matched_id: roomId } });
    await panel.getByRole("button", { name: "Close assistant" }).click();
    // Wait until the assistant is really closed before attaching the next photo.
    await expect(panel).toHaveCount(0);
    await expect(page).not.toHaveURL(/#assistant$/);
    // Back to the item list, where this test sends its photos from.
    await allItems(page).click();
    await expect(page).toHaveURL(/\/items$/);
    // Nothing waits for review until the next photo is sent.
    exists = false;
    converted = false;
    applied = false;
    photoId = "00000000-0000-0000-0000-000000000031";
    await page.getByTestId("quick-search-attachment-input").setInputFiles({
      name: "cancel.jpg", mimeType: "image/jpeg", buffer: Buffer.from("synthetic image"),
    });
    await panel.getByRole("radio", { name: "Inventory photo" }).check();
    await panel.getByRole("button", { name: "Send question" }).click();
    await expect(page.getByRole("button", { name: "Open assistant, 4 unresolved reviews" })).toBeVisible();
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open assistant, 3 unresolved reviews" })).toBeVisible();
    expect(conversions).toBe(1);
    expect(errors).toEqual([]);
  });
test("browser drag-and-drop and clipboard paste attach supported files", async ({ page }) => {
  const errors = await fixture(page);
  await page.getByRole("textbox", { name: "Ask the Housetory assistant" }).evaluate((textarea) => {
    const file = new File(["drop"], "dropped.pdf", { type: "application/pdf" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    textarea.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: transfer }));
    textarea.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
  });
  await expect(page.getByText("dropped.pdf")).toBeVisible();
  await page.getByRole("button", { name: "Remove attachment" }).click();

  await page.getByRole("textbox", { name: "Ask the Housetory assistant" }).evaluate((textarea) => {
    const file = new File(["paste"], "pasted.pdf", { type: "application/pdf" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    textarea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
  });
  await expect(page.getByText("pasted.pdf")).toBeVisible();
  expect(errors).toEqual([]);
});
