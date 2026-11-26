import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const MORE = ["Places", "Documents", "Purchases", "Insurance", "Stocktake", "Review", "Settings"];

async function createItem(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/items", { data: { name } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

test("desktop sidebar lists the rooms, On loan and More, and More rolls up the rest", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page).toHaveURL(/\/items$/);
  const nav = page.locator("aside").getByRole("navigation", { name: "Rooms" });
  await expect(nav.getByRole("link", { name: "All items" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: /^On loan/ })).toBeVisible();

  const more = nav.getByRole("button", { name: "More", exact: true });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(nav.getByTestId("rail-more").getByRole("link")).toHaveText(MORE);
  await nav.getByTestId("rail-more").getByRole("link", { name: "Places" }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await page.getByRole("navigation", { name: "Places" }).getByRole("link", { name: "Containers" }).click();
  await expect(page).toHaveURL(/\/containers$/);
  // The choices stay up on one of their pages, with the current one marked.
  await expect(nav.getByTestId("rail-more").getByRole("link", { name: "Places" }))
    .toHaveAttribute("aria-current", "page");
  await nav.getByRole("button", { name: "Close", exact: true }).click();
  await expect(nav.getByTestId("rail-more")).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "More", exact: true })).toHaveClass(/nav-link-active/);
});

test("phone has one bottom bar and a room rail that hides and stays hidden", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/items");
  const bar = page.getByTestId("bottom-bar");
  await expect(bar.getByRole("combobox", { name: "Search or ask about your inventory" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Add items" })).toBeVisible();
  await expect(bar.locator('button[title="Open assistant"]')).toBeVisible();

  const rail = page.getByTestId("room-rail");
  await expect(rail.getByRole("link", { name: "All", exact: true })).toHaveAttribute("aria-current", "page");
  await rail.getByRole("button", { name: "More", exact: true }).click();
  await expect(rail.getByTestId("rail-more").getByRole("link")).toHaveCount(MORE.length);
  await rail.getByRole("button", { name: "Close", exact: true }).click();
  await expect(rail.getByTestId("rail-more")).toHaveCount(0);

  // The show and hide button keeps its place in the bar.
  const hide = bar.getByRole("button", { name: "Hide rooms" });
  const before = await hide.boundingBox();
  await hide.click();
  await expect(rail).toHaveCount(0);
  const show = bar.getByRole("button", { name: "Show rooms" });
  expect(await show.boundingBox()).toEqual(before);
  await page.reload();
  await expect(page.getByTestId("bottom-bar")).toBeVisible();
  await expect(page.getByTestId("room-rail")).toHaveCount(0);

  // With the rooms hidden, the page title brings them back.
  await page.getByRole("heading", { level: 1 }).getByRole("button").click();
  await expect(page.getByTestId("room-rail")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test("phone Add items sheet closes from every part of its Close button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/items");
  await page.getByTestId("bottom-bar").getByRole("button", { name: "Add items" }).click();
  const dialog = page.getByRole("dialog", { name: "Add items" });
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole("button", { name: "Close" });
  // The sticky sheet header used to lie over the lower part of the button.
  const covered = await close.evaluate((button) => {
    const box = button.getBoundingClientRect();
    return [[0.2, 0.2], [0.8, 0.2], [0.5, 0.5], [0.2, 0.8], [0.8, 0.8]].filter(([x, y]) => {
      const hit = document.elementFromPoint(box.left + box.width * x!, box.top + box.height * y!);
      return !(hit && (hit === button || button.contains(hit)));
    }).length;
  });
  expect(covered).toBe(0);
  const box = (await close.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
  await expect(dialog).toBeHidden();
});

test("an item page puts a removable This item context in the bar", async ({ page, request }) => {
  const { item } = await createItem(request, `Context chip ${Date.now()}`);
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/items/${item.id}`);
    const chip = page.getByTestId("quick-search-context");
    await expect(chip).toHaveText("This item");
    await chip.getByRole("button", { name: `Remove this item from the question: ${item.name}` }).click();
    await expect(chip).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Search or ask about your inventory" })).toBeFocused();
  }
});

test("a wide screen opens an item in a panel beside the list it came from", async ({ page, request }) => {
  const first = await createItem(request, `Panel one ${Date.now()}`);
  const second = await createItem(request, `Panel two ${Date.now()}`);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/items");
  const list = page.locator("main");
  await list.getByRole("link", { name: new RegExp(first.item.name) }).first().click();
  const panel = page.getByTestId("item-panel");
  await expect(panel.getByRole("heading", { level: 1 })).toHaveText(first.item.name);
  await expect(page).toHaveURL(new RegExp(`/items/${first.item.id}`));
  // The list is still there, and another item replaces the one in the panel.
  await list.getByRole("link", { name: new RegExp(second.item.name) }).first().click();
  await expect(panel.getByRole("heading", { level: 1 })).toHaveText(second.item.name);
  await panel.getByRole("link", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(/\/items(\?|$)/);

  // On a narrower screen the same item is a full page.
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto(`/items/${first.item.id}`);
  await expect(page.getByTestId("item-panel")).toHaveCount(0);
  await expect(page.locator("main").getByRole("heading", { level: 1 })).toHaveText(first.item.name);
});

const SCROLLED = 300;

/** Opens a long page and scrolls it down. */
async function openScrolledPage(page: Page, mobile: boolean) {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  await page.goto("/settings/ai");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan(600);
  await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), SCROLLED);
}

/** Where the page ends up. A move caused by focus is a slide that starts a moment later. */
async function settledScroll(page: Page) {
  await page.waitForTimeout(500);
  const read = () => page.evaluate(() => window.scrollY);
  let now = await read();
  await expect.poll(async () => {
    const last = now;
    now = await read();
    return now === last;
  }).toBe(true);
  return now;
}

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"} closing the assistant leaves a scrolled page where it was`, async ({ page }) => {
    await openScrolledPage(page, mobile);
    const trigger = page.locator('button[title="Open assistant"]').first();
    // Pressed at its place on the screen, as a pointer does. The test tool's own click
    // would first scroll the page for this button, which is the move being checked.
    const box = (await trigger.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
    await page.getByRole("button", { name: "Close assistant", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeHidden();

    // Focus goes back to the button in the bar, and the page stays put.
    await expect(trigger).toBeFocused();
    expect(await settledScroll(page)).toBe(SCROLLED);
  });

  test(`${mobile ? "mobile" : "desktop"} focus on the always-visible controls leaves a scrolled page where it was`, async ({ page }) => {
    await openScrolledPage(page, mobile);
    const bar = page.getByTestId("bottom-bar");

    // The search shortcut puts focus in the bar.
    await page.keyboard.press("Control+k");
    await expect(bar.getByRole("combobox", { name: "Search or ask about your inventory" }))
      .toBeFocused();
    expect(await settledScroll(page)).toBe(SCROLLED);

    // The Tab key moves through the bar's other controls.
    await page.keyboard.press("Tab");
    await expect(bar.locator(":focus")).toHaveCount(1);
    expect(await settledScroll(page)).toBe(SCROLLED);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(bar.locator('button[title="Open assistant"]')).toBeFocused();
    expect(await settledScroll(page)).toBe(SCROLLED);

    if (mobile) return;
    // The sidebar is always on screen too. Its first control is at the top edge of
    // the screen and its last one at the bottom edge.
    const controls = page.locator("aside").locator("a[href], button");
    for (const control of [controls.first(), controls.last()]) {
      await control.focus();
      await expect(control).toBeFocused();
      expect(await settledScroll(page)).toBe(SCROLLED);
    }
  });
}

test("retired destinations redirect instead of breaking old links", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/search?q=ladder");
  await expect(page).toHaveURL(/\/items\?q=ladder$/);
  await page.goto("/assistant");
  await expect(page).toHaveURL(/\/items#assistant$/);
  await expect(page.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
  await page.getByRole("button", { name: "Close assistant", exact: true }).click();
  for (const path of ["/scan", "/recognize", "/add-items"]) {
    await page.goto(path);
    await expect(page.getByRole("dialog", { name: "Add items" })).toBeVisible();
    await page.keyboard.press("Escape");
  }
});
