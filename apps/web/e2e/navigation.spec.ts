import { expect, test } from "@playwright/test";

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

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"} closing the assistant leaves a scrolled page where it was`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const position = async () => {
      const read = () => page.evaluate(() => window.scrollY);
      let now = await read();
      // A scroll can be a slide, so this waits until two readings agree.
      await expect.poll(async () => {
        const last = now;
        now = await read();
        return now === last;
      }).toBe(true);
      return now;
    };
    await expect.poll(() => page.evaluate(() =>
      document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan(600);
    await page.evaluate(() => window.scrollTo({ top: 300, behavior: "instant" }));
    expect(await position()).toBe(300);

    const trigger = page.locator('button[title="Open assistant"]').first();
    // Pressed at its place on the screen, as a pointer does. The test tool's own click
    // would first scroll the page for this button, which is the move being checked.
    const box = (await trigger.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
    expect(await position()).toBe(300);
    await page.getByRole("button", { name: "Close assistant", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeHidden();

    // Focus goes back to the button in the header, and the page stays put.
    await expect(trigger).toBeFocused();
    // A move caused by that focus is a slide that starts a moment later.
    await page.waitForTimeout(500);
    expect(await position()).toBe(300);
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
