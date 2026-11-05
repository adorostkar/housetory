import fs from "node:fs/promises";

import { expect, test, type APIRequestContext } from "@playwright/test";

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createItem(request: APIRequestContext, name: string, extra = {}) {
  const response = await request.post("/api/v1/items", {
    data: { name, ...extra },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

test("selects items, previews evidence, generates and downloads the PDF/CSV/ZIP", async ({
  page,
  request,
}) => {
  const id = suffix();
  const first = await createItem(request, `Evidence drill ${id}`, {
    quantity: 2,
    description: "A drill kept for the evidence package browser flow.",
    purchase: {
      merchant: "Browser Hardware",
      purchase_date: "2026-02-01",
      price_cents: 12000,
      currency: "USD",
    },
    current_value_cents: 9000,
    current_value_currency: "USD",
  });
  const second = await createItem(request, `Evidence lamp ${id}`, {
    current_value_cents: 2500,
    current_value_currency: "EUR",
  });
  const receipt = await request.post("/api/v1/documents", {
    multipart: {
      file: {
        name: "browser-receipt.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Evidence receipt for the browser flow."),
      },
      title: `Evidence receipt ${id}`,
      document_type: "receipt",
      item_ids: first.item.id,
    },
  });
  expect(receipt.ok()).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/items");
  await page.getByRole("checkbox", { name: `Select ${first.item.name}` }).check();
  await page.getByRole("checkbox", { name: `Select ${second.item.name}` }).check();
  await page.getByRole("button", { name: "Export evidence" }).click();

  const dialog = page.getByRole("dialog", { name: "Export 2 selected items with evidence" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Scope preview/)).toBeVisible();
  await expect(dialog.getByText(first.item.name).first()).toBeVisible();
  await expect(dialog.getByText(`Evidence receipt ${id}`)).toBeVisible();
  await expect(dialog.getByText(/USD/).first()).toBeVisible();
  await expect(dialog.getByText(/EUR/).first()).toBeVisible();

  await dialog.getByRole("button", { name: "Generate package" }).click();
  const pdfLink = dialog.getByRole("link", { name: "Download PDF" });
  await expect(pdfLink).toBeVisible({ timeout: 60_000 });

  const [pdfDownload] = await Promise.all([
    page.waitForEvent("download"),
    pdfLink.click(),
  ]);
  const pdfPath = await pdfDownload.path();
  expect(pdfPath).toBeTruthy();
  const pdfBytes = await fs.readFile(pdfPath as string);
  expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");

  const [csvDownload] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("link", { name: "Download CSV" }).click(),
  ]);
  const csvBytes = await fs.readFile((await csvDownload.path()) as string);
  expect(csvBytes.subarray(0, 3).toString("hex")).toBe("efbbbf");

  const [zipDownload] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("link", { name: "Download evidence ZIP" }).click(),
  ]);
  const zipBytes = await fs.readFile((await zipDownload.path()) as string);
  expect(zipBytes.subarray(0, 2).toString()).toBe("PK");

  await page.setViewportSize({ width: 390, height: 844 });
  await fs.mkdir("../../docs/walkthrough/inventory-evidence", { recursive: true });
  await page.screenshot({
    path: "../../docs/walkthrough/inventory-evidence/02-generated-mobile.png",
    fullPage: false,
  });
});

test("shows preview errors and a canceled package state", async ({ page, request }) => {
  const item = await createItem(request, `Evidence error drill ${suffix()}`);
  const preview = await request.post("/api/v1/evidence-exports/preview", {
    data: { scope: { item_ids: [item.item.id] }, options: {} },
  });
  expect(preview.ok()).toBeTruthy();
  const previewBody = await preview.json();

  await page.route("**/api/v1/evidence-exports/preview", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        detail: { code: "preview_failed", message: "The preview fixture failed safely." },
      }),
    });
  });
  await page.goto("/items");
  await page.getByRole("checkbox", { name: `Select ${item.item.name}` }).check();
  await page.getByRole("button", { name: "Export evidence" }).click();
  const dialog = page.getByRole("dialog", { name: "Export 1 selected item with evidence" });
  await expect(dialog.getByText("The preview fixture failed safely.")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.unrouteAll();
  let status = "queued";
  const queuedRecord = {
    id: "export-cancel-fixture",
    status: "queued",
    format_version: "inventory-evidence-v1",
    scope_label: previewBody.scope_label,
    scope: previewBody.scope,
    include_archived: false,
    options: previewBody.options,
    item_count: previewBody.item_count,
    unit_count: previewBody.unit_count,
    evidence_counts: {},
    warnings: [],
    error: null,
    created_at: "2026-11-05T10:00:00Z",
    completed_at: null,
    expires_at: null,
    pdf_available: false,
    csv_available: false,
    bundle_available: false,
    pdf_bytes: null,
    csv_bytes: null,
    bundle_bytes: null,
    pdf_sha256: null,
    csv_sha256: null,
    bundle_sha256: null,
    can_manage: true,
  };
  await page.route("**/api/v1/evidence-exports/preview", async (route) => {
    await route.fulfill({ json: previewBody });
  });
  await page.route("**/api/v1/evidence-exports?*", async (route) => {
    await route.fulfill({ json: { items: [] } });
  });
  await page.route("**/api/v1/evidence-exports", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ json: queuedRecord });
      return;
    }
    await route.fulfill({ json: { items: [] } });
  });
  await page.route("**/api/v1/evidence-exports/export-cancel-fixture", async (route) => {
    await route.fulfill({ json: { ...queuedRecord, status } });
  });
  await page.route(
    "**/api/v1/evidence-exports/export-cancel-fixture/cancel",
    async (route) => {
      status = "cancelled";
      await route.fulfill({ json: { ...queuedRecord, status } });
    },
  );

  await page.goto("/items");
  await page.getByRole("checkbox", { name: `Select ${item.item.name}` }).check();
  await page.getByRole("button", { name: "Export evidence" }).click();
  const retryDialog = page.getByRole("dialog", {
    name: "Export 1 selected item with evidence",
  });
  await expect(retryDialog.getByText(/Scope preview/)).toBeVisible();
  await retryDialog.getByRole("button", { name: "Generate package" }).click();
  await expect(retryDialog.getByText("Queued")).toBeVisible();
  await retryDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(retryDialog.getByText("Cancelled")).toBeVisible();
  await expect(
    retryDialog.getByRole("button", { name: "Generate again" }),
  ).toBeVisible();
});
