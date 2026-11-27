import fs from "node:fs/promises";

import { expect, test, type APIRequestContext } from "@playwright/test";

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

interface SessionState {
  household: { id: string; name: string } | null;
  households: Array<{ id: string; name: string; role: string }>;
}

async function readSession(request: APIRequestContext): Promise<SessionState> {
  const response = await request.get("/api/v1/auth/session");
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as SessionState;
}

async function currentHeaders(request: APIRequestContext) {
  const session = await readSession(request);
  expect(session.household).toBeTruthy();
  return { "X-Household-Id": session.household!.id };
}

async function createRoom(
  request: APIRequestContext,
  name: string,
  propertyId?: string,
) {
  const response = await request.post("/api/v1/rooms", {
    headers: await currentHeaders(request),
    data: { name, ...(propertyId ? { property_id: propertyId } : {}) },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    id: string;
    name: string;
    property: { id: string; name: string };
  };
}

async function readProperties(request: APIRequestContext) {
  const response = await request.get("/api/v1/properties");
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    items: Array<{ id: string; name: string }>;
  };
}

async function createItem(
  request: APIRequestContext,
  name: string,
  roomId: string,
  quantity = 1,
) {
  const response = await request.post("/api/v1/items", {
    headers: await currentHeaders(request),
    data: { name, room_id: roomId, quantity },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

async function createLoan(
  request: APIRequestContext,
  itemId: string,
  borrower: string,
  quantity = 1,
) {
  const response = await request.post("/api/v1/loans", {
    headers: await currentHeaders(request),
    data: {
      item_id: itemId,
      borrower_name: borrower,
      quantity,
      lent_on: "2026-01-01",
      request_id: crypto.randomUUID(),
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function createSecondHousehold(
  page: import("@playwright/test").Page,
  name: string,
  propertyName: string,
) {
  await page.goto("/settings/household");
  await page.getByRole("button", { name: "Switch household" }).first().click();
  await page.getByText("Create household", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a household" });
  await dialog.getByLabel("Household name").fill(name);
  await dialog.getByLabel("First property").fill(propertyName);
  await dialog.getByRole("button", { name: "Create household" }).click();
  await expect(page.getByText("Household created")).toBeVisible();
  // A new household opens in its item list.
  await expect(page).toHaveURL(/\/items$/);
}

async function clearConfiguredProviders(request: APIRequestContext) {
  const settings = await request.get("/api/v1/ai/settings", {
    headers: await currentHeaders(request),
  });
  expect(settings.ok()).toBeTruthy();
  const body = (await settings.json()) as { providers: Array<{ id: string }> };
  for (const provider of body.providers) {
    const deleted = await request.delete(`/api/v1/ai/providers/${provider.id}`, {
      headers: await currentHeaders(request),
    });
    expect(deleted.status()).toBe(204);
  }
}

async function switchHousehold(
  page: import("@playwright/test").Page,
  name: string,
) {
  await page.getByRole("button", { name: "Switch household" }).first().click();
  await page.getByRole("menuitem", { name: new RegExp(name) }).click();
  await expect(page.getByText(`Switched to ${name}`)).toBeVisible();
}

test("creates, switches and searches authorised all-my-places; opens a result in its household", async ({
  page,
  request,
}) => {
  await fs.mkdir("../../docs/walkthrough/households", { recursive: true });
  await clearConfiguredProviders(request);
  await page.addInitScript(() => {
    window.localStorage.removeItem("housetory-property-filter");
    window.localStorage.removeItem("housetory-search-scope");
    window.localStorage.setItem("housetory-theme", "light");
  });

  const id = suffix();
  const firstSession = await readSession(request);
  expect(firstSession.household).toBeTruthy();
  const firstHousehold = firstSession.household!;
  const secondName = `Cabin ${id}`;
  const secondProperty = `Cabin property ${id}`;
  await createSecondHousehold(page, secondName, secondProperty);
  const afterCreate = await readSession(request);
  expect(afterCreate.household?.name).toBe(secondName);
  const secondHousehold = afterCreate.household!;

  const secondRoomName = `Workshop ${id}`;
  const secondProperties = await readProperties(request);
  const secondRoom = await createRoom(
    request,
    secondRoomName,
    secondProperties.items[0]!.id,
  );
  const secondItem = await createItem(
    request,
    `Cordless drill ${id}`,
    secondRoom.id,
    1,
  );
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 }),
  ).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: "../../docs/walkthrough/households/01-switcher-desktop-light.png",
    fullPage: false,
  });

  // Switch back through the compact selector and create the same room name in
  // the original household.
  await switchHousehold(page, firstHousehold.name);
  const firstProperties = await readProperties(request);
  const firstProperty =
    firstProperties.items.find((entry) => entry.name === "Home") ??
    firstProperties.items[0]!;
  const firstRoom = await createRoom(request, secondRoomName, firstProperty.id);
  const firstItem = await createItem(
    request,
    `Cordless drill ${id}`,
    firstRoom.id,
    2,
  );
  const loan = await createItem(request, `Tile cutter ${id}`, firstRoom.id, 3);
  await createLoan(request, loan.item.id, "Morgan", 2);

  // The search across every household is in the assistant now. The separate Search
  // page is gone. The assistant starts with "All my places".
  await page.setViewportSize({ width: 1440, height: 1100 });
  const assistant = page.getByTestId("assistant-panel");
  const scope = assistant.getByLabel("Search scope");
  // Each match is a row link. (The same item is linked once more under Sources.)
  const firstResult = assistant.locator(`a[href^="/items/${firstItem.item.id}"]`).first();
  const secondResult = assistant.locator(`a[href^="/items/${secondItem.item.id}"]`).first();
  const asked: Array<Record<string, unknown>> = [];
  page.on("request", (sent) => {
    if (sent.method() === "POST" && new URL(sent.url()).pathname === "/api/v1/search/query") {
      asked.push(sent.postDataJSON() as Record<string, unknown>);
    }
  });
  const ask = async (question: string) => {
    const answers = await assistant.getByRole("button", { name: "Copy answer" }).count();
    await assistant.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill(question);
    await assistant.getByRole("button", { name: "Send question", exact: true }).click();
    await expect(assistant.getByRole("button", { name: "Copy answer" })).toHaveCount(answers + 1);
  };
  await page.goto(`/assistant?q=${encodeURIComponent(`Cordless drill ${id}`)}`);
  await expect(page).toHaveURL(/\/items#assistant$/);
  await expect(scope).toHaveValue("all");
  await expect(firstResult).toBeVisible();
  await expect(secondResult).toBeVisible();
  // Two items with the same name: each row says which household has it.
  await expect(firstResult).toContainText(firstHousehold.name);
  await expect(secondResult).toContainText(secondName);
  await expect(firstResult).toContainText(`${firstProperty.name} / ${secondRoomName}`);
  await expect(secondResult).toContainText(`${secondProperty} / ${secondRoomName}`);
  await page.screenshot({
    path: "../../docs/walkthrough/households/02-all-my-places-search-light.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(secondResult).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "../../docs/walkthrough/households/03-all-my-places-mobile-light.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  // A narrower scope is sent to the server and only that household is searched.
  await scope.selectOption({
    label: `${firstHousehold.name} · ${firstProperty.name}`,
  });
  await expect(scope).toHaveValue(/^household:/);
  await ask(`Cordless drill ${id}`);
  expect(asked.at(-1)).toMatchObject({
    household_id: firstHousehold.id,
    property_id: firstProperty.id,
  });
  await expect(firstResult).toBeVisible();
  await expect(assistant.locator(`a[href^="/items/${secondItem.item.id}"]`)).toHaveCount(0);
  await scope.selectOption("all");
  await ask(`Cordless drill ${id}`);
  expect(asked.at(-1)).not.toHaveProperty("household_id");
  await expect(secondResult).toBeVisible();

  // A cross-household result link opens the matching item in its own household.
  await secondResult.click();
  await expect(page).toHaveURL(new RegExp(`/items/${secondItem.item.id}$`));
  await expect(
    page.getByRole("heading", { name: `Cordless drill ${id}` }),
  ).toBeVisible();
  await expect(page.getByText(secondName).first()).toBeVisible();
  await expect(page.getByText(secondRoomName).first()).toBeVisible();
  const afterLink = await readSession(request);
  expect(afterLink.household?.id).toBe(secondHousehold.id);

  // Switching clears a property filter from the previous workspace.
  await page.evaluate(() => {
    window.localStorage.setItem("housetory-property-filter", "stale-property");
  });
  await switchHousehold(page, firstHousehold.name);
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("housetory-property-filter"),
    ),
  ).toBeNull();

  // The assistant defaults to All my places and keeps borrower + household path.
  await page.goto(
    `/assistant?q=${encodeURIComponent(`Where is my Tile cutter ${id}?`)}`,
  );
  await expect(assistant.getByLabel("Search scope")).toHaveValue("all");
  await expect(assistant.getByText(/Morgan has 2 of your 3 units/)).toBeVisible();
  await expect(
    assistant.getByText(
      new RegExp(
        `${firstHousehold.name} / ${firstProperty.name} → ${firstRoom.name}`,
      ),
    ),
  ).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/households/04-assistant-all-my-places-light.png",
    fullPage: false,
  });

  // Dark is chosen on the Appearance screen. The header button for it is gone.
  // The Household screen is then reached without a reload, so the choice stays.
  await page.goto("/settings/appearance");
  await page.getByRole("radiogroup", { name: "Light or dark" }).getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("main").getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("main").getByRole("link", { name: /^Household/ }).click();
  await expect(page).toHaveURL(/\/settings\/household$/);
  await expect(
    page.getByRole("heading", { name: "Household", level: 1 }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  // On desktop the household switcher is in the sidebar, and it is on this screen too.
  await expect(page.locator("aside").getByRole("button", { name: "Switch household" })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "../../docs/walkthrough/households/05-household-settings-dark.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Household", level: 1 }),
  ).toBeVisible();
  // On a phone there is no sidebar: the switcher is on this screen.
  await expect(page.getByRole("main").getByRole("button", { name: "Switch household" })).toBeVisible();
  await page.waitForTimeout(250);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../../docs/walkthrough/households/06-household-settings-mobile-dark.png",
    fullPage: false,
  });
  expect(afterCreate.households.length).toBeGreaterThanOrEqual(2);
});
