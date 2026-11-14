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
      name: "Ethernet cable",
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

async function fixture(
  page: Page,
  path = "/assistant",
  onSearchQuery?: (body: Record<string, unknown>) => void,
) {
  const errors: string[] = [];
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
    if (url.pathname === "/api/v1/ai/status") {
      return route.fulfill({ json: { configured: false, available: false, data_leaves_server: false, privacy_note: "AI off" } });
    }
    if (url.pathname === "/api/v1/assistant/actions/intent") {
      return route.fulfill({ json: { intent: "unavailable", form: null } });
    }
    if (url.pathname === "/api/v1/search/quick") {
      const query = url.searchParams.get("q") ?? "";
      return route.fulfill({
        json: {
          query,
          effective_query: null,
          question_like: query.includes("?") || /^(where|what|when|who|why|how)\b/i.test(query),
          results: /\bdrill\b/i.test(query)
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
            : [],
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
    if (
      url.pathname === "/api/v1/imports" &&
      route.request().method() === "POST"
    ) {
      return route.fulfill({ json: importBatch });
    }
    if (url.pathname === `/api/v1/imports/${importBatch.id}`) {
      return route.fulfill({ json: importBatch });
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

test("desktop and keyboard-open mobile screenshots show the shared capture composer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await fixture(page, "/");
  const sidebarButton = page.getByRole("button", { name: "Add items" });
  await expect(sidebarButton).toBeVisible();
  expect((await sidebarButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await page.getByRole("banner").getByTestId("quick-search-attachment-input").setInputFiles({
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

test("the header entry opens the assistant panel without separate assistant navigation", async ({ page }) => {
  const errors = await fixture(page, "/");
  await expect(page.getByRole("link", { name: "Assistant", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open assistant panel" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add items" })).toBeVisible();
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("Where is my drill?");
  const intentRequest = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/v1/assistant/actions/intent",
  );
  await page.getByRole("option", { name: /Ask the assistant:/ }).click();
  await intentRequest;
  const panel = page.getByTestId("assistant-panel");
  await expect(panel.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
  await expect(page).toHaveURL("/");
  await headerSearch.fill("What is in my garage?");
  await expect(headerSearch).toHaveValue("What is in my garage?");
  await panel.getByRole("button", { name: "Close assistant" }).click();
  await expect(headerSearch).toBeVisible();
  expect(errors).toEqual([]);
});

test("normal header submission opens the assistant without selecting its prompt", async ({ page }) => {
  const errors = await fixture(page, "/");
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("Where is my drill?");
  await headerSearch.press("Enter");
  await expect(page.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
  await expect(headerSearch).toBeVisible();
  await expect(page).toHaveURL("/");
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
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("drill");
  await expect(page.getByRole("option", { name: /Cordless drill/ })).toBeVisible();
  await headerSearch.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=drill/);
  await expect(page.getByTestId("assistant-panel")).toHaveCount(0);
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
  await expect(page).toHaveURL(/\/items(?:\?|$)/);
  expect(errors).toEqual([]);
});

test("creation request submitted from Overview enters the reviewed conversation flow", async ({ page }) => {
  const errors = await fixture(page, "/");
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("I bought three Ethernet cables; put them in box 2.");
  await headerSearch.press("Enter");
  const panel = page.getByTestId("assistant-panel");
  await expect(panel.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
  await expect(panel.getByLabel("Item name")).toHaveValue("Ethernet cable");
  expect(errors).toEqual([]);
});

test("creation request submitted from Items enters the reviewed conversation flow", async ({ page }) => {
  const errors = await fixture(page, "/items");
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("I bought three Ethernet cables; put them in box 2.");
  await headerSearch.press("Enter");
  const panel = page.getByTestId("assistant-panel");
  await expect(panel.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
  await expect(panel.getByLabel("Item name")).toHaveValue("Ethernet cable");
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
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
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
  expect(searchBodies[2]).toMatchObject({ query: freshQuestion, history: [] });
  expect(searchBodies[2]).not.toHaveProperty("context");
  expect(errors).toEqual([]);
});

test("item review edits survive closing the panel and switching views", async ({ page }) => {
  const errors = await fixture(page, "/");
  const headerSearch = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await headerSearch.fill("I bought three Ethernet cables; put them in box 2.");
  await headerSearch.press("Enter");

  const panel = page.getByTestId("assistant-panel");
  const itemName = panel.getByLabel("Item name");
  await expect(itemName).toHaveValue("Ethernet cable");
  await itemName.fill("Blue Ethernet cable");
  await panel.getByRole("checkbox", { name: "Include Blue Ethernet cable" }).uncheck();

  await panel.getByRole("button", { name: "Close assistant" }).click();
  await page.getByRole("link", { name: "Items", exact: true }).click();
  await expect(page).toHaveURL(/\/items$/);
  await page.evaluate((path) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/imports/${importBatch.id}`);
  const fullPageReview = page.getByLabel("Item name");
  await expect(fullPageReview).toHaveValue("Blue Ethernet cable");
  await expect(
    page.getByRole("checkbox", { name: "Include Blue Ethernet cable" }),
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
  await page.getByRole("banner").getByTestId("quick-search-attachment-input").setInputFiles({
    name: "invoice.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 synthetic"),
  });
  const composer = page.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await expect(composer).toHaveValue("This invoice is for the kitchen fridge");
  await expect(page.getByText("invoice.pdf")).toBeVisible();
  expect(errors).toEqual([]);
});

test("browser drag-and-drop and clipboard paste attach supported files", async ({ page }) => {
  const errors = await fixture(page);
  await page.getByRole("textbox", { name: "Ask the Housetory assistant" }).evaluate((textarea) => {
    const file = new File(["drop"], "dropped.pdf", { type: "application/pdf" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const root = document.querySelector(".animate-fade-up");
    root?.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: transfer }));
    root?.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    void textarea;
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
