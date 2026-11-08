import fs from "node:fs/promises";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

function suffix() {
  return `${Date.now().toString().slice(-6)}-${Math.random().toString(36).slice(2, 5)}`;
}

function localIsoDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

async function headers(request: APIRequestContext) {
  const response = await request.get("/api/v1/auth/session");
  const state = (await response.json()) as { household: { id: string } };
  return { "X-Household-Id": state.household.id };
}

async function createRoom(request: APIRequestContext, name: string) {
  const auth = await headers(request);
  const properties = await request.get("/api/v1/properties", { headers: auth });
  const property = ((await properties.json()) as { items: Array<{ id: string }> }).items[0]!;
  const response = await request.post("/api/v1/rooms", {
    headers: auth,
    data: { name, property_id: property.id },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}

async function createItem(
  request: APIRequestContext,
  name: string,
  roomId: string,
  extra: Record<string, unknown> = {},
) {
  const auth = await headers(request);
  const response = await request.post("/api/v1/items", {
    headers: auth,
    data: { name, room_id: roomId, ...extra },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { item: { id: string } }).item.id;
}

async function itemDetail(request: APIRequestContext, itemId: string) {
  const auth = await headers(request);
  const response = await request.get(`/api/v1/items/${itemId}`, { headers: auth });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    item: {
      id: string;
      name: string;
      current_value_cents: number | null;
      purchase: { price_cents: number | null } | null;
      warranty: { provider: string | null } | null;
      storage: {
        location_id: string;
        identifier: string | null;
        active: boolean;
        item_count: number;
      } | null;
    };
  };
}

async function createContainer(request: APIRequestContext, roomId: string, name: string) {
  const auth = await headers(request);
  const response = await request.post("/api/v1/containers", {
    headers: auth,
    data: { room_id: roomId, container_type: "box", name },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}

async function screenshot(page: Page, name: string) {
  await fs.mkdir("../../docs/walkthrough/item-storage", { recursive: true });
  await page.screenshot({
    path: `../../docs/walkthrough/item-storage/${name}.png`,
    fullPage: false,
    animations: "disabled",
  });
}

test("owned item provides contents while retaining purchase, warranty and value", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const id = suffix();
  const roomId = await createRoom(request, `Item storage room ${id}`);
  const hostId = await createItem(request, `Site toolbox ${id}`, roomId, {
    purchase: {
      vendor: "Build Supply",
      price_cents: 10000,
      currency: "USD",
    },
    warranty: { provider: "Tool warranty", end_date: "2030-01-01" },
    current_value_cents: 5000,
    current_value_currency: "USD",
  });

  await page.goto(`/items/${hostId}`);
  await expect(page.getByRole("heading", { name: `Site toolbox ${id}` })).toBeVisible();
  await page.getByRole("button", { name: "Store items inside" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Store items inside")).toBeVisible();
  await dialog.getByRole("button", { name: "Create contents storage" }).click();
  await expect(page.getByRole("heading", { name: "Contents" })).toBeVisible();
  await expect(page.getByText("Storage active")).toBeVisible();

  const detail = await itemDetail(request, hostId);
  expect(detail.item.storage?.active).toBe(true);
  expect(detail.item.current_value_cents).toBe(5000);
  expect(detail.item.purchase?.price_cents).toBe(10000);
  expect(detail.item.warranty?.provider).toBe("Tool warranty");
  const childId = await createItem(request, `Torque wrench ${id}`, roomId, {
    storage_location_id: detail.item.storage?.location_id,
  });
  await page.reload();
  await expect(page.getByText(`Torque wrench ${id}`)).toBeVisible();
  await expect(page.getByText("1 item · 1 nested unit")).toBeVisible();
  await expect(page.getByText("Purchase total")).toBeVisible();
  await expect(page.getByText("Tool warranty")).toBeVisible();
  await page.getByRole("heading", { name: "Contents" }).scrollIntoViewIfNeeded();
  await screenshot(page, "01-item-contents");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Contents" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.getByRole("heading", { name: "Contents" }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await screenshot(page, "05-item-contents-mobile");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();

  // Parent-only lending is explicit: the child is not silently included.
  await page.getByRole("button", { name: "Lend", exact: true }).first().click();
  const lendDialog = page.getByRole("dialog");
  await expect(
    lendDialog.getByText("Include the contents in this loan"),
  ).toBeVisible();
  await lendDialog.getByRole("combobox", { name: "Borrower" }).fill("Jo");
  await lendDialog.getByRole("button", { name: "Record loan" }).click();
  await expect(lendDialog).toBeHidden();
  const auth = await headers(request);
  const loans = await request.get(`/api/v1/loans?item_id=${hostId}&status=all`, {
    headers: auth,
  });
  const loanRows = (await loans.json()) as {
    items: Array<{ id: string; includes_contents: boolean }>;
  };
  expect(loanRows.items.length).toBeGreaterThan(0);
  expect(loanRows.items[0]?.includes_contents).toBe(false);
  const childLoans = await request.get(`/api/v1/items/${childId}/loans`, { headers: auth });
  expect(((await childLoans.json()) as { on_loan_quantity: number }).on_loan_quantity).toBe(0);
  const returned = await request.post(
    `/api/v1/loans/${loanRows.items[0]!.id}/returns`,
    {
      headers: auth,
      data: {
        quantity: 1,
        returned_on: localIsoDate(),
        request_id: crypto.randomUUID(),
      },
    },
  );
  expect(returned.ok(), await returned.text()).toBeTruthy();
  await page.reload();

  // A fresh loan can explicitly include available contents.
  await page.getByRole("button", { name: "Lend", exact: true }).first().click();
  const includeDialog = page.getByRole("dialog");
  await includeDialog.getByText("Include the contents in this loan").click();
  await expect(includeDialog.getByText(`Torque wrench ${id}`)).toBeVisible();
  await includeDialog.getByRole("combobox", { name: "Borrower" }).fill("Jo");
  await screenshot(page, "02-lend-with-contents");
  await includeDialog.getByRole("button", { name: "Record loan" }).click();
  await expect(includeDialog).toBeHidden();
  const loansAfter = await request.get(`/api/v1/loans?item_id=${hostId}&status=all`, {
    headers: auth,
  });
  const withContents = ((await loansAfter.json()) as {
    items: Array<{ id: string; includes_contents: boolean }>;
  }).items.find((loan) => loan.includes_contents);
  expect(withContents).toBeTruthy();
  await page.goto(`/loans/${withContents!.id}`);
  await expect(page.getByRole("heading", { name: "Contents on this loan" })).toBeVisible();
  await expect(page.getByText(`Torque wrench ${id}`)).toBeVisible();
  await page.getByRole("heading", { name: "Contents on this loan" }).scrollIntoViewIfNeeded();
  await screenshot(page, "03-loan-contents");
});

test("existing container gains ownership details without duplicating its identity", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const id = suffix();
  const roomId = await createRoom(request, `Ownership room ${id}`);
  const containerId = await createContainer(request, roomId, `Garden bench ${id}`);
  await page.goto(`/containers/${containerId}`);
  await expect(page.getByText(`Garden bench ${id}`).first()).toBeVisible();
  await page.getByRole("button", { name: "Add ownership details" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Ownership details for")).toBeVisible();
  await dialog.getByLabel("Owned item name").fill(`Garden bench item ${id}`);
  await dialog.getByRole("button", { name: "Create ownership details" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("link", { name: `Garden bench item ${id}` }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await page.waitForTimeout(200);
  await screenshot(page, "04-container-ownership");

  await page.getByRole("link", { name: "Open owned item" }).click();
  await expect(page.getByRole("heading", { name: `Garden bench item ${id}` })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Contents" })).toBeVisible();
  await expect(page.getByText("Storage active")).toBeVisible();
});
