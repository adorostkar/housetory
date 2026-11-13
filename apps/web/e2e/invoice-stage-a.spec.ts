import fs from "node:fs/promises";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import type { AiStatus, CandidateItem, DocumentProcessing, ExtractionReview } from "../src/lib/types";
import type { EnhancementState } from "../src/lib/types/enrichment";

const documentId = "00000000-0000-0000-0000-000000000003";
const householdId = "00000000-0000-0000-0000-000000000001";
const roomId = "00000000-0000-0000-0000-000000000002";
const createdAt = "2026-11-13T10:00:00Z";
const sourceText =
  "NORDIC TOOLS\n2026-11-13\nDrill kit 2 x 12,50 25,00\nSubtotal 25,00\nTax 6,25\nTotal SEK 31,25";

const aiStatus: AiStatus = {
  configured: true,
  available: true,
  provider: "ollama",
  model: "synthetic-fixture-model",
  mode: "local",
  catalog_checked: false,
  catalog_count: 0,
  cloud_enabled: false,
  cloud_consent: false,
  data_leaves_server: false,
  error: null,
  privacy_note: "Synthetic UI fixture; no model is called.",
};

const extraction = {
  document_id: documentId,
  version: "synthetic-local-version",
  source_artifact: "original",
  document_type: "invoice",
  generated_at: createdAt,
  purchase_eligible: true,
  fields: {
    merchant: "NORDIC TOOLS",
    purchase_date: "2026-11-13",
    document_date: "2026-11-13",
    currency: "SEK",
    total_cents: 3125,
    subtotal_cents: 2500,
    tax_cents: 625,
    shipping_cents: null,
    discount_cents: null,
    order_number: null,
    brand: null,
    model: null,
    serial_numbers: [],
    warranty_provider: null,
    warranty_start: null,
    warranty_end: null,
    warranty_months: null,
    field_sources: { total_cents: "Total SEK 31,25" },
    uncertain_fields: [],
  },
  lines: [
    {
      id: "00000000-0000-0000-0000-000000000004",
      line_number: 3,
      kind: "product",
      description: "Drill",
      quantity: 2,
      unit_price_cents: 1250,
      line_total_cents: 2500,
      evidence: {
        page: 1,
        line_number: 3,
        text: "Drill kit 2 x 12,50 25,00",
      },
      warnings: [],
      purchase_eligible: true,
    },
  ],
  warnings: [],
  matches: [],
  duplicate_documents: [],
  applied: [],
  ai_status: aiStatus,
  financial_validation: {
    status: "consistent",
    tax_treatment: "exclusive",
    computed: {
      product_total_cents: 2500,
      tax_cents: 625,
      shipping_cents: null,
      discount_cents: null,
      expected_total_cents: 3125,
      total_difference_cents: 0,
    },
    checks: [],
  },
} satisfies ExtractionReview;

const candidates: CandidateItem[] = ["Workshop drill", "Spare drill"].map((name, index) => ({
  id: `00000000-0000-0000-0000-00000000000${index + 6}`,
  name,
  brand: null,
  model: null,
  serial_number: null,
  quantity: 1,
  on_loan_quantity: 0,
  room_name: "Workshop",
  location_name: null,
  purchase: null,
  warranty: null,
  reasons: ["Description matches the stored document evidence"],
  match_quality: "strong",
  exact_identifier: false,
}));

