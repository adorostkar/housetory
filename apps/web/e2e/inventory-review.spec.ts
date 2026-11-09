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
      name: /Include optional AI-assisted organisation suggestions/,
    }),
  ).not.toBeChecked();
  await clickFindSuggestions(page);
  await expect(page.getByText(/offline rules only/)).toBeVisible();
  await expect(page.getByText(/Review complete:/)).toBeHidden({ timeout: 10_000 });

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
  await expect(page.getByText("Suggestion applied to the item.")).toBeHidden({
    timeout: 10_000,
  });
  await page.getByLabel("Filter suggestions by status").selectOption("accepted");
  const acceptedCard = page
    .locator("li")
    .filter({ hasText: `Assign category “Tools ${id}”` })
    .first();
  await expect(acceptedCard.getByText("accepted")).toBeVisible();
  await expect(acceptedCard.getByRole("button", { name: "Undo" })).toBeVisible();
  await page.waitForTimeout(350);
  await page.screenshot({
    path: "../../docs/walkthrough/inventory-review/02-accepted-with-undo.png",
    fullPage: false,
  });
  await acceptedCard.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Applied review change reverted.")).toBeVisible();
  await expect(page.getByText("Applied review change reverted.")).toBeHidden({
    timeout: 10_000,
  });

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
  await page.waitForTimeout(350);
  await page.screenshot({
    path: "../../docs/walkthrough/inventory-review/03-duplicate-compare.png",
    fullPage: false,
  });
  await compareDialog.getByRole("button", { name: "Close" }).first().click();

  await duplicateCard.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("Suggestion dismissed.")).toBeVisible();
  await clickFindSuggestions(page);
  await expect(
    page.getByText(`Possible duplicate: Review camera ${id}`),
  ).toHaveCount(0);
});

