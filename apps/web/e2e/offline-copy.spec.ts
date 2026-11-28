import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/*
 * The offline copy: off until turned on, read-only without the server, and back
 * to normal when the server answers again.
 *
 * It needs the production build (the service worker opens the app without the
 * server). Against the development server these tests are skipped.
 */

const stamp = Date.now().toString(36);
const ROOM = `Offline cellar ${stamp}`;
const DRILL = `Offline drill ${stamp}`;
const LAMP = `Offline lamp ${stamp}`;

async function householdHeaders(request: APIRequestContext) {
  const session = await (await request.get("/api/v1/auth/session")).json();
  return { "X-Household-Id": session.household.id as string };
}

async function seed(request: APIRequestContext) {
  const headers = await householdHeaders(request);
  const room = await (await request.post("/api/v1/rooms", { data: { name: ROOM }, headers })).json();
  const drill = await (
    await request.post("/api/v1/items", {
      data: { name: DRILL, serial_number: `SN-${stamp}`, room_id: room.id },
      headers,
    })
  ).json();
  await request.post("/api/v1/items", { data: { name: LAMP, room_id: room.id }, headers });
  return { room, drill: drill.item, headers };
}

/** What this browser keeps for the offline copy. */
async function onDevice(page: Page) {
  return page.evaluate(async () => {
    const stored = [];
    for (const name of await caches.keys()) {
      if (name.includes("offline")) stored.push(name);
    }
    const databases = (await indexedDB.databases()).map((database) => database.name);
    return {
      copy: databases.includes("housetory-offline"),
      caches: stored.sort(),
      choice: localStorage.getItem("housetory-offline-copy"),
    };
  });
}

async function needsProductionBuild(page: Page) {
  await page.goto("/items");
  const worker = await page
    .waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!worker, "The offline copy needs the production build and its service worker.");
}

async function turnOn(page: Page) {
  await page.goto("/settings/offline");
  await page.getByRole("switch", { name: "Keep a copy on this device" }).click();
  await expect(page.getByTestId("offline-copy-state")).toContainText(/saved today at/);
  // The app's own files are saved after the data.
  await expect
    .poll(async () => (await onDevice(page)).caches)
    .toEqual(["housetory-offline-app-v1", "housetory-offline-photos-v1"]);
}

async function turnOff(page: Page) {
  await page.goto("/settings/offline");
  const toggle = page.getByRole("switch", { name: "Keep a copy on this device" });
  if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
  await expect.poll(async () => (await onDevice(page)).copy).toBe(false);
}

const banner = (page: Page) => page.getByTestId("offline-banner");

test.describe.configure({ mode: "serial" });

