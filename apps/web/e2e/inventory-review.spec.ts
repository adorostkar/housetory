import { expect, test, type APIRequestContext } from "@playwright/test";

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function currentHeaders(request: APIRequestContext) {
  const response = await request.get("/api/v1/auth/session");
  const session = (await response.json()) as { household: { id: string } };
  return { "X-Household-Id": session.household.id };
}

async function createRoom(request: APIRequestContext, name: string) {
  const headers = await currentHeaders(request);
  const propertiesResponse = await request.get("/api/v1/properties", { headers });
  const properties = (await propertiesResponse.json()) as {
    items: Array<{ id: string }>;
  };
  const response = await request.post("/api/v1/rooms", {
    headers,
    data: { name, property_id: properties.items[0]?.id },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
}

async function createCategory(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/categories", {
    headers: await currentHeaders(request),
    data: { name },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
}

async function clickFindSuggestions(page: import("@playwright/test").Page) {
  const response = page.waitForResponse(
    (entry) =>
      entry.request().method() === "POST" &&
      entry.url().endsWith("/api/v1/inventory-review/runs"),
  );
  await page.getByRole("button", { name: "Find suggestions" }).click();
  const result = await response;
  expect(result.ok()).toBeTruthy();
}

async function createItem(
  request: APIRequestContext,
  name: string,
  roomId: string,
  extra: Record<string, unknown> = {},
) {
  const response = await request.post("/api/v1/items", {
    headers: await currentHeaders(request),
    data: { name, room_id: roomId, ...extra },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    item: { id: string; name: string; quantity: number };
  };
}

test("rule-based review persists actionable suggestions, supports apply/undo and suppresses dismissed duplicates", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const id = suffix();
  const room = await createRoom(request, `Review room ${id}`);
  const tools = await createCategory(request, `Tools ${id}`);
  await createItem(request, `Review drill ${id}`, room.id, {
    category_id: tools.id,
    brand: "DeWalt",
    model: "DCD791",
  });
  await createItem(request, `Review drill ${id}`, room.id, {
    brand: "DeWalt",
    model: "DCD791",
  });
  await createItem(request, `Bench Plane ${id}`, room.id, {
    category_id: tools.id,
  });
  await createItem(request, `Bench plane ${id}`, room.id);
  const duplicateOne = await createItem(request, `Review camera ${id}`, room.id, {
    brand: "Sony",
    model: "AC-UUD12",
    category_id: tools.id,
    quantity: 2,
  });
  await createItem(request, `Review camera ${id}`, room.id, {
    brand: "Sony",
    model: "AC-UUD12",
    category_id: tools.id,
    quantity: 1,
  });
  const loan = await request.post("/api/v1/loans", {
    headers: await currentHeaders(request),
    data: {
      item_id: duplicateOne.item.id,
      borrower_name: "Review borrower",
      quantity: 1,
      lent_on: "2026-10-01",
      request_id: crypto.randomUUID(),
    },
  });
  expect(loan.ok()).toBeTruthy();

  await page.goto("/review");
  await expect(page.getByRole("heading", { name: "Review", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("checkbox", {
      name: /Include optional AI-assisted category suggestions/,
    }),
  ).not.toBeChecked();
  await clickFindSuggestions(page);
  await expect(page.getByText(/offline rules only/)).toBeVisible();

  const categoryCard = page
    .locator("li")
    .filter({ hasText: `Assign category “Tools ${id}”` })
    .first();
  await expect(categoryCard).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/inventory-review/01-suggestion-queue.png",
    fullPage: false,
  });

  await categoryCard.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Suggestion applied to the item.")).toBeVisible();
  await page.getByLabel("Filter suggestions by status").selectOption("accepted");
  const acceptedCard = page
    .locator("li")
    .filter({ hasText: `Assign category “Tools ${id}”` })
    .first();
  await expect(acceptedCard.getByText("accepted")).toBeVisible();
  await expect(acceptedCard.getByRole("button", { name: "Undo" })).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/inventory-review/02-accepted-with-undo.png",
    fullPage: false,
  });
  await acceptedCard.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Applied review change reverted.")).toBeVisible();

  await page.getByLabel("Filter suggestions by status").selectOption("pending");
  const duplicateCard = page
    .locator("li")
    .filter({ hasText: `Possible duplicate: Review camera ${id}` })
    .first();
  await expect(duplicateCard).toBeVisible();
  await expect(
    duplicateCard.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(0);
  await duplicateCard.getByRole("button", { name: "Compare" }).click();
  const compareDialog = page.getByRole("dialog");
  await expect(compareDialog.getByText(/does not merge inventory/i)).toBeVisible();
  await expect(compareDialog.getByText(/On loan: 1/)).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/inventory-review/03-duplicate-compare.png",
    fullPage: false,
  });
  await compareDialog.getByRole("button", { name: "Close" }).click();

  await duplicateCard.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("Suggestion dismissed.")).toBeVisible();
  await clickFindSuggestions(page);
  await expect(
    page.getByText(`Possible duplicate: Review camera ${id}`),
  ).toHaveCount(0);
});

test("selected-items review is reachable from the Items bulk action", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const id = suffix();
  const room = await createRoom(request, `Scoped review room ${id}`);
  const category = await createCategory(request, `Scoped tools ${id}`);
  const first = await createItem(request, `Scoped drill ${id}`, room.id, {
    category_id: category.id,
  });
  const second = await createItem(request, `Scoped drill ${id}`, room.id);

  await page.goto(`/items?q=${encodeURIComponent(`Scoped drill ${id}`)}`);
  await page.getByRole("checkbox", { name: "Select all loaded items" }).check();
  await expect(page.getByText(/2 items selected/)).toBeVisible();
  const bulkBar = page
    .locator("div.surface")
    .filter({ hasText: "2 items selected" })
    .last();
  await bulkBar.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/review\?scope_type=items&item_ids=/);
  await expect(page.getByLabel("Review scope type")).toHaveValue("items");
  await expect(page.getByText(`Scoped drill ${id}`).first()).toBeVisible();
  await clickFindSuggestions(page);
  await expect(page.getByText(`Assign category “Scoped tools ${id}”`)).toBeVisible();
  await expect(
    page.getByText(new RegExp(`Selected items \\(2\\)`)),
  ).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/inventory-review/04-selected-items-scope.png",
    fullPage: false,
  });
  expect(first.item.id).not.toBe(second.item.id);
});
