import { expect, test } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:8091";

test("core pages load without external browser resources", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (
      url.startsWith("data:") ||
      url.startsWith("blob:") ||
      url.startsWith(baseURL)
    ) {
      return;
    }
    external.push(url);
  });

  for (const path of [
    "/",
    "/items",
    "/rooms",
    "/search?q=drill",
    "/loans",
    "/documents",
    "/settings",
  ]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
  }
  expect(external, `external requests: ${external.join(", ")}`).toEqual([]);
  await page.screenshot({
    path: "../../docs/walkthrough/release-stabilisation/05-offline-settings-light.png",
    fullPage: false,
  });
});
