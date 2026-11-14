import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

const household = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "Synthetic household",
  default_currency: "USD",
  warranty_reminder_days: 30,
};

async function fixture(page: Page, path = "/assistant") {
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
      return route.fulfill({
        json: {
          query: url.searchParams.get("q") ?? "",
          effective_query: null,
          question_like: true,
          results: [],
        },
      });
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
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("invoice.pdf")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve("..", "..", "docs", "assistant-unified-capture-desktop.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  const composer = dialog.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await composer.focus();
  await expect(dialog.getByRole("button", { name: "Attach a file" })).toBeVisible();
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
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
  await expect(page).toHaveURL("/");
  await dialog.getByRole("button", { name: "Close assistant" }).click();
  await expect(headerSearch).toBeVisible();
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