test("is off until turned on, works read-only without a connection, and comes back", async ({
  page,
  context,
}) => {
  await needsProductionBuild(page);
  const { drill, headers } = await seed(page.request);
  await turnOff(page);

  // Off: nothing of the inventory is kept on the device.
  expect(await onDevice(page)).toEqual({ copy: false, caches: [], choice: null });

  await turnOn(page);
  expect((await onDevice(page)).copy).toBe(true);

  await context.setOffline(true);

  // A page that was never opened in this browser works: its code was saved too.
  await page.goto("/rooms");
  await expect(banner(page)).toContainText("Offline. You see your copy");
  await page.locator("main").getByRole("link", { name: new RegExp(ROOM) }).first().click();
  await expect(page.locator("main").getByText(DRILL).first()).toBeVisible();
  await expect(page.locator("main").getByText(LAMP).first()).toBeVisible();

  // Search works in the copy and opens the item.
  const search = page.locator('[data-quick-search-input="true"]:visible').first();
  await search.click();
  await search.fill(DRILL);
  await page.getByRole("option", { name: new RegExp(DRILL) }).first().click();
  await expect(page).toHaveURL(new RegExp(`/items/${drill.id}`));
  await expect(page.getByRole("heading", { name: DRILL }).first()).toBeVisible();
  await expect(page.getByText(`SN-${stamp}`).first()).toBeVisible();

  // Read-only: no way to edit or add, and a form is not offered.
  await expect(page.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add items" }).first()).toBeDisabled();
  await page.goto("/items/new");
  await expect(page.getByTestId("offline-unavailable")).toBeVisible();
  // A page outside the copy says so, instead of failing.
  await page.goto("/documents");
  await expect(page.getByText("This page needs a connection")).toBeVisible();

  // The app opens again from the device after a full reload.
  await page.goto("/items");
  await page.reload();
  await expect(banner(page)).toBeVisible();
  await expect(page.locator("main").getByText(DRILL).first()).toBeVisible();

  // Meanwhile the item is renamed on the server, as another person would.
  const renamed = `${DRILL} renamed`;
  const rename = await context.request.patch(`/api/v1/items/${drill.id}`, {
    data: { name: renamed },
    headers,
  });
  expect(rename.ok()).toBe(true);
  await expect(page.locator("main").getByText(renamed)).toHaveCount(0);

  await context.setOffline(false);
  await expect(banner(page)).toHaveCount(0);
  await expect(page.getByText("Back online").first()).toBeVisible();
  // Fresh data from the server, changes are possible again, and the copy follows.
  await expect(page.locator("main").getByText(renamed).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add items" }).first()).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(
        (name) =>
          new Promise<boolean>((resolve) => {
            const open = indexedDB.open("housetory-offline");
            open.onsuccess = () => {
              const read = open.result.transaction("copy").objectStore("copy").get("current");
              read.onsuccess = () => {
                open.result.close();
                resolve(
                  (read.result.snapshot.items as Array<{ name: string }>).some(
                    (item) => item.name === name,
                  ),
                );
              };
            };
          }),
        renamed,
      ),
    )
    .toBe(true);

  await turnOff(page);
  expect(await onDevice(page)).toEqual({ copy: false, caches: [], choice: null });
});

test("the server goes away while a form is open: the text stays and saves when it is back", async ({
  page,
}) => {
  await needsProductionBuild(page);
  await turnOn(page);
  const added = `Offline kettle ${stamp}`;
  await page.goto("/items/new");
  const name = page.getByLabel("Item name").first();
  await name.fill(added);
  const save = page.getByRole("button", { name: "Add to your home" }).first();

  // The device is online, but every request to the server fails.
  const changesSent: string[] = [];
  await page.route("**/api/**", (route) => {
    if (route.request().method() !== "GET") changesSent.push(route.request().url());
    return route.abort("connectionrefused");
  });
  await save.click();
  await expect(banner(page).first()).toBeVisible();
  await expect(name).toHaveValue(added);

  // Now the app knows. A second try is refused with the reason, and is not sent.
  // (The first try was sent only if no other request found the server gone before it.)
  const sentBefore = changesSent.length;
  expect(sentBefore).toBeLessThanOrEqual(1);
  await save.click();
  await expect(
    page.getByText("You are offline. Changes need a connection to your Housetory server.").first(),
  ).toBeVisible();
  await expect(name).toHaveValue(added);
  expect(changesSent).toHaveLength(sentBefore);

  await page.unroute("**/api/**");
  await banner(page).first().getByRole("button", { name: "Try again" }).click();
  await expect(banner(page)).toHaveCount(0);
  await save.click();
  await expect(page).toHaveURL(/\/items\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { name: added }).first()).toBeVisible();
  await turnOff(page);
});

test("sign-out removes the copy from the device", async ({ browser, baseURL }) => {
  // A session of its own, so the sign-out does not end the one the other files use.
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.E2E_EMAIL ?? "phase5@example.com");
  await page.locator("#password").fill(process.env.E2E_PASSWORD ?? "phase-five-password-2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/items");
  await needsProductionBuild(page);
  await turnOn(page);

  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login");
  await expect
    .poll(async () => {
      const device = await onDevice(page);
      return { copy: device.copy, caches: device.caches };
    })
    .toEqual({ copy: false, caches: [] });
  await context.close();
});
