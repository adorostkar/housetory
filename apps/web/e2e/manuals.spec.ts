import { expect, test, type APIRequestContext } from "@playwright/test";

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createItem(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/items", {
    data: { name, brand: "Makita", model: "DCD791" },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

test("uploads a manual without make/model, answers from its text, and attaches it to another item", async ({
  page,
  request,
}) => {
  const id = suffix();
  const title = `Drill manual ${id}`;
  const first = await createItem(request, `Drill one ${id}`);
  const second = await createItem(request, `Drill two ${id}`);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/items/${first.item.id}`);
  await page.getByRole("button", { name: "Add manual" }).first().click();
  const uploadDialog = page.getByRole("dialog", { name: "Add a manual" });
  await expect(uploadDialog).toBeVisible();
  await expect(uploadDialog.getByLabel("Type")).toHaveCount(0);
  await uploadDialog.locator("#document-file").setInputFiles({
    name: "drill-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "Safety\nDisconnect the battery before changing the drill bit.\n\n" +
        "Maintenance\nApply light machine oil to the chuck monthly.",
    ),
  });
  await uploadDialog.getByLabel("Title").fill(title);
  await uploadDialog.getByRole("button", { name: "Add manual" }).click();
  await expect(uploadDialog).toBeHidden();
  await expect(page.getByText(title)).toBeVisible();

  await expect
    .poll(
      async () => {
        const listing = await request.get(`/api/v1/items/${first.item.id}/manuals`);
        const data = (await listing.json()) as {
          manuals: Array<{ title: string; id: string; ocr_status: string }>;
        };
        return data.manuals.find((manual) => manual.title === title)?.ocr_status;
      },
      { timeout: 60_000 },
    )
    .toBe("succeeded");

  await page.reload();
  await expect(page.getByText(title)).toBeVisible();
  await page.getByRole("button", { name: "Ask about this item" }).click();
  const askDialog = page.getByRole("dialog", { name: `Ask about ${first.item.name}` });
  await askDialog.getByLabel("Question").fill("How do I change the drill bit?");
  await askDialog.getByRole("button", { name: "Ask attached manuals" }).click();
  await expect(askDialog.getByText("Extracted from manual text")).toBeVisible();
  await expect(askDialog.getByText("Page 1").first()).toBeVisible();
  await expect(
    askDialog.getByText(/Disconnect the battery before changing the drill bit/).first(),
  ).toBeVisible();
  await expect(askDialog.getByText(/Borrower, loan and household data/)).toHaveCount(0);

  await page.goto(`/items/${second.item.id}`);
  await page.getByRole("button", { name: "Attach existing" }).click();
  const attachDialog = page.getByRole("dialog", { name: "Attach an existing manual" });
  const row = attachDialog.locator("li").filter({ hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Attach" }).click();
  await expect(attachDialog).toBeHidden();
  await expect(page.getByText(title)).toBeVisible();
});

test("confirms identity, then searches, reviews and saves a mocked manual candidate", async ({
  page,
  request,
}) => {
  const id = suffix();
  const item = await createItem(request, `Gated drill ${id}`);
  let profile: Record<string, unknown> | null = null;
  const candidate = {
    id: "candidate-e2e",
    item_id: item.item.id,
    title: `Makita DCD791 manual ${id}`,
    source_url: "https://www.makita.example/DCD791",
    file_url: "https://www.makita.example/DCD791.pdf",
    publisher: "Makita",
    language: "en",
    source_type: "manufacturer",
    model_coverage: ["DCD791"],
    snippet: "Exact DCD791 coverage with an 18 V battery specification.",
    retrieved_at: "2026-11-05T10:00:00Z",
    document_id: null,
    created_at: "2026-11-05T10:00:00Z",
  };
  const savedDocument = {
    id: "document-e2e",
    title: candidate.title,
    document_type: "manual",
    original_filename: "DCD791.pdf",
    content_type: "application/pdf",
    original_content_type: "application/pdf",
    byte_size: 2048,
    original_byte_size: 2048,
    document_date: null,
    merchant: "Makita",
    notes: null,
    extracted_text: "Battery 18 V.",
    extracted_metadata: {},
    ocr_status: "succeeded",
    ocr_error: null,
    ocr_confidence: null,
    ocr_processed_at: null,
    created_at: "2026-11-05T10:00:00Z",
    updated_at: "2026-11-05T10:00:00Z",
    items: [{ id: item.item.id, name: item.item.name }],
    item_count: 1,
    pages: [],
    page_count: 0,
    url: "/api/v1/documents/document-e2e/file",
    original_url: "/api/v1/documents/document-e2e/original",
  };

  await page.route(`**/api/v1/items/${item.item.id}/manuals`, async (route) => {
    await route.fulfill({
      json: {
        item_id: item.item.id,
        manuals: [],
        search: {
          configured: true,
          provider_label: "Test search",
          reason: null,
          profile,
          can_search: Boolean(profile),
        },
      },
    });
  });
  await page.route(`**/api/v1/items/${item.item.id}/manual-profile`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    profile = {
      id: "profile-e2e",
      item_id: item.item.id,
      manufacturer: body.manufacturer,
      model_identifier: body.model_identifier,
      variant: body.variant,
      confirmed_at: "2026-11-05T10:00:00Z",
      updated_at: "2026-11-05T10:00:00Z",
    };
    await route.fulfill({ json: profile });
  });
  await page.route(`**/api/v1/items/${item.item.id}/manual-search`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { item_id: item.item.id, candidates: [], notices: [] } });
      return;
    }
    await route.fulfill({
      json: {
        item_id: item.item.id,
        candidates: [candidate],
        notices: ["Only exact confirmed model evidence is shown."],
      },
    });
  });
  await page.route(
    `**/api/v1/items/${item.item.id}/manual-search/candidate-e2e/download`,
    async (route) => {
      await route.fulfill({
        json: {
          document: savedDocument,
          candidate: { ...candidate, document_id: savedDocument.id },
          duplicate_documents: [],
        },
      });
    },
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/items/${item.item.id}`);
  await page.getByRole("button", { name: "Find manual" }).click();
  const dialog = page.getByRole("dialog", { name: `Find a manual for ${item.item.name}` });
  await expect(dialog.getByRole("button", { name: "Search for exact model" })).toBeDisabled();
  await expect(dialog.getByText(/Confirm the exact product identity/)).toBeVisible();

  await dialog.getByLabel("Manufacturer").fill("Makita");
  await dialog.getByLabel("Complete model identifier").fill("DCD791");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Save confirmed identity" }).click();
  await expect(dialog.getByText(/Confirmed/).first()).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Search for exact model" })).toBeEnabled();

  await dialog.getByRole("button", { name: "Search for exact model" }).click();
  await expect(dialog.getByText(candidate.title)).toBeVisible();
  await dialog.getByRole("button", { name: "Review & download" }).click();
  await expect(dialog.getByText(/I reviewed this candidate and verified/)).toBeVisible();
  const confirmDownload = dialog.getByRole("button", { name: /Download & attach/ });
  await expect(confirmDownload).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await confirmDownload.click();
  await expect(page.getByText("Manual saved and attached")).toBeVisible();
});
