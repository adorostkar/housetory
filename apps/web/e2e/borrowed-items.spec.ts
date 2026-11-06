import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type APIRequestContext } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const photoPath = path.resolve(here, "../public/icons/icon-192.png");

function suffix() {
  return Date.now().toString().slice(-5);
}

async function property(client: APIRequestContext) {
  const response = await client.get("/api/v1/properties");
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    items: Array<{ id: string; name: string }>;
  };
  return body.items[0]!;
}

async function createRoom(
  client: APIRequestContext,
  name: string,
  propertyId: string,
) {
  const response = await client.post("/api/v1/rooms", {
    data: { name, property_id: propertyId },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
}

async function createContainer(
  client: APIRequestContext,
  roomId: string,
  name: string,
) {
  const response = await client.post("/api/v1/containers", {
    data: { room_id: roomId, container_type: "box", name },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    id: string;
    name: string;
    identifier: string;
  };
}

async function createItem(
  client: APIRequestContext,
  name: string,
  roomId: string,
  locationId: string,
) {
  const response = await client.post("/api/v1/items", {
    data: {
      name,
      room_id: roomId,
      storage_location_id: locationId,
      quantity: 2,
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

async function createLoan(client: APIRequestContext, itemId: string) {
  const response = await client.post("/api/v1/loans", {
    data: {
      item_id: itemId,
      borrower_name: "Sam",
      quantity: 1,
      lent_on: "2026-10-01",
      due_on: "2026-11-25",
      request_id: crypto.randomUUID(),
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function createBorrowed(
  client: APIRequestContext,
  payload: Record<string, unknown> = {},
) {
  const response = await client.post("/api/v1/borrowed", {
    data: {
      item_name: "Borrowed fixture",
      owner_name: "Ali",
      quantity: 1,
      borrowed_on: "2026-10-01",
      request_id: crypto.randomUUID(),
      ...payload,
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; item_name: string };
}

function createViewer(email: string) {
  const owner = (process.env.E2E_EMAIL ?? "e2e-owner@example.com").replaceAll(
    "'",
    "''",
  );
  const viewer = email.replaceAll("'", "''");
  const sql = `
    INSERT INTO users (id, name, email, password_hash)
    SELECT gen_random_uuid(), 'Borrowed Viewer', '${viewer}', password_hash
    FROM users WHERE email = '${owner}';
    INSERT INTO household_members (household_id, user_id, role)
    SELECT (SELECT id FROM households ORDER BY created_at LIMIT 1), id, 'viewer'
    FROM users WHERE email = '${viewer}';
  `;
  execFileSync(
    "docker",
    [
      "exec",
      process.env.E2E_DB_CONTAINER ?? "housetory-e2e-db-1",
      "psql",
      "-U",
      "housetory",
      "-d",
      "housetory",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { stdio: "pipe" },
  );
}

test("creates a borrowed record, partially returns it, persists across refresh, uploads a private photo and returns the rest", async ({
  page,
  request,
}) => {
  const id = suffix();
  const home = await property(request);
  const room = await createRoom(request, `Borrowed room ${id}`, home.id);
  const container = await createContainer(
    request,
    room.id,
    `Borrowed crate ${id}`,
  );
  const owned = await createItem(
    request,
    `Owned projector ${id}`,
    room.id,
    container.id,
  );
  await createLoan(request, owned.item.id);
  const itemName = `Borrowed tile cutter ${id}`;
  const owner = `Ali ${id}`;

  await page.setViewportSize({ width: 1440, height: 1000 });
  const ownedRow = page
    .locator('[data-testid="loan-row"]')
    .filter({ hasText: owned.item.name });
  await page.goto("/loans");
  await expect(ownedRow.first()).toBeVisible();

  await page.getByRole("button", { name: "New loan" }).click();
  await expect(page.getByRole("heading", { name: "New loan" })).toBeVisible();
  await page.getByRole("button", { name: /Borrow from someone/ }).click();
  await expect(
    page.getByRole("heading", { name: "Borrow from someone" }),
  ).toBeVisible();
  await page.getByLabel("Item name").fill(itemName);
  await page.getByLabel("Owner display name").fill(owner);
  await page.getByLabel("Quantity").fill("3");
  await page.getByLabel("Borrowed on").fill("2026-10-01");
  await page.getByLabel("Due back").fill("2026-11-20");
  await page.getByLabel("Keeping property").selectOption({ label: home.name });
  await page.getByLabel("Keeping room").selectOption({ label: room.name });
  await page
    .getByLabel("Container or place")
    .selectOption({ label: `${container.identifier} · ${container.name}` });
  await page
    .getByLabel("Private notes")
    .fill("Ali's spare cutter; return with the case.");
  await page.getByRole("button", { name: "Record borrowed item" }).click();

  const borrowedRow = page
    .locator('[data-testid="borrowed-row"]')
    .filter({ hasText: owner });
  await expect(borrowedRow).toBeVisible();
  await expect(borrowedRow.getByText("Borrowed", { exact: true })).toBeVisible();
  await expect(borrowedRow).toContainText(itemName);
  await expect(borrowedRow).toContainText("of 3 held");
  await expect(ownedRow.first()).toBeVisible();

  // Protected direction badges and filters.
  const directionTabs = page.getByRole("tablist", { name: "Loan direction" });
  const statusTabs = page.getByRole("tablist", { name: "Loan filters" });
  await directionTabs.getByRole("tab", { name: "Borrowed" }).click();
  await expect(borrowedRow).toBeVisible();
  await expect(page.locator('[data-testid="loan-row"]')).toHaveCount(0);
  await directionTabs.getByRole("tab", { name: "Lent out" }).click();
  await expect(borrowedRow).toHaveCount(0);
  await expect(ownedRow.first()).toBeVisible();
  const borrowedTab = directionTabs.getByRole("tab", { name: "Borrowed" });
  await borrowedTab.focus();
  await page.keyboard.press("Enter");
  await expect(borrowedTab).toHaveAttribute("aria-selected", "true");
  await directionTabs.getByRole("tab", { name: "All" }).click();
  await expect(borrowedRow).toBeVisible();

  // Partial return from the mixed row.
  await borrowedRow.getByRole("button", { name: "Return to owner" }).click();
  const returnDialog = page.getByRole("dialog");
  await expect(
    returnDialog.getByRole("heading", { name: `Return to ${owner}` }),
  ).toBeVisible();
  await expect(returnDialog.getByLabel("Quantity")).toHaveValue("3");
  await returnDialog.getByLabel("Quantity").fill("1");
  await returnDialog.getByRole("button", { name: "Return to owner" }).click();
  await expect(borrowedRow).toContainText("1 returned to owner");
  await expect(borrowedRow).toContainText("of 3 held");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
    timeout: 10_000,
  });

  await page.screenshot({
    path: "../../docs/walkthrough/borrowed-items/after/01-mixed-loans-desktop-light.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "Switch to dark mode" }).first().click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "../../docs/walkthrough/borrowed-items/after/02-mixed-loans-desktop-dark.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "Switch to light mode" }).first().click();

  // Refresh persists the partial return.
  await page.reload();
  await expect(
    page.locator('[data-testid="borrowed-row"]').filter({ hasText: owner }),
  ).toContainText("1 returned to owner");

  await page
    .locator('[data-testid="borrowed-row"]')
    .filter({ hasText: owner })
    .getByRole("link", { name: "View details" })
    .click();
  await expect(
    page.getByRole("heading", { name: itemName, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(`Belongs to ${owner}`, { exact: false })).toBeVisible();
  await expect(page.getByText("Ali's spare cutter; return with the case.")).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/borrowed-items/after/03-borrowed-detail-desktop-light.png",
    fullPage: false,
  });

  // Private actual photo.
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose photo" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(photoPath);
  const photoDialog = page.getByRole("dialog");
  await expect(
    photoDialog.getByRole("heading", { name: "Add borrowed-item photo" }),
  ).toBeVisible();
  await photoDialog.getByRole("button", { name: "Upload photograph" }).click();
  await expect(
    page.getByRole("img", { name: `${itemName} borrowed from ${owner}` }),
  ).toBeVisible();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
    timeout: 10_000,
  });

  await page.getByRole("button", { name: "Switch to dark mode" }).first().click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "../../docs/walkthrough/borrowed-items/after/04-borrowed-detail-desktop-dark.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "Switch to light mode" }).first().click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/loans");
  await expect(
    page.locator('[data-testid="borrowed-row"]').filter({ hasText: owner }),
  ).toBeVisible();
  await page
    .locator('[data-testid="borrowed-row"]')
    .filter({ hasText: owner })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "../../docs/walkthrough/borrowed-items/after/05-mixed-loans-mobile-light.png",
    fullPage: false,
  });
  await page
    .locator('[data-testid="borrowed-row"]')
    .filter({ hasText: owner })
    .getByRole("link", { name: "View details" })
    .click();
  await expect(
    page.getByRole("heading", { name: itemName, level: 1 }),
  ).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/borrowed-items/after/06-borrowed-detail-mobile-light.png",
    fullPage: false,
  });

  // Return the remaining units.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Return to owner" }).first().click();
  const finalDialog = page.getByRole("dialog");
  await expect(finalDialog.getByLabel("Quantity")).toHaveValue("2");
  await finalDialog.getByRole("button", { name: "Return to owner" }).click();
  await expect(
    page.getByRole("heading", { name: `0 of 3 held from ${owner}` }),
  ).toBeVisible();
  await expect(page.getByText("Previously kept at", { exact: true })).toBeVisible();
  await expect(page.getByText("Kept at", { exact: true })).toHaveCount(0);

  await page.goto("/loans");
  await page
    .getByRole("tablist", { name: "Loan direction" })
    .getByRole("tab", { name: "Borrowed" })
    .click();
  await page
    .getByRole("tablist", { name: "Loan filters" })
    .getByRole("tab", { name: "Returned" })
    .click();
  const returnedRow = page
    .locator('[data-testid="borrowed-row"]')
    .filter({ hasText: owner });
  await expect(returnedRow).toBeVisible();
  await expect(returnedRow).toContainText("3 returned to owner");
  await expect(returnedRow).toContainText("previously kept at");
});

test("viewers can read borrowed records but cannot mutate them", async ({
  page,
  request,
}) => {
  const id = suffix();
  const home = await property(request);
  const room = await createRoom(request, `Viewer borrowed room ${id}`, home.id);
  const record = await createBorrowed(request, {
    item_name: `Viewer borrowed heater ${id}`,
    owner_name: `Mina ${id}`,
    room_id: room.id,
  });
  const viewerEmail = `borrowed-viewer-${id}@example.com`;
  createViewer(viewerEmail);

  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(viewerEmail);
  await page
    .locator("#password")
    .fill(process.env.E2E_PASSWORD ?? "borrowed-e2e-password-2026");
  const loginResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/auth/login") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  expect((await loginResponse).ok()).toBeTruthy();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/loans");
  await expect(page.getByRole("heading", { name: "Loans" })).toBeVisible();

  const row = page
    .locator('[data-testid="borrowed-row"]')
    .filter({ hasText: record.item_name });
  await expect(row).toBeVisible();
  await expect(page.getByRole("button", { name: "New loan" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Return to owner" })).toHaveCount(0);

  await row.getByRole("link", { name: "View details" }).click();
  await expect(
    page.getByRole("heading", { name: record.item_name, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Return to owner" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Correct" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose photo" })).toHaveCount(0);
  await expect(page.getByText(/Viewers can read the record but cannot add/)).toBeVisible();
});
