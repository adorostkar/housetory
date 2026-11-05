import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createRoom(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/rooms", { data: { name } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
}

async function createContainer(request: APIRequestContext, roomId: string, name: string) {
  const response = await request.post("/api/v1/containers", {
    data: { room_id: roomId, container_type: "box", name },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    id: string;
    identifier: string;
    name: string;
  };
}

async function createItem(
  request: APIRequestContext,
  payload: Record<string, unknown>,
) {
  const response = await request.post("/api/v1/items", { data: payload });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

async function createLoan(
  request: APIRequestContext,
  itemId: string,
  payload: Record<string, unknown>,
) {
  const response = await request.post("/api/v1/loans", {
    data: {
      item_id: itemId,
      lent_on: "2026-10-01",
      request_id: crypto.randomUUID(),
      ...payload,
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; due_on: string | null };
}

function visibleQuickSearch(page: Page) {
  return page.locator('input[data-quick-search-input="true"]:visible').first();
}

test("unified search answers the heavy drill loan question without claiming it is in the box", async ({
  page,
  request,
}) => {
  const id = suffix();
  const workshop = await createRoom(request, `Workshop ${id}`);
  const toolbox = await createContainer(request, workshop.id, `Power tools ${id}`);
  const drill = await createItem(request, {
    name: `Heavy drill ${id}`,
    brand: "Makita",
    model: "HP-2",
    quantity: 2,
    room_id: workshop.id,
    storage_location_id: toolbox.id,
  });
  const dueOn = "2026-11-20";
  const dueLabel = "20 Nov 2026";
  await createLoan(request, drill.item.id, {
    borrower_name: "Alex",
    quantity: 1,
    due_on: dueOn,
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  const input = visibleQuickSearch(page);
  await input.click();
  await input.fill(`where is my heavy drill ${id}`);
  const panel = page.getByRole("listbox", { name: "Quick search results" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(new RegExp(`On loan to Alex`))).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/search\?q=.*ask=1/);
  await expect(
    page.getByText(/Alex has 1 of your 2 units of Makita Heavy drill/).first(),
  ).toBeVisible();
  await expect(page.getByText(/at home in Workshop/).first()).toBeVisible();
  await expect(page.getByText(new RegExp(`Due ${dueLabel}`)).first()).toBeVisible();
  await expect(page.getByText(/BOX-\d+ · Power tools/).first()).toBeVisible();
  await expect(page.getByText(/On loan: 1 with Alex/)).toHaveCount(0);
  await expect(page.getByText(/guarantee of return/)).toHaveCount(0);

  await page.getByRole("link", { name: /Continue in Assistant/ }).click();
  await expect(page).toHaveURL(/\/assistant\?q=/);
  await expect(
    page.getByText(/Alex has 1 of your 2 units of Makita Heavy drill/).first(),
  ).toBeVisible();
  await expect(page.getByText("Privacy & model details")).toBeVisible();
  const assistantInput = page.getByRole("textbox", {
    name: "Ask the Housetory assistant",
  });
  await assistantInput.fill("when is it due?");
  await page.getByRole("button", { name: "Send question" }).click();
  await expect(page.getByText(new RegExp(`Due ${dueLabel}`)).first()).toBeVisible();
});

test("mobile keyword search stays local and missing-purchase filters match the answer", async ({
  page,
  request,
}) => {
  const id = suffix();
  const living = await createRoom(request, `Living room ${id}`);
  const shelf = await request.post("/api/v1/storage-locations", {
    data: { room_id: living.id, name: `TV shelf ${id}`, kind: "shelf" },
  });
  expect(shelf.ok()).toBeTruthy();
  const shelfRecord = (await shelf.json()) as { id: string };
  const ps5 = await createItem(request, {
    name: `PS5 ${id}`,
    brand: "Sony",
    model: "Slim",
    room_id: living.id,
    storage_location_id: shelfRecord.id,
    purchase: {
      merchant: "Game Shop",
      purchase_date: "2026-01-10",
      price_cents: 49900,
      currency: "USD",
    },
  });
  const lantern = await createItem(request, {
    name: `Old lantern ${id}`,
    room_id: living.id,
  });

  const naturalRequests: string[] = [];
  page.on("request", (requestEvent) => {
    if (
      requestEvent.method() === "POST" &&
      requestEvent.url().includes("/api/v1/search/natural")
    ) {
      naturalRequests.push(requestEvent.url());
    }
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const mobileInput = page.locator('input[data-quick-search-input="true"]:visible').first();
  await mobileInput.click();
  await mobileInput.fill(`PS5 ${id}`);
  const panel = page.getByRole("listbox", { name: "Quick search results" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(new RegExp(`PS5 ${id}`))).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/search\\?q=PS5`));
  await expect(page).not.toHaveURL(/ask=1/);
  await expect(
    page.getByRole("link", { name: new RegExp(`PS5 ${id}`) }),
  ).toBeVisible();
  expect(naturalRequests).toHaveLength(0);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `/search?q=${encodeURIComponent("Which items have no purchase information?")}&ask=1`,
  );
  await expect(page.getByText(/missing or unresolved purchase information/).first()).toBeVisible();
  await page.getByRole("link", { name: "Open matching filters" }).click();
  await expect(page).toHaveURL(/\/items\?purchase_info=missing/);

  const itemSearch = page.getByLabel("Search items");
  await itemSearch.fill(`Old lantern ${id}`);
  await expect(
    page.getByRole("link", { name: new RegExp(`Old lantern ${id}`) }).first(),
  ).toBeVisible();
  await itemSearch.fill(`PS5 ${id}`);
  await expect(page.getByText("Nothing matches.")).toBeVisible();

  // The PS5 has purchase details and must not be part of the missing filter.
  expect(ps5.item.id).toBeTruthy();
  expect(lantern.item.id).toBeTruthy();
});
