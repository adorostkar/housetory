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
  return ((await response.json()) as { id: string; name: string }).id;
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
  return ((await response.json()) as { item: { id: string; name: string } }).item;
}

async function itemDetail(request: APIRequestContext, itemId: string) {
  const auth = await headers(request);
  const response = await request.get(`/api/v1/items/${itemId}`, { headers: auth });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { item: Record<string, unknown> }).item;
}

async function shot(page: Page, name: string) {
  await fs.mkdir("../../docs/walkthrough/unified-search", { recursive: true });
  await page.screenshot({
    path: `../../docs/walkthrough/unified-search/${name}.png`,
    fullPage: false,
    animations: "disabled",
  });
}

function aiStatus() {
  return {
    provider: "none",
    mode: "disabled",
    source: "disabled",
    task: "search",
    provider_id: null,
    provider_label: null,
    capabilities: [],
    model: null,
    configured: false,
    available: false,
    catalog_checked: false,
    catalog_count: 0,
    cloud_enabled: false,
    cloud_consent: false,
    data_leaves_server: false,
    error: null,
    privacy_note: "No provider configured.",
  };
}

function searchPayload(
  item: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    query: String(overrides.query ?? "PS5"),
    mode: "ai",
    ai_used: true,
    ai_attempted: true,
    direct_match: true,
    ambiguous: false,
    needs_clarification: false,
    answer: "پاسخ آزمایشی grounded.",
    answer_kind: "locate_item",
    interpretation: "item: test",
    filters: {},
    items: [item],
    quick_results: [],
    borrowed: [],
    borrowed_total: 0,
    total: 1,
    documents: [],
    locations: [],
    references: [
      {
        type: "item",
        id: item.id,
        title: item.name,
        subtitle: null,
        url: `/items/${item.id}`,
        household_id: null,
        household_name: null,
      },
    ],
    notices: [],
    facts: {
      total: 1,
      whereabouts: {
        item_id: item.id,
        item_name: item.name,
        on_loan_quantity: 0,
        at_home_quantity: 1,
        home_path: "Home → Workshop",
      },
    },
    tool: "locate_item",
    ai_status: aiStatus(),
    context: {
      scope_key: "",
      last_query: String(overrides.query ?? "PS5"),
      resolved_items: [{ id: item.id, name: item.name }],
      candidate_items: [{ id: item.id, name: item.name }],
      loans: [],
    },
    scope_label: "All my places",
    households: [],
    property: null,
    ...overrides,
  };
}

test("one global search box drives direct results on desktop and mobile", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
    window.localStorage.removeItem("housetory-search-scope");
  });
  const id = suffix();
  const roomId = await createRoom(request, `Unified room ${id}`);
  const item = await createItem(request, `PS5 console ${id}`, roomId, {
    brand: "Sony",
    model: "Slim",
  });

  await page.goto("/items");
  const inputs = page.getByRole("combobox", {
    name: "Search or ask about your inventory",
  });
  await expect(inputs).toHaveCount(1);
  await expect(inputs.first()).toBeVisible();
  await expect(page.locator("aside").getByRole("combobox")).toHaveCount(0);
  await inputs.first().fill(`PS5 console ${id}`);
  await inputs.first().press("Enter");
  await expect(page).toHaveURL(/\/search\?q=.*r=/);
  await expect(
    page.getByRole("link", { name: new RegExp(`PS5 console ${id}`) }).first(),
  ).toBeVisible();
  await expect(page.getByText("Direct inventory lookup")).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Search or ask about your inventory" }),
  ).toHaveCount(1);
  await shot(page, "01-direct-desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `/search?q=${encodeURIComponent(`PS5 console ${id}`)}&r=1`,
  );
  const mobileInput = page
    .getByRole("combobox", { name: "Search or ask about your inventory" })
    .first();
  await expect(mobileInput).toBeVisible();
  const metrics = await mobileInput.evaluate((element) => ({
    fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
    overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
  }));
  expect(metrics.fontSize).toBeGreaterThanOrEqual(16);
  expect(metrics.overflow).toBe(true);
  await expect(
    page.getByRole("link", { name: new RegExp(`PS5 console ${id}`) }).first(),
  ).toBeVisible();
  await shot(page, "02-direct-mobile");
  expect(item.id).toBeTruthy();
});