async function fixtureApp(page: Page) {
  const unexpected: string[] = [];
  const calls: string[] = [];
  const pageErrors: string[] = [];
  const operations: Array<"interpret" | "matches"> = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const state: {
    stage: DocumentProcessing["stage"];
    reason: string | null;
    workerAvailable: boolean;
    enhancementStatus: EnhancementState["status"];
    operation: "interpret" | "matches" | null;
    includeCandidates: boolean;
    attempt: number;
  } = {
    stage: "interpreting",
    reason: null,
    workerAvailable: true,
    enhancementStatus: "running",
    operation: null,
    includeCandidates: false,
    attempt: 1,
  };
  await page.addInitScript(() => {
    localStorage.setItem("housetory-theme", "light");
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    calls.push(`${method} ${url.pathname}`);
    const household = {
      id: householdId,
      name: "Synthetic review household",
      default_currency: "SEK",
      warranty_reminder_days: 30,
    };
    if (url.pathname === "/api/v1/auth/session") {
      return route.fulfill({
        json: {
          authenticated: true,
          setup_required: false,
          user: {
            id: "00000000-0000-0000-0000-000000000005",
            name: "Stage A Reviewer",
            email: "reviewer@example.invalid",
            created_at: createdAt,
          },
          household,
          households: [
            { ...household, role: "owner", is_current: true, property_count: 0 },
          ],
          role: "owner",
        },
      });
    }
    if (url.pathname === "/api/v1/ai/status") {
      return route.fulfill({ json: aiStatus });
    }
    if (url.pathname === "/api/v1/search/scopes") {
      return route.fulfill({ json: { items: [{ id: householdId, name: "Synthetic review household", role: "owner", properties: [] }] } });
    }
    if (url.pathname === "/api/v1/documents" && method === "POST") {
      return route.fulfill({ json: {
        id: documentId,
        title: "Synthetic invoice · Nordic Tools",
        extracted_metadata: {},
      } });
    }
    if (url.pathname === "/api/v1/rooms") {
      return route.fulfill({
        json: {
          items: [
            {
              id: roomId,
              name: "Workshop",
              item_count: 0,
              location_count: 0,
              total_quantity: 0,
              created_at: createdAt,
              updated_at: createdAt,
            },
          ],
          total: 1,
        },
      });
    }
    if (
      ["/api/v1/properties", "/api/v1/items", "/api/v1/storage-locations",
        "/api/v1/categories", "/api/v1/tags"].includes(url.pathname)
    ) {
      return route.fulfill({ json: { items: [], total: 0, limit: 24, offset: 0 } });
    }
    const root = `/api/v1/documents/${documentId}`;
    if (url.pathname === `${root}/processing/retry` && method === "POST") {
      const body = request.postDataJSON();
      if (body?.operation !== "interpret" && body?.operation !== "matches") {
        unexpected.push(`Invalid queued operation: ${JSON.stringify(body)}`);
        return route.fulfill({ status: 422, json: { detail: { message: "Invalid fixture operation" } } });
      }
      operations.push(body.operation);
      state.operation = body.operation;
      state.attempt += 1;
      state.stage = "waiting";
      state.enhancementStatus = "queued";
      state.reason = null;
    }
    if (url.pathname === `${root}/processing/cancel` && method === "POST") {
      state.stage = "cancelled";
      state.reason = "cancelled";
      state.enhancementStatus = "skipped";
    }
    if (url.pathname.startsWith(`${root}/processing`)) {
      return route.fulfill({
        json: {
          correlation_id: `synthetic-stage-a-correlation-${state.attempt}`,
          stage: state.stage,
          reason: state.reason,
          started_at: createdAt,
          updated_at: new Date(Date.parse(createdAt) + state.attempt * 1000).toISOString(),
          elapsed_ms: state.stage === "ready" ? 18500 : 18000,
          local_available: true,
          can_cancel: ["interpreting", "waiting"].includes(state.stage),
          can_retry: ["cancelled", "failed", "needs_attention"].includes(state.stage),
          worker_available: state.workerAvailable,
          ai_expected: true,
          background: false,
          timings: {
            local_queue_ms: 60,
            local_processing_ms: 420,
            ai_queue_ms: 80,
            provider_ms: state.stage === "ready" ? 17800 : null,
            validation_ms: state.stage === "ready" ? 12 : null,
          },
        },
      });
    }
    if (url.pathname === `${root}/extraction`) {
      const ready = state.enhancementStatus === "ready";
      return route.fulfill({
        json: {
          ...extraction,
          matches: state.includeCandidates ? [{
            line_id: extraction.lines[0]!.id,
            candidates,
            quality: "strong",
            reasons: ["Description matches"],
          }] : [],
          enhancement: {
            status: state.enhancementStatus,
            job_id: null,
            version: extraction.version,
            reason: state.reason,
            error: null,
            provider: "ollama",
            model: "synthetic-fixture-model",
            ai_attempted: true,
            ai_succeeded: ready,
          },
          suggested_refinement: ready ? {
            ...extraction,
            version: "synthetic-ai-version",
            base_version: extraction.version,
            ai_used: true,
            matches: state.includeCandidates ? [{
              line_id: extraction.lines[0]!.id,
              candidates: state.operation === "matches" ? [...candidates].reverse() : candidates,
              quality: "strong",
              reasons: ["Reviewed document evidence"],
            }] : [],
            lines: extraction.lines.map((line) => ({ ...line, description: "Drill kit" })),
          } : null,
        },
      });
    }
    if (url.pathname === `${root}/related-items`) {
      return route.fulfill({ json: { items: [], suggested_item_ids: [] } });
    }
    if (url.pathname === root) {
      return route.fulfill({
        json: {
          id: documentId,
          title: "Synthetic invoice · Nordic Tools",
          document_type: "invoice",
          original_filename: "synthetic-invoice.pdf",
          content_type: "application/pdf",
          original_content_type: "application/pdf",
          byte_size: 1200,
          original_byte_size: 1200,
          document_date: null,
          merchant: null,
          notes: "Synthetic fixtures only. No private records or provider calls.",
          ocr_status: "succeeded",
          ocr_error: null,
          ocr_confidence: null,
          ocr_processed_at: createdAt,
          extracted_text: sourceText,
          extracted_metadata: {},
          items: [],
          item_count: 0,
          pages: [],
          page_count: 1,
          created_at: createdAt,
          updated_at: createdAt,
          url: `${root}/file`,
          original_url: `${root}/original`,
        },
      });
    }
    if (url.pathname === `${root}/file`) {
      return route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4\n%%EOF" });
    }
    unexpected.push(`${method} ${url.pathname}`);
    return route.fulfill({
      status: 501,
      json: { detail: { code: "unmocked_fixture", message: "Unexpected fixture request." } },
    });
  });
  return { state, calls, unexpected, pageErrors, operations };
}

