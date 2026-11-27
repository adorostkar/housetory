import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * A phone held sideways with the keyboard open leaves a strip of some 70 px.
 * There Save, Close and the search results stand beside the field that is
 * typed in.
 *
 * This file has no real keyboard. It makes the browser report a short visual
 * viewport, which is what a phone does, and checks where the app then puts
 * things. Real keyboards are checked on the iOS Simulator and the Android
 * emulator; see docs/MOBILE_FIRST_PROGRAMME.md.
 */
const SCREEN = { width: 874, height: 402 };
const STRIP = 74;

test.use({ viewport: SCREEN, hasTouch: true });

async function seedItem(request: APIRequestContext, name: string) {
  const session = (await (await request.get("/api/v1/auth/session")).json()) as {
    household?: { id: string } | null;
    households?: Array<{ id: string }>;
  };
  const householdId = session.household?.id ?? session.households?.[0]?.id;
  const response = await request.post("/api/v1/items", {
    headers: householdId ? { "X-Household-Id": householdId } : {},
    data: { name, quantity: 1 },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { item: { id: string } }).item.id;
}

/** The keyboard opens: the visible part becomes a strip at the top of the window. */
async function openKeyboard(page: Page) {
  await page.evaluate((height) => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, "height", { configurable: true, get: () => height });
    Object.defineProperty(viewport, "offsetTop", { configurable: true, get: () => 0 });
    viewport.dispatchEvent(new Event("resize"));
  }, STRIP);
  await expect(page.locator("html[data-keyboard-side]")).toHaveCount(1);
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found, "the element is on the page").not.toBeNull();
  return found!;
}

/**
 * The whole element is in the strip, and a tap in its middle reaches it. The page
 * takes a moment to settle after the keyboard opens, so this is tried for a while.
 */
async function expectReachable(locator: Locator) {
  let area = await box(locator);
  await expect(async () => {
    area = await reachableNow(locator);
  }).toPass({ timeout: 10_000 });
  return area;
}

async function reachableNow(locator: Locator) {
  const area = await box(locator);
  expect(area.y, "starts inside the strip").toBeGreaterThanOrEqual(-1);
  expect(area.y + area.height, "ends inside the strip").toBeLessThanOrEqual(STRIP + 1);
  expect(area.x + area.width, "ends inside the screen").toBeLessThanOrEqual(SCREEN.width + 1);
  const reached = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !!at && (at === element || element.contains(at));
  });
  expect(reached, "a tap in the middle reaches it").toBe(true);
  return area;
}

test("a phone held sideways: search results stand beside the field and open the item", async ({ page, request }) => {
  const name = `Sideways kettle ${randomUUID().slice(0, 8)}`;
  const itemId = await seedItem(request, name);
  await page.goto("/items");
  const field = page.getByLabel("Search or ask about your inventory");
  await field.click();
  await openKeyboard(page);
  await field.fill(name);

  // The first row is the item; the last row offers to ask the assistant about the same words.
  const result = page.locator("#quick-search-panel [role=option]").filter({ hasText: name }).first();
  await expect(result).toBeVisible();
  const fieldBox = await expectReachable(field);
  const resultBox = await expectReachable(result);
  expect(resultBox.x, "the result is beside the field, not on it").toBeGreaterThanOrEqual(fieldBox.x + fieldBox.width);
  expect(resultBox.height).toBeGreaterThanOrEqual(44);

  await result.click();
  await expect(page).toHaveURL(new RegExp(`/items/${itemId}$`));
});

test("a phone held sideways: the assistant keeps Close beside the message field", async ({ page }) => {
  await page.goto("/items");
  await page.getByTitle("Open assistant").click();
  const composer = page.getByLabel("Ask the Housetory assistant");
  await composer.click();
  await openKeyboard(page);
  await composer.fill("How many torches");

  const close = page.getByRole("button", { name: "Close assistant" });
  const composerBox = await expectReachable(composer);
  const closeBox = await expectReachable(close);
  expect(closeBox.x + closeBox.width, "Close is beside the field").toBeLessThanOrEqual(composerBox.x + 1);
  await expectReachable(page.getByRole("button", { name: "Send question" }));

  await close.click();
  await expect(page.getByTestId("assistant-panel")).toHaveCount(0);
});

test("a phone held sideways: Add items keeps the main button and Close beside the text box", async ({ page }) => {
  await page.goto("/items");
  await page.getByTestId("bottom-bar").getByRole("button", { name: "Add items" }).click();
  const dialog = page.getByRole("dialog");
  const text = dialog.locator("textarea");
  await text.click();
  await openKeyboard(page);
  await text.fill("2 torches");

  const textBox = await expectReachable(text);
  const reviewBox = await expectReachable(dialog.getByRole("button", { name: "Review items" }));
  const closeBox = await expectReachable(dialog.getByRole("button", { name: "Close" }));
  expect(reviewBox.x, "the main button is beside the text box").toBeGreaterThanOrEqual(textBox.x + textBox.width);
  expect(closeBox.x, "Close is beside the main button").toBeGreaterThanOrEqual(reviewBox.x + reviewBox.width - 1);

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
});

test("a phone held sideways: Save stands beside the field and saves with the keyboard open", async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const itemId = await seedItem(request, `Sideways form ${suffix}`);
  await page.goto(`/items/${itemId}/edit`);
  const name = page.locator("#item-name");
  await name.click();
  await openKeyboard(page);

  const save = page.getByTestId("item-form-footer").getByRole("button", { name: "Save changes" });
  // The page brings the field into the strip a moment after the keyboard opens.
  await expect(async () => {
    const nameBox = await expectReachable(name);
    const saveBox = await expectReachable(save);
    expect(saveBox.x, "Save is beside the field, not on it").toBeGreaterThanOrEqual(nameBox.x + nameBox.width);
  }).toPass();

  await name.fill(`Sideways form ${suffix} saved`);
  // A tap on Save must not take the focus first: the keyboard would close and Save would move away.
  await save.dispatchEvent("mousedown");
  await expect(name).toBeFocused();
  await save.click();
  await expect(page).toHaveURL(new RegExp(`/items/${itemId}$`));
  await expect(page.getByRole("heading", { name: `Sideways form ${suffix} saved` })).toBeVisible();
});