test("Review item origins preserve scope, queue filters, search and edit roundtrips", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const id = suffix();
  const room = await createRoom(request, `Context room ${id}`);
  const category = await createCategory(request, `Context tools ${id}`);
  await createItem(request, `Context drill ${id}`, room.id, {
    category_id: category.id,
  });
  await createItem(request, `Context drill ${id}`, room.id);
  await createItem(request, `Context camera ${id}`, room.id, {
    brand: "Sony",
    model: "CTX-1",
    category_id: category.id,
  });
  await createItem(request, `Context camera ${id}`, room.id, {
    brand: "Sony",
    model: "CTX-1",
    category_id: category.id,
  });

  await page.goto("/review");
  await clickFindSuggestions(page);
  await page.getByLabel("Filter suggestions by status").selectOption("pending");
  await page.getByLabel("Filter suggestions by type").selectOption("category");
  await page.getByLabel("Search suggestions").fill(`Context tools ${id}`);
  await expect(
    page.getByRole("link", { name: new RegExp(`Context drill ${id}`) }).first(),
  ).toBeVisible();
  await page
    .getByRole("link", { name: new RegExp(`Context drill ${id}`) })
    .first()
    .click();
  await expect(
    page.getByRole("link", { name: "Back to Review" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/from=/);

  await page.getByRole("link", { name: "Edit", exact: true }).first().click();
  await page.getByLabel("Item name").fill(`Renamed context drill ${id}`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("heading", { name: `Renamed context drill ${id}` }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Back to Review" }).click();
  await expect(page).toHaveURL(/status=pending/);
  await expect(page).toHaveURL(/suggestion_type=category/);
  await expect(page).toHaveURL(new RegExp(`q=Context\\+tools\\+${id}`));
  await expect(page.getByLabel("Filter suggestions by status")).toHaveValue(
    "pending",
  );
  await expect(page.getByLabel("Filter suggestions by type")).toHaveValue(
    "category",
  );
  await expect(page.getByLabel("Search suggestions")).toHaveValue(
    `Context tools ${id}`,
  );
  await expect(page.getByText("Item updated")).toBeHidden({ timeout: 10_000 });
  await page.waitForTimeout(450);
  await page.screenshot({
    path: "../../docs/walkthrough/inventory-review/05-filter-context-roundtrip.png",
    fullPage: false,
  });

  // Cancel also returns to the same item detail and preserves the queue origin.
  await page
    .getByRole("link", { name: new RegExp(`Renamed context drill ${id}`) })
    .first()
    .click();
  await page.getByRole("link", { name: "Edit", exact: true }).first().click();
  await page.getByLabel("Item name").fill(`Discarded context name ${id}`);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(
    page.getByRole("heading", { name: `Renamed context drill ${id}` }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Back to Review" }).click();
  await expect(page.getByLabel("Search suggestions")).toHaveValue(
    `Context tools ${id}`,
  );

  // Browser Back from item detail returns to the filtered Review URL.
  await page
    .getByRole("link", { name: new RegExp(`Renamed context drill ${id}`) })
    .first()
    .click();
  await page.goBack();
  await expect(page).toHaveURL(/status=pending/);
  await expect(page).toHaveURL(/suggestion_type=category/);
  await expect(page.getByLabel("Search suggestions")).toHaveValue(
    `Context tools ${id}`,
  );

  // Deep links validate and retain the queue filters.
  await page.goto(
    `/review?scope_type=household&status=accepted&suggestion_type=category&q=NoSuchQueue`,
  );
  await expect(page.getByLabel("Filter suggestions by status")).toHaveValue(
    "accepted",
  );
  await expect(page.getByLabel("Filter suggestions by type")).toHaveValue(
    "category",
  );
  await expect(page.getByLabel("Search suggestions")).toHaveValue("NoSuchQueue");

  // Reset removes queue filters but keeps the selected scope.
  await page.goto(
    `/review?scope_type=household&status=pending&suggestion_type=category&q=Context`,
  );
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(page.getByLabel("Filter suggestions by status")).toHaveValue(
    "pending",
  );
  await expect(page.getByLabel("Filter suggestions by type")).toHaveValue("");
  await expect(page.getByLabel("Search suggestions")).toHaveValue("");
  await expect(page).toHaveURL(/scope_type=household/);
  await expect(page).not.toHaveURL(/status=/);
  await expect(page).not.toHaveURL(/suggestion_type=/);

  // Duplicate comparison links carry the same queue context.
  await page.getByLabel("Filter suggestions by type").selectOption(
    "possible_duplicate",
  );
  await page.getByLabel("Search suggestions").fill(`Context camera ${id}`);
  const contextDuplicateCard = page
    .locator("li")
    .filter({ hasText: `Possible duplicate: Context camera ${id}` })
    .first();
  await expect(contextDuplicateCard).toBeVisible();
  await contextDuplicateCard.getByRole("button", { name: "Compare" }).click();
  const compareDialog = page.getByRole("dialog");
  await compareDialog.getByRole("link", { name: "Open item" }).first().click();
  await expect(
    page.getByRole("link", { name: "Back to Review" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Back to Review" }).click();
  await expect(page).toHaveURL(/suggestion_type=possible_duplicate/);
  await expect(page.getByLabel("Search suggestions")).toHaveValue(
    `Context camera ${id}`,
  );
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
  await expect(page.getByText(/Review complete:/)).toBeHidden({ timeout: 10_000 });
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

test("Review schedule is off by default, saves offline-only and disables cleanly", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const headers = await currentHeaders(request);
  const reset = await request.put("/api/v1/inventory-review/schedule", {
    headers,
    data: {
      enabled: false,
      scope_type: "household",
      scope_id: null,
      frequency: "weekly",
      timezone: "UTC",
      weekday: 0,
      monthly_day: 1,
      local_hour: 9,
      max_items: 200,
      max_runs_per_day: 1,
      include_ai: false,
      ai_consent: false,
    },
  });
  expect(reset.ok()).toBeTruthy();
  await page.goto("/review");
  await expect(
    page.getByRole("heading", { name: "Scheduled review" }),
  ).toBeVisible();
  await expect(page.getByText("Off", { exact: true })).toBeVisible();

  // The disposable household starts without a schedule; if a prior local
  // attempt left one, open its edit dialog instead.
  const setupButton = page.getByRole("button", { name: "Set up schedule" });
  const editButton = page.getByRole("button", { name: "Edit schedule" });
  if (await setupButton.isVisible()) {
    await setupButton.click();
  } else {
    await editButton.click();
  }
  await expect(
    page.getByRole("dialog").getByText("Scheduled inventory review"),
  ).toBeVisible();
  const enable = page.getByLabel("Enable scheduled review");
  if (!(await enable.isChecked())) await enable.check();
  const timezone = page.getByLabel("Schedule timezone");
  await timezone.fill("UTC");
  await page.getByLabel("Schedule scope type").selectOption("household");
  await expect(
    page.getByLabel("Include scheduled AI-assisted organisation"),
  ).not.toBeChecked();

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/api/v1/inventory-review/schedule"),
  );
  await page.getByRole("button", { name: "Save schedule" }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(page.getByText("Scheduled review settings saved.")).toBeVisible();
  await expect(page.getByText("Scheduled review settings saved.")).toBeHidden({
    timeout: 10_000,
  });
  await expect(page.getByText("Scheduled", { exact: true })).toBeVisible();
  await expect(page.getByText(/Next:/)).toBeVisible();
  await expect(page.getByText(/Weekly on/)).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/inventory-review/06-review-schedule.png",
    fullPage: false,
  });

  await page.getByRole("button", { name: "Edit schedule" }).click();
  await page.getByLabel("Enable scheduled review").uncheck();
  const disabled = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/api/v1/inventory-review/schedule"),
  );
  await page.getByRole("button", { name: "Save schedule" }).click();
  expect((await disabled).ok()).toBeTruthy();
  await expect(page.getByText("Off", { exact: true })).toBeVisible();
  await expect(page.getByText("Automatic review is off.")).toBeVisible();
});
