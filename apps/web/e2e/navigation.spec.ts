import fs from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

async function shot(page: Page, name: string) {
  await fs.mkdir("../../docs/walkthrough/simplification3", { recursive: true });
  await page.screenshot({
    path: `../../docs/walkthrough/simplification3/${name}.png`,
    fullPage: false,
    animations: "disabled",
  });
}

test("desktop navigation keeps core links calm and secondary routes under More", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/items");
  const aside = page.locator("aside");
  await expect(aside.getByRole("link", { name: "Items" })).toBeVisible();
  await expect(aside.getByRole("link", { name: "Rooms" })).toBeVisible();
  await expect(aside.getByRole("link", { name: "Loans" })).toBeVisible();
  await expect(aside.getByRole("link", { name: "Review" })).not.toBeVisible();
  await shot(page, "03-navigation-desktop-calm");

  const more = aside.locator("summary").filter({ hasText: "More" });
  await expect(more).toBeVisible();
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(aside.getByRole("link", { name: "Review" })).toBeVisible();
  await expect(aside.getByRole("link", { name: "Purchases" })).toBeVisible();
  await expect(aside.getByRole("link", { name: "Warranties" })).toBeVisible();
  await expect(aside.getByRole("link", { name: "Assistant" })).toBeVisible();
  await shot(page, "04-navigation-desktop-more");
  await aside.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(aside.locator("details")).toHaveAttribute("open", "");
});

test("mobile navigation uses five destinations and keeps every secondary route reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/items");
  const bottom = page.getByTestId("mobile-bottom-nav");
  await expect(bottom).toBeVisible();
  const links = bottom.locator("a");
  await expect(links).toHaveCount(4);
  await expect(links.nth(0)).toContainText("Home");
  await expect(links.nth(1)).toContainText("Items");
  await expect(links.nth(2)).toContainText("Rooms");
  await expect(links.nth(3)).toContainText("Loans");
  await expect(bottom.getByRole("button", { name: "More destinations" })).toBeVisible();

  await bottom.getByRole("button", { name: "More destinations" }).click();
  const menu = page.getByTestId("mobile-more-menu");
  await expect(menu).toBeVisible();
  await shot(page, "05-navigation-mobile-more");
  for (const label of [
    "Review",
    "Documents",
    "Purchases",
    "Warranties",
    "Containers",
    "Assistant",
    "Search",
    "Settings",
  ]) {
    await expect(menu.getByRole("menuitem", { name: label })).toBeVisible();
  }
  await menu.getByRole("menuitem", { name: "Assistant" }).click();
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(
    page.getByRole("textbox", { name: "Ask the Housetory assistant" }),
  ).toBeVisible();
});

test("search keeps Assistant secondary without adding a competing nav entry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/search");
  await expect(
    page.getByRole("link", { name: "Assistant", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Assistant", exact: true }).click();
  await expect(page).toHaveURL(/\/assistant$/);
});
