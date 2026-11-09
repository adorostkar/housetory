import fs from "node:fs/promises";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

function suffix() {
  return `${Date.now().toString().slice(-6)}-${Math.random().toString(36).slice(2, 5)}`;
}

async function headers(request: APIRequestContext) {
  const response = await request.get("/api/v1/auth/session");
  const state = (await response.json()) as { household: { id: string } };
  return { "X-Household-Id": state.household.id };
}

async function createRoom(request: APIRequestContext, name: string) {
  const auth = await headers(request);
  const properties = await request.get("/api/v1/properties", { headers: auth });
  const property = ((await properties.json()) as { items: Array<{ id: string }> }).items[0]!;
  const response = await request.post("/api/v1/rooms", {
    headers: auth,
    data: { name, property_id: property.id },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}

async function createContainer(request: APIRequestContext, roomId: string, name: string) {
  const auth = await headers(request);
  const response = await request.post("/api/v1/containers", {
    headers: auth,
    data: { room_id: roomId, container_type: "box", name },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { id: string; identifier: string }).id;
}

async function createItem(
  request: APIRequestContext,
  name: string,
  roomId: string,
  extra: Record<string, unknown> = {},
) {
  const auth = await headers(request);
  const response = await request.post("/api/v1/items", {
    headers: auth,
    data: { name, room_id: roomId, ...extra },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { item: { id: string } }).item.id;
}

async function createDocument(
  request: APIRequestContext,
  title: string,
  itemId: string,
  type: "receipt" | "manual" = "receipt",
) {
  const auth = await headers(request);
  const response = await request.post("/api/v1/documents", {
    headers: auth,
    multipart: {
      file: {
        name: `${title.replace(/\s+/g, "-").toLowerCase()}.txt`,
        mimeType: "text/plain",
        buffer: Buffer.from(`${title}\nOffline document content for UI verification.`),
      },
      title,
      document_type: type,
      item_ids: itemId,
    },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}

async function patchItem(
  request: APIRequestContext,
  itemId: string,
  data: Record<string, unknown>,
) {
  const auth = await headers(request);
  const response = await request.patch(`/api/v1/items/${itemId}`, {
    headers: auth,
    data,
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    item: {
      id: string;
      name: string;
      purchase: { id: string; price_cents: number | null } | null;
      warranty: { provider: string | null; document_id: string | null } | null;
      current_value_cents: number | null;
      documents: Array<{ id: string; title: string }>;
    };
  };
}

async function createDisclosureFixture(request: APIRequestContext) {
  const id = suffix();
  const roomId = await createRoom(request, `Disclosure room ${id}`);
  const firstId = await createItem(request, `Shared receipt holder ${id}`, roomId, {
    purchase: {
      vendor: "Build Supply",
      purchase_date: "2026-02-01",
      price_cents: 10000,
      currency: "USD",
    },
  });
  const auth = await headers(request);
  const first = (await (
    await request.get(`/api/v1/items/${firstId}`, { headers: auth })
  ).json()) as { item: { purchase: { id: string } } };
  const purchaseId = first.item.purchase.id;
  const itemId = await createItem(request, `Disclosure toolbox ${id}`, roomId, {
    purchase_id: purchaseId,
    warranty: {
      provider: "Stanley",
      start_date: "2026-02-01",
      duration_months: 24,
      end_date: "2028-02-01",
      reminder_days: 30,
      notes: "Lifetime shell warranty",
    },
    current_value_cents: 5000,
    current_value_currency: "USD",
  });
  const documentId = await createDocument(
    request,
    `Shared receipt ${id}`,
    itemId,
    "receipt",
  );
  await patchItem(request, itemId, {
    purchase: {
      merchant: "Build Supply",
      purchase_date: "2026-02-01",
      price_cents: 10000,
      currency: "USD",
      order_number: "ORD-1",
      notes: "Shared order",
      receipt_document_id: documentId,
    },
    warranty: {
      provider: "Stanley",
      start_date: "2026-02-01",
      duration_months: 24,
      end_date: "2028-02-01",
      reminder_days: 30,
      document_id: documentId,
      notes: "Lifetime shell warranty",
    },
  });
  return { id, roomId, itemId, firstId, purchaseId, documentId };
}

async function shot(page: Page, name: string) {
  await fs.mkdir("../../docs/walkthrough/simplification2", { recursive: true });
  await page.screenshot({
    path: `../../docs/walkthrough/simplification2/${name}.png`,
    fullPage: false,
    animations: "disabled",
  });
}

test("contextual Add items keeps place and returns a useful origin", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const id = suffix();
  const roomId = await createRoom(request, `Context room ${id}`);
  const containerId = await createContainer(request, roomId, `Context box ${id}`);
  await page.goto(`/containers/${containerId}`);
  await expect(page.getByRole("heading", { level: 1, name: /BOX-/ })).toBeVisible();
  await page.getByRole("button", { name: "Add items" }).first().click();
  await page
    .getByRole("dialog", { name: "Add items" })
    .getByRole("link", { name: "or fill in the form yourself" })
    .click();
  await expect(page).toHaveURL(/\/items\/new\?/);
  await expect(page.getByRole("heading", { name: "The essentials" })).toBeVisible();
  await expect(page.getByLabel("Room")).toHaveValue(roomId);
  await expect(page.getByLabel("Storage location")).toHaveValue(containerId);
  await expect(
    page.getByRole("button", { name: /Purchase/ }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("button", { name: /Current value/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Warranty/ }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel(/Purchase total/)).toHaveCount(0);
  await page.getByLabel("Item name").fill(`Context item ${id}`);
  await shot(page, "01-item-form-essentials");
  await page.getByRole("button", { name: "Add to your home" }).click();
  await expect(page.getByRole("heading", { name: `Context item ${id}` })).toBeVisible();
  await expect(page.getByRole("link", { name: /Back to .*Context room/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Documents & manuals" })).toBeVisible();
  await expect(page.getByText("No documents or manuals attached")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload document" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Link existing" })).toBeVisible();
  await page.getByRole("heading", { name: "Documents & manuals" }).scrollIntoViewIfNeeded();
  await shot(page, "02-empty-documents");
});

test("editing only the name preserves collapsed shared purchase, warranty, value and document links", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const fixture = await createDisclosureFixture(request);
  await page.goto(`/items/${fixture.itemId}/edit`);
  await expect(page.getByRole("heading", { name: "The essentials" })).toBeVisible();
  await expect(page.getByText(/Shared purchase/)).toBeVisible();
  await expect(page.getByText(/Stanley · Document: Shared receipt/)).toBeVisible();
  await expect(page.getByText(/per unit · \$50/)).toBeVisible();
  await expect(page.getByLabel(/Purchase total/)).toHaveCount(0);
  await shot(page, "03-collapsed-summaries");

  await page.getByRole("button", { name: /Purchase/ }).click();
  await expect(page.getByLabel(/purchase total/i)).toHaveValue("100.00");
  await expect(page.getByLabel(/Receipt document/)).toHaveValue(fixture.documentId);
  await page.getByRole("button", { name: /Purchase/ }).click();

  await page.getByRole("button", { name: /Earlier estimate/ }).click();
  await expect(page.getByText(/Earlier estimate · per unit · \$50/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Convert to per-unit" })).toHaveCount(0);
  await page.getByRole("button", { name: /Earlier estimate/ }).click();

  await page.getByRole("button", { name: /Warranty/ }).click();
  await expect(page.getByLabel(/Provider/)).toHaveValue("Stanley");
  await expect(page.getByLabel(/Warranty document/)).toHaveValue(fixture.documentId);
  await page.getByRole("button", { name: /Warranty/ }).click();

  await page.getByLabel("Item name").fill(`Disclosure renamed ${fixture.id}`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("heading", { name: `Disclosure renamed ${fixture.id}` }),
  ).toBeVisible();

  const auth = await headers(request);
  const detail = (await (
    await request.get(`/api/v1/items/${fixture.itemId}`, { headers: auth })
  ).json()) as {
    item: {
      name: string;
      purchase: {
        id: string;
        price_cents: number | null;
        currency: string;
        receipt_document_id: string | null;
        item_count: number;
        is_shared: boolean;
      } | null;
      warranty: { provider: string | null; document_id: string | null } | null;
      current_value_cents: number | null;
      documents: Array<{ id: string }>;
    };
  };
  expect(detail.item.name).toBe(`Disclosure renamed ${fixture.id}`);
  expect(detail.item.purchase).toMatchObject({
    id: fixture.purchaseId,
    price_cents: 10000,
    currency: "USD",
    receipt_document_id: fixture.documentId,
    item_count: 2,
    is_shared: true,
  });
  expect(detail.item.warranty).toMatchObject({
    provider: "Stanley",
    document_id: fixture.documentId,
  });
  expect(detail.item.current_value_cents).toBe(5000);
  expect(detail.item.documents.some((document) => document.id === fixture.documentId)).toBe(
    true,
  );
});

test("documents, manuals and image-source details stay coherent and honest", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const fixture = await createDisclosureFixture(request);
  await page.goto(`/items/${fixture.itemId}`);
  await expect(page.getByRole("heading", { name: "Documents & manuals" })).toBeVisible();
  const documentsSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Documents & manuals" }),
  });
  await expect(documentsSection.getByText(`Shared receipt ${fixture.id}`)).toHaveCount(1);
  await expect(documentsSection.getByText(/Exact make\/model is not confirmed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add manual" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find manual" })).toBeVisible();

  await page.getByRole("button", { name: "Ask about this item" }).click();
  await expect(
    page.getByRole("heading", { name: `Ask about Disclosure toolbox ${fixture.id}` }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Find manual" }).click();
  await expect(
    page.getByRole("heading", { name: `Find a manual for Disclosure toolbox ${fixture.id}` }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Search for exact model" })).toBeDisabled();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Link existing" }).click();
  await expect(
    page.getByRole("heading", { name: "Link an existing document" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.getByText("Image source")).toBeVisible();
  await expect(page.getByText("Category icon").first()).toBeVisible();
  await page.getByRole("heading", { name: "Documents & manuals" }).scrollIntoViewIfNeeded();
  await shot(page, "04-documents-manuals");
});

test("pack purchase can be entered per unit and shows the package total on detail", async ({
  page,
  request,
}) => {
  const id = suffix();
  const roomId = await createRoom(request, `Pack room ${id}`);
  const itemId = await createItem(request, `Headlamp pack ${id}`, roomId, {
    quantity: 2,
    purchase: {
      vendor: "Build Supply",
      purchase_date: "2026-02-01",
      price_cents: 10000,
      currency: "USD",
    },
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/items/${itemId}/edit`);
  await page.getByRole("button", { name: /^Purchase/ }).click();
  await expect(page.getByRole("group", { name: "Purchase price basis" })).toBeVisible();
  await expect(page.getByLabel(/purchase total/i)).toHaveValue("100.00");
  const preview = page.getByTestId("purchase-price-preview");
  await expect(preview).toContainText("$100 package total");
  await expect(preview).toContainText("$50 per unit");

  await page.getByRole("button", { name: "Price per unit" }).click();
  const unitPrice = page.getByLabel(/price per unit/i);
  await unitPrice.fill("60");
  await expect(preview).toContainText("$120 package total");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Item updated")).toBeVisible();

  const auth = await headers(request);
  const detail = (await (
    await request.get(`/api/v1/items/${itemId}`, { headers: auth })
  ).json()) as { item: { purchase: { price_cents: number | null } | null } };
  expect(detail.item.purchase?.price_cents).toBe(12000);

  await page.goto(`/items/${itemId}`);
  await expect(page.getByText("Package total")).toBeVisible();
  await expect(page.getByText("$120")).toBeVisible();
  await expect(page.getByText(/\$60 effective per unit/)).toBeVisible();
});

test("item form and detail stay usable at phone, tablet and desktop widths", async ({
  page,
  request,
}) => {
  const fixture = await createDisclosureFixture(request);
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const widths = [320, 390, 768, 1440];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width <= 430 ? 844 : 1024 });
    await page.goto(`/items/${fixture.itemId}/edit`);
    await expect(page.getByLabel("Item name")).toBeVisible();
    await expect(page.getByLabel("Room")).toBeVisible();
    await expect(page.getByLabel("Storage location")).toBeVisible();
    const optionalSections = page.getByTestId("optional-form-sections");
    await expect(optionalSections.getByRole("button")).toHaveCount(4);
    await expect(
      optionalSections.getByRole("button").evaluateAll((buttons) =>
        buttons.every((button) => button.getAttribute("aria-expanded") === "false"),
      ),
    ).resolves.toBe(true);
    if (width === 1440) {
      const boxes = await optionalSections.locator(":scope > section").evaluateAll(
        (sections) =>
          sections.map((section) => {
            const rect = section.getBoundingClientRect();
            return { x: Math.round(rect.x), width: Math.round(rect.width) };
          }),
      );
      expect(new Set(boxes.map((box) => box.x)).size).toBe(1);
      expect(new Set(boxes.map((box) => box.width)).size).toBe(1);
      expect(boxes[0]?.width).toBeGreaterThan(700);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    const fontSizes = await page.evaluate(() => {
      const selectors = ["#item-name", "#item-quantity", "#item-room"];
      return selectors.map((selector) => {
        const element = document.querySelector<HTMLElement>(selector);
        return element ? Number.parseFloat(getComputedStyle(element).fontSize) : 0;
      });
    });
    if (width <= 768) {
      expect(fontSizes.every((size) => size >= 16)).toBe(true);
    }
    if (width === 390) {
      await shot(page, "05-item-form-mobile");
    }
    if (width === 768) {
      await shot(page, "06-item-form-tablet");
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/items/${fixture.itemId}`);
  await expect(page.getByRole("heading", { name: "Documents & manuals" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
});