test("persian question renders an AI-assisted answer with actionable items", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
    window.localStorage.removeItem("housetory-search-scope");
  });
  const id = suffix();
  const roomId = await createRoom(request, `Persian room ${id}`);
  const item = await createItem(request, `Heavy drill ${id}`, roomId, {
    brand: "Makita",
    model: "HP-2",
  });
  const detail = await itemDetail(request, item.id);
  let requestBody: Record<string, unknown> | null = null;

  await page.route("**/api/v1/search/query", async (route) => {
    requestBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        searchPayload(detail, {
          query: "دریل من کجاست؟",
          answer: `دریل شما در کارگاه است. نام ثبت‌شده: Heavy drill ${id}.`,
        }),
      ),
    });
  });

  await page.goto(`/search?q=${encodeURIComponent("دریل من کجاست؟")}&ask=1&r=1`);
  await expect(
    page.getByText(`دریل شما در کارگاه است. نام ثبت‌شده: Heavy drill ${id}.`),
  ).toBeVisible();
  await expect(page.getByText("AI-assisted answer")).toBeVisible();
  await expect(
    page.getByRole("link", { name: new RegExp(`Heavy drill ${id}`) }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Continue in Assistant/ }),
  ).toHaveCount(0);
  expect(requestBody).toMatchObject({
    query: "دریل من کجاست؟",
    explicit_ask: true,
  });
  await shot(page, "03-ai-assisted-persian");
});

test("follow-up submit carries bounded history and resolved item context", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
    window.localStorage.removeItem("housetory-search-scope");
  });
  const id = suffix();
  const roomId = await createRoom(request, `Follow-up room ${id}`);
  const item = await createItem(request, `Heavy drill ${id}`, roomId, {
    quantity: 2,
  });
  const detail = await itemDetail(request, item.id);
  const requests: Array<Record<string, unknown>> = [];

  await page.route("**/api/v1/search/query", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(body);
    const query = String(body.query ?? "");
    if (query.startsWith("Where is my heavy drill")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          searchPayload(detail, {
            query,
            mode: "direct",
            ai_used: false,
            ai_attempted: false,
            answer: `Heavy drill ${id} is in the workshop.`,
          }),
        ),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        searchPayload(detail, {
          query,
          answer: `Mohsen had it for 10 days and returned it.`,
        }),
      ),
    });
  });

  await page.goto(
    `/search?q=${encodeURIComponent(`Where is my heavy drill ${id}?`)}&r=1`,
  );
  await expect(
    page.getByText(`Heavy drill ${id} is in the workshop.`),
  ).toBeVisible();
  const globalInput = page
    .getByRole("combobox", { name: "Search or ask about your inventory" })
    .first();
  await globalInput.fill("Did I loan it to someone else before?");
  await globalInput.press("Enter");
  await expect(
    page.getByText("Mohsen had it for 10 days and returned it."),
  ).toBeVisible();
  expect(requests).toHaveLength(2);
  const followUp = requests[1]!;
  const history = followUp.history as Array<{ role: string; content: string }>;
  expect(history).toHaveLength(2);
  expect(history[0]).toMatchObject({ role: "user" });
  expect(history[0]?.content).toContain("Where is my heavy drill");
  const context = followUp.context as {
    resolved_items?: Array<{ id: string }>;
  };
  expect(context.resolved_items?.[0]?.id).toBe(item.id);
  await shot(page, "04-follow-up-ai");
});

test("no-provider persian fallback keeps direct records and is honestly labelled", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
    window.localStorage.removeItem("housetory-search-scope");
  });
  const id = suffix();
  const roomId = await createRoom(request, `Fallback room ${id}`);
  const item = await createItem(request, `دریل برقی ${id}`, roomId);
  await page.goto(
    `/search?q=${encodeURIComponent(`دریل ${id} کجاست؟`)}&r=1`,
  );
  await expect(
    page.getByText("AI unavailable · direct results only"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: new RegExp(`دریل برقی ${id}`) }).first(),
  ).toBeVisible();
  await expect(page.getByText(/not a conclusive no-result answer/)).toBeVisible();
  expect(item.id).toBeTruthy();
  await shot(page, "05-fallback-persian");
});
