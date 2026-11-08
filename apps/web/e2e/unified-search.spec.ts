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

async function removeConfiguredProviders(request: APIRequestContext) {
  const auth = await headers(request);
  const settings = await request.get("/api/v1/ai/settings", { headers: auth });
  expect(settings.ok()).toBeTruthy();
  const body = (await settings.json()) as { providers: Array<{ id: string }> };
  for (const provider of body.providers) {
    const deleted = await request.delete(`/api/v1/ai/providers/${provider.id}`, {
      headers: auth,
    });
    expect(deleted.status()).toBe(204);
  }
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
    answer_direction: "auto",
    preserve_terms: [],
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
          answer:
            `**Heavy drill ${id}** در کارگاه ثبت شده است.\n\n` +
            "- یک واحد در کارگاه ثبت شده است.\n" +
            "- قرض باز برای آن ثبت نشده است.\n\n" +
            "مسیر: Home / Workshop / BOX-001",
          answer_direction: "rtl",
          preserve_terms: [item.name, "HP-2", "Home / Workshop / BOX-001"],
        }),
      ),
    });
  });

  await page.goto(`/search?q=${encodeURIComponent("دریل من کجاست؟")}&ask=1&r=1`);
  const answer = page.getByTestId("answer-text").first();
  await expect(answer).toHaveAttribute("dir", "rtl");
  await expect(
    answer.locator("strong").filter({ hasText: `Heavy drill ${id}` }),
  ).toBeVisible();
  await expect(answer.getByRole("listitem")).toHaveCount(2);
  await expect(answer).toContainText("در کارگاه ثبت شده است");
  await expect(answer).toContainText("Home / Workshop / BOX-001");
  await expect(page.getByText(/\*\*/)).toHaveCount(0);
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

test("only one visible search entry is tabbable at phone, tablet and desktop widths", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
    window.localStorage.removeItem("housetory-search-scope");
  });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({
      width,
      height: width <= 430 ? 844 : width === 768 ? 1024 : 1000,
    });
    await page.goto("/items");
    const allInputs = page.locator('input[data-quick-search-input="true"]');
    const visibleInputs = page.locator(
      'input[data-quick-search-input="true"]:visible',
    );
    await expect(visibleInputs).toHaveCount(1);
    const expectedVariant = width >= 1024 ? "top" : "mobile";
    await page.keyboard.press("ControlOrMeta+K");
    const active = await page.evaluate(() => ({
      variant: document.activeElement?.getAttribute(
        "data-quick-search-variant",
      ),
      visible:
        document.activeElement instanceof HTMLElement &&
        document.activeElement.getClientRects().length > 0,
    }));
    expect(active.visible).toBe(true);
    expect(active.variant).toBe(expectedVariant);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    if (width <= 768) {
      const fontSize = await visibleInputs
        .first()
        .evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).fontSize),
        );
      expect(fontSize).toBeGreaterThanOrEqual(16);
    }
    await visibleInputs.first().fill("دریل DCD791");
    await expect(visibleInputs.first()).toHaveValue("دریل DCD791");
    await expect(visibleInputs.first()).toHaveAttribute("dir", "auto");
    expect(await allInputs.count()).toBeGreaterThanOrEqual(1);
  }
});

test("plain named reload stays direct and does not duplicate dialogue turns", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
    window.localStorage.removeItem("housetory-search-scope");
  });
  const id = suffix();
  const roomId = await createRoom(request, `Reload room ${id}`);
  const item = await createItem(request, `Heavy drill ${id}`, roomId);
  const detail = await itemDetail(request, item.id);
  const requests: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/search/query", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        searchPayload(detail, {
          query: body.query,
          mode: "direct",
          ai_used: false,
          ai_attempted: false,
          answer: null,
        }),
      ),
    });
  });
  const url = `/search?q=${encodeURIComponent(`Heavy drill ${id}`)}&r=1`;
  await page.goto(url);
  await expect(page.getByText("Direct inventory lookup")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Direct inventory lookup")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Direct inventory lookup")).toBeVisible();
  expect(requests).toHaveLength(3);
  const sessions = await page.evaluate(() =>
    Object.entries(window.sessionStorage)
      .filter(([key]) => key.startsWith("housetory-search-session:"))
      .map(([, value]) => JSON.parse(value) as { turns: unknown[] }),
  );
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.turns).toHaveLength(2);
});

test("no-provider persian fallback keeps direct records and is honestly labelled", async ({
  page,
  request,
}) => {
  await removeConfiguredProviders(request);
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