async function screenshot(page: Page, name: string) {
  const directory = process.env.STAGE_A_SCREENSHOT_DIR;
  if (!directory) return;
  await fs.mkdir(directory, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

test("announces server transitions and preserves cancellation across reload", async ({ page }) => {
  const { state, calls, unexpected } = await fixtureApp(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/documents/${documentId}`);
  const progress = page.getByRole("region", { name: "Document processing" });
  await expect(progress.getByRole("heading", { name: "Interpreting document" })).toBeVisible();
  const started = Date.now();
  state.stage = "waiting";
  state.enhancementStatus = "queued";
  await expect(progress.getByRole("heading", { name: /Waiting/ })).toBeVisible();
  await test.info().attach("progress-transition.json", {
    body: JSON.stringify({ elapsed_ms: Date.now() - started }),
    contentType: "application/json",
  });
  await progress.getByRole("button", { name: "Cancel processing", exact: true }).click();
  await expect(progress.getByRole("heading", { name: /cancelled/i })).toBeVisible();
  await page.reload();
  await expect(progress.getByRole("heading", { name: /cancelled/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Synthetic invoice/ })).toBeVisible();
  expect(calls).toContain(`POST /api/v1/documents/${documentId}/processing/cancel`);
  expect(calls.filter((call) => call.includes("/apply"))).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("shows real-stage progress and keeps local review available during optional AI", async ({ page }) => {
  const { unexpected, pageErrors } = await fixtureApp(page);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/documents/${documentId}`);
    await expect(page.getByRole("heading", { name: /Synthetic invoice/ })).toBeVisible();
    await expect(page.getByText(/Interpreting/, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /local/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /cancel/i }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth,
    )).toBe(true);
    await screenshot(page, `progress-${width === 390 ? "mobile" : "desktop"}`);
  }
  expect(unexpected).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("late AI suggestions cannot replace an edited local review", async ({ page }) => {
  const { state, calls, unexpected, pageErrors } = await fixtureApp(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/documents/${documentId}`);
  await page.getByRole("button", { name: /local/i }).first().click();
  const merchant = page.getByLabel(/^Merchant/);
  await expect(merchant).toHaveValue("NORDIC TOOLS");
  await merchant.fill("Manually reviewed shop");
  const returned = page.waitForResponse(async (response) =>
    response.url().endsWith("/extraction") &&
    (await response.json()).enhancement?.status === "ready",
  );
  state.stage = "ready";
  state.enhancementStatus = "ready";
  await returned;
  await expect(page.getByRole("button", {
    name: "Review AI suggestions",
    exact: true,
  })).toBeVisible();
  await expect(merchant).toHaveValue("Manually reviewed shop");
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Drill");
  expect(calls.filter((call) => call.startsWith("POST") || call.startsWith("PATCH"))).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("presents one editable AI-assisted review with financial evidence", async ({ page }) => {
  const { state, calls, unexpected, pageErrors } = await fixtureApp(page);
  state.stage = "ready";
  state.enhancementStatus = "ready";
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/documents/${documentId}`);
    await page.getByRole("button", { name: "Review extraction", exact: true }).click();
    await expect(page.getByLabel(/^Merchant/)).toHaveValue("NORDIC TOOLS");
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Drill kit");
    await expect(page.getByLabel(/^Merchant/)).toHaveCount(1);
    await expect(page.getByLabel(/^Merchant/)).toBeEditable();
    await expect(page.getByRole("button", {
      name: "Review AI suggestions",
      exact: true,
    })).toHaveCount(0);
    await expect(page.getByText("AI refinement proposal", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Qty", { exact: true })).toHaveValue("2");
    await expect(page.getByLabel(/^Unit price/)).toHaveValue("12.50");
    await expect(page.getByLabel(/^Unit price/)).toHaveAttribute("readonly", "");
    await expect(page.getByLabel(/^Line total/)).toHaveValue("25.00");
    await expect(page.getByLabel(/^Total/)).toHaveValue("31.25");
    await expect.poll(() => page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth,
    )).toBe(true);
    await screenshot(page, `review-${width === 390 ? "mobile" : "desktop"}`);
  }
  expect(calls.filter((call) => call.startsWith("POST") || call.startsWith("PATCH"))).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(pageErrors).toEqual([]);
});

for (const [operation, label] of [
  ["interpret", "Refine fields & lines"],
  ["matches", "Re-rank matches"],
] as const) {
  test(`queues bounded ${operation} review without replacing manual edits or allowing duplicate work`, async ({ page }) => {
    const { state, calls, unexpected, pageErrors, operations } = await fixtureApp(page);
    state.stage = "ready";
    state.enhancementStatus = "off";
    state.includeCandidates = true;
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto(`/documents/${documentId}`);
    await page.getByRole("button", { name: "Review extraction", exact: true }).click();
    const merchant = page.getByLabel(/^Merchant/);
    await merchant.fill("Keep my reviewed merchant");
    const sourceCandidate = page.getByRole("button", { name: /^Workshop drill/ });
    await expect(sourceCandidate).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: label, exact: true }).first().click();
    const progress = page.getByRole("region", { name: "Document processing" });
    await expect(progress.getByRole("heading", { name: "Waiting for processing", exact: true })).toBeVisible();
    await expect(merchant).toHaveValue("Keep my reviewed merchant");
    await expect(sourceCandidate).toHaveAttribute("aria-pressed", "true");
    for (const action of ["Refine fields & lines", "Re-rank matches"]) {
      const buttons = page.getByRole("button", { name: action, exact: true });
      for (let index = 0; index < await buttons.count(); index++) {
        await expect(buttons.nth(index)).toBeDisabled();
      }

    }
    await expect(page.getByRole("button", { name: "Refresh matches", exact: true })).toBeEnabled();
    expect(operations).toEqual([operation]);
    await expect(page.getByText("AI refinement proposal", { exact: true })).toHaveCount(0);
    state.stage = "ready";
    state.enhancementStatus = "ready";
    await page.getByRole("button", { name: "Review AI suggestions", exact: true }).click();
    await expect(page.getByText("AI refinement proposal", { exact: true })).toBeVisible();
    await expect(merchant).toHaveValue("Keep my reviewed merchant");
    await expect(sourceCandidate).toHaveAttribute("aria-pressed", "true");
    if (operation === "matches") {
      await expect(page.getByText("Suggested inventory matches: Spare drill, Workshop drill", { exact: true })).toBeVisible();
    }
    expect(calls.filter((call) => call.startsWith("POST") || call.startsWith("PATCH"))).toEqual([
      `POST /api/v1/documents/${documentId}/processing/retry`,
    ]);
    expect(calls.filter((call) => call.includes("/extraction/refine") || call.includes("/extraction/matches"))).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

test("assistant document review preserves manual edits across sheet and full-page views", async ({ page }) => {
  const { calls, unexpected, pageErrors } = await fixtureApp(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/documents/${documentId}`);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Assistant" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /Document review: Synthetic invoice/ })).toBeVisible();
  await dialog.getByRole("region", { name: "Document processing" })
    .getByRole("button", { name: "Use local/manual review now" }).click();
  const merchant = dialog.getByLabel(/^Merchant/);
  await expect(merchant).toHaveValue("NORDIC TOOLS");
  await merchant.fill("Keep this draft");
  await dialog.getByRole("button", { name: "Close assistant" }).click();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Assistant" }).click();
  await expect(dialog.getByLabel(/^Merchant/)).toHaveValue("Keep this draft");
  await dialog.getByRole("link", { name: "Open full page" }).click();
  await expect(page.getByLabel(/^Merchant/)).toHaveValue("Keep this draft");
  expect(calls.filter((call) => call.startsWith("POST") || call.startsWith("PATCH"))).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("assistant capture uses the existing document upload and review path", async ({ page }) => {
  const { calls, unexpected, pageErrors } = await fixtureApp(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/assistant");
  await page.getByRole("button", { name: "Add document" }).click();
  const upload = page.getByRole("dialog", { name: "Add a document" });
  await upload.locator('input[type="file"]').setInputFiles({
    name: "invoice.txt", mimeType: "text/plain", buffer: Buffer.from(sourceText),
  });
  await upload.getByRole("button", { name: "Add document", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Document review: Synthetic invoice/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Document processing" })).toBeVisible();
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual(["POST /api/v1/documents"]);
  expect(unexpected).toEqual([]);
  expect(pageErrors).toEqual([]);
});
