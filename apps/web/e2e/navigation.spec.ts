import { expect, test, type Page } from "@playwright/test";

test("desktop sidebar lists each destination once", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/items");
  const nav = page.locator("aside nav a");
  await expect(nav).toHaveText([
    "Overview", "Items", "Places", "Loans", "Documents", "Financials", "Review",
  ]);
  await page.locator("aside").getByRole("link", { name: "Places", exact: true }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await page.getByRole("navigation", { name: "Places" }).getByRole("link", { name: "Containers" }).click();
  await expect(page).toHaveURL(/\/containers$/);
  await expect(page.locator("aside").getByRole("link", { name: "Places", exact: true }))
    .toHaveClass(/nav-link-active/);
});

test("mobile bar has five slots and More reaches everything else", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/items");
  const bottom = page.getByTestId("mobile-bottom-nav");
  await expect(bottom.locator("a")).toHaveText(["Home", "Items", "Loans"]);
  await expect(bottom.getByRole("button", { name: "Add items" })).toBeVisible();
  await bottom.getByRole("button", { name: "More destinations" }).click();
  await expect(page.getByTestId("mobile-more-menu").getByRole("menuitem"))
    .toHaveText(["Places", "Documents", "Financials", "Review", "Settings"]);
});

const SCROLLED = 300;

/** Opens a long page and scrolls it down. */
async function openScrolledPage(page: Page, mobile: boolean) {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  await page.goto("/settings");
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

    // Focus goes back to the button in the header, and the page stays put.
    await expect(trigger).toBeFocused();
    expect(await settledScroll(page)).toBe(SCROLLED);
  });

  test(`${mobile ? "mobile" : "desktop"} focus on the always-visible controls leaves a scrolled page where it was`, async ({ page }) => {
    await openScrolledPage(page, mobile);
    const header = page.locator("header");

    // The search shortcut puts focus in the header.
    await page.keyboard.press("Control+k");
    await expect(header.getByRole("combobox", { name: "Search or ask about your inventory" }))
      .toBeFocused();
    expect(await settledScroll(page)).toBe(SCROLLED);

    // The Tab key moves through the header's other controls.
    await page.keyboard.press("Tab");
    await expect(header.locator(":focus")).toHaveCount(1);
    expect(await settledScroll(page)).toBe(SCROLLED);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(header.locator('button[title="Open assistant"]')).toBeFocused();
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
  await expect(page).toHaveURL(/#assistant$/);
  await expect(page.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
  await page.getByRole("button", { name: "Close assistant", exact: true }).click();
  for (const path of ["/scan", "/recognize", "/add-items"]) {
    await page.goto(path);
    await expect(page.getByRole("dialog", { name: "Add items" })).toBeVisible();
    await page.keyboard.press("Escape");
  }
});
