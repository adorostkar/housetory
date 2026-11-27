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

  // Enter sends a question to the assistant, which opens over the page.
  await expect(page).toHaveURL(/#assistant$/);
  await expect(page).not.toHaveURL(/ask=1/);
  const assistant = page.getByTestId("assistant-panel");
  await expect(
    assistant.getByText(/Alex has 1 of your 2 units of Makita Heavy drill/).first(),
  ).toBeVisible();
  await expect(assistant.getByText(/at home in Home → Workshop/).first()).toBeVisible();
  await expect(assistant.getByText(new RegExp(`Due ${dueLabel}`)).first()).toBeVisible();
  await expect(assistant.getByText(/BOX-\d+ · Power tools/).first()).toBeVisible();
  await expect(assistant.getByText(/On loan: 1 with Alex/)).toHaveCount(0);
  await expect(assistant.getByText(/guarantee of return/)).toHaveCount(0);

  // The follow-up goes in the assistant's own field, so it is about the same drill.
  await assistant.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("when is it due?");
  await assistant.getByRole("button", { name: "Send question", exact: true }).click();
  await expect(assistant.getByText("when is it due?", { exact: true })).toBeVisible();
  await expect(assistant.getByRole("button", { name: "Copy answer" })).toHaveCount(2);
  await expect(assistant.getByText(new RegExp(`Due ${dueLabel}`)).last()).toBeVisible();
  await expect(
    assistant.getByText(/^(AI off · local answer|AI-assisted|Direct lookup)$/).last(),
  ).toBeVisible();
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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const mobileInput = page.locator('input[data-quick-search-input="true"]:visible').first();
  await mobileInput.click();
  await mobileInput.fill(`PS5 ${id}`);
  const panel = page.getByRole("listbox", { name: "Quick search results" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("option", { name: new RegExp(`^PS5 ${id}`) })).toBeVisible();
  await page.keyboard.press("Enter");
  // A plain name stays local: it filters the item list and the assistant is not opened.
  await expect(page).toHaveURL(/\/items\?q=PS5/);
  await expect(page).not.toHaveURL(/ask=1|#assistant/);
  await expect(page.getByTestId("assistant-panel")).toHaveCount(0);
  await expect(
    page.locator("main").getByRole("link", { name: new RegExp(`PS5 ${id}`) }).first(),
  ).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `/search?q=${encodeURIComponent("Which items have no purchase information?")}&ask=1`,
  );
  // The old "ask" link opens the assistant with the question.
  const assistant = page.getByTestId("assistant-panel");
  await expect(assistant.getByText(/missing or unresolved purchase information/).first()).toBeVisible();
  await assistant.getByRole("link", { name: "Open matching records" }).click();
  await expect(page).toHaveURL(/\/items\?purchase_info=missing/);

  // The field in the bar searches inside the filtered list.
  const itemSearch = page
    .getByTestId("bottom-bar")
    .getByRole("combobox", { name: "Search or ask about your inventory" });
  await itemSearch.fill(`Old lantern ${id}`);
  await expect(page).toHaveURL(/purchase_info=missing/);
  await expect(
    page.locator("main").getByRole("link", { name: new RegExp(`Old lantern ${id}`) }).first(),
  ).toBeVisible();
  await itemSearch.fill(`PS5 ${id}`);
  await expect(page.locator("main").getByText("Nothing matches.")).toBeVisible();
  await expect(page).toHaveURL(/purchase_info=missing/);

  // The PS5 has purchase details and must not be part of the missing filter.
  expect(ps5.item.id).toBeTruthy();
  expect(lantern.item.id).toBeTruthy();
});
