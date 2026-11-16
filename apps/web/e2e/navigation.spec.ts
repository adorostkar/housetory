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
