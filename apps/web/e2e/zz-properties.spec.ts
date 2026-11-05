import fs from "node:fs/promises";

import { expect, test, type APIRequestContext } from "@playwright/test";

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createProperty(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/properties", {
    data: { name },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
}

async function createRoom(
  request: APIRequestContext,
  name: string,
  propertyId: string,
) {
  const response = await request.post("/api/v1/rooms", {
    data: { name, property_id: propertyId },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    id: string;
    name: string;
    property_id: string;
    property: { id: string; name: string };
  };
}

async function createContainer(request: APIRequestContext, roomId: string, name: string) {
  const response = await request.post("/api/v1/containers", {
    data: { room_id: roomId, container_type: "box", name },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    id: string;
    name: string;
    identifier: string;
    qr_payload: string;
    property: { id: string; name: string };
  };
}

async function createItem(
  request: APIRequestContext,
  name: string,
  roomId: string,
  locationId: string,
  quantity = 1,
) {
  const response = await request.post("/api/v1/items", {
    data: {
      name,
      room_id: roomId,
      ...(locationId ? { storage_location_id: locationId } : {}),
      quantity,
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

async function createLoan(request: APIRequestContext, itemId: string, quantity = 1) {
  const response = await request.post("/api/v1/loans", {
    data: {
      item_id: itemId,
      borrower_name: "Private Borrower",
      quantity,
      lent_on: "2026-01-01",
      request_id: crypto.randomUUID(),
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string };
}

async function completePresentStocktake(
  request: APIRequestContext,
  roomId: string,
  itemId: string,
  counted: number,
) {
  const started = await request.post("/api/v1/stocktake/sessions", {
    data: {
      room_ids: [roomId],
      container_ids: [],
      include_descendants: true,
      request_id: crypto.randomUUID(),
    },
  });
  expect(started.ok()).toBeTruthy();
  const session = (await started.json()) as { id: string };
  const detailResponse = await request.get(`/api/v1/stocktake/sessions/${session.id}`);
  const detail = (await detailResponse.json()) as {
    items: Array<{
      item_id: string;
      snapshot_item_id: string;
      current: { updated_at: string; on_loan_quantity: number };
    }>;
  };
  const row = detail.items.find((entry) => entry.item_id === itemId);
  expect(row).toBeTruthy();
  const observed = await request.post(
    `/api/v1/stocktake/sessions/${session.id}/observations`,
    {
      data: {
        request_id: crypto.randomUUID(),
        status: "present",
        snapshot_item_id: row?.snapshot_item_id,
        counted_quantity: counted,
        expected_item_updated_at: row?.current.updated_at,
        expected_on_loan_quantity: row?.current.on_loan_quantity,
      },
    },
  );
  expect(observed.ok()).toBeTruthy();
  const completed = await request.post(
    `/api/v1/stocktake/sessions/${session.id}/complete`,
    { data: { request_id: crypto.randomUUID(), acknowledge_partial: true } },
  );
  expect(completed.ok()).toBeTruthy();
  return session.id;
}

test("filters rooms by property, remembers the choice, and keeps add-item/container context", async ({
  page,
  request,
}) => {
  await fs.mkdir("../../docs/walkthrough/properties", { recursive: true });
  const id = suffix();
  const home = (await (await request.get("/api/v1/properties")).json()).items[0] as {
    id: string;
    name: string;
  };
  const cabin = await createProperty(request, `Cabin ${id}`);
  await createProperty(request, `Empty ${id}`);
  const homeKitchen = await createRoom(request, `Kitchen ${id}`, home.id);
  const cabinKitchen = await createRoom(request, `Kitchen ${id}`, cabin.id);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/rooms");
  const propertyFilter = page.getByLabel("Filter rooms by property");
  await expect(propertyFilter).toBeVisible();
  if ((await propertyFilter.inputValue()) !== "") {
    await propertyFilter.selectOption("");
  }
  const homeRoomLink = page.locator(`a[href="/rooms/${homeKitchen.id}"]`);
  const cabinRoomLink = page.locator(`a[href="/rooms/${cabinKitchen.id}"]`);
  await expect(homeRoomLink.first()).toBeVisible();
  await expect(cabinRoomLink.first()).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/properties/01-rooms-all-properties-light.png",
    fullPage: false,
  });

  await propertyFilter.selectOption(cabin.id);
  await expect(cabinRoomLink.first()).toBeVisible();
  await expect(homeRoomLink).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Filter rooms by property")).toHaveValue(cabin.id);
  await expect(cabinRoomLink.first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "../../docs/walkthrough/properties/03-properties-mobile.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel("Filter rooms by property").selectOption("");

  await page.goto(`/rooms/${homeKitchen.id}`);
  await page.getByRole("button", { name: "Add items" }).first().click();
  await page.getByRole("button", { name: /Enter manually/ }).click();
  await expect(page).toHaveURL(/\/items\/new/);
  await expect(page.getByLabel("Property")).toHaveValue(home.id);
  await expect(page.getByLabel("Room")).toHaveValue(homeKitchen.id);
  const itemName = `Bread maker ${id}`;
  await page.getByLabel("Item name").fill(itemName);
  await page.getByRole("button", { name: "Add to your home" }).click();
  await expect(page.getByRole("heading", { name: itemName })).toBeVisible();
  const createdItem = (await (
    await request.get(`/api/v1/items?q=${encodeURIComponent(itemName)}`)
  ).json()) as {
    items: Array<{ id: string; property: { name: string }; room: { id: string } }>;
  };
  const item = createdItem.items.find((entry) => entry.name === itemName);
  expect(item?.room.id).toBe(homeKitchen.id);
  expect(item?.property.name).toBe(home.name);

  await page.goto(`/containers?property_id=${cabin.id}`);
  await page.getByRole("button", { name: "New container" }).click();
  const containerDialog = page.getByRole("dialog", { name: "Create a container" });
  await expect(containerDialog.getByLabel("Room")).toHaveValue(cabinKitchen.id);
  const boxName = `Kitchen box ${id}`;
  await containerDialog.getByLabel("Name").fill(boxName);
  await containerDialog.getByRole("button", { name: "Create container" }).click();
  await expect(containerDialog).not.toBeVisible();
  const containers = (await (
    await request.get(`/api/v1/containers?property_id=${cabin.id}&q=${encodeURIComponent(boxName)}`)
  ).json()) as {
    items: Array<{ id: string; property: { name: string }; room_id: string }>;
  };
  expect(containers.items[0]?.property.name).toBe(cabin.name);
  expect(containers.items[0]?.room_id).toBe(cabinKitchen.id);

  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "dark");
  });
  await page.goto("/rooms");
  const darkFilter = page.getByLabel("Filter rooms by property");
  if ((await darkFilter.inputValue()) !== "") await darkFilter.selectOption("");
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "../../docs/walkthrough/properties/02-rooms-all-properties-dark.png",
    fullPage: false,
  });
});

test("moves a room subtree across properties, preserves ids/qr/loan, and guards populated properties", async ({
  page,
  request,
}) => {
  await fs.mkdir("../../docs/walkthrough/properties", { recursive: true });
  const id = suffix();
  const home = (await (await request.get("/api/v1/properties")).json()).items[0] as {
    id: string;
    name: string;
  };
  const cabin = await createProperty(request, `Move cabin ${id}`);
  const empty = await createProperty(request, `Delete me ${id}`);
  const workshop = await createRoom(request, `Workshop ${id}`, home.id);
  const office = await createRoom(request, `Office ${id}`, home.id);
  await createItem(request, `Office chair ${id}`, office.id, "", 1);
  const box = await createContainer(request, workshop.id, `Tool box ${id}`);
  const drill = await createItem(request, `Drill ${id}`, workshop.id, box.id, 2);
  const loan = await createLoan(request, drill.item.id, 1);
  await completePresentStocktake(request, workshop.id, drill.item.id, 1);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/rooms/${workshop.id}`);
  await page.getByRole("button", { name: "Move to property" }).click();
  const moveDialog = page.getByRole("dialog", { name: "Move room to another property" });
  await moveDialog.getByLabel("Destination property").selectOption(cabin.id);
  await expect(moveDialog.getByText(/1 unit\(s\) remain on loan/)).toBeVisible();
  await expect(moveDialog.getByText(/Existing item last-checked dates/)).toBeVisible();
  await moveDialog.getByRole("button", { name: "Move subtree" }).click();
  await expect(moveDialog).not.toBeVisible();

  const movedRoom = (await (
    await request.get(`/api/v1/rooms/${workshop.id}`)
  ).json()) as { property: { id: string; name: string } };
  const movedBox = (await (
    await request.get(`/api/v1/containers/${box.id}`)
  ).json()) as {
    id: string;
    qr_payload: string;
    property: { name: string };
  };
  const movedItem = (await (
    await request.get(`/api/v1/items/${drill.item.id}`)
  ).json()) as {
    item: {
      id: string;
      quantity: number;
      on_loan_quantity: number;
      location: { id: string };
      last_verified: { stale: boolean };
    };
  };
  expect(movedRoom.property.id).toBe(cabin.id);
  expect(movedBox.id).toBe(box.id);
  expect(movedBox.property.name).toBe(cabin.name);
  expect(movedBox.qr_payload.endsWith(`/containers/${box.id}`)).toBeTruthy();
  expect(movedItem.item.id).toBe(drill.item.id);
  expect(movedItem.item.quantity).toBe(2);
  expect(movedItem.item.on_loan_quantity).toBe(1);
  expect(movedItem.item.location.id).toBe(box.id);
  expect(movedItem.item.last_verified.stale).toBe(true);
  const loanAfter = (await (
    await request.get(`/api/v1/loans/${loan.id}`)
  ).json()) as { status: string };
  expect(loanAfter.status).toBe("outstanding");

  await page.reload();
  await expect(page.getByText(cabin.name).first()).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/properties/04-room-moved-desktop.png",
    fullPage: false,
  });

  await page.goto("/settings");
  await expect(page.getByRole("button", { name: `Archive ${home.name}` })).toBeDisabled();
  await page.screenshot({
    path: "../../docs/walkthrough/properties/05-properties-settings.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: `Delete ${empty.name}` }).click();
  const deleteDialog = page.getByRole("dialog", { name: `Delete ${empty.name}?` });
  await deleteDialog.getByRole("button", { name: "Delete property" }).click();
  await expect(deleteDialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: `Delete ${empty.name}` })).toHaveCount(0);
  const properties = (await (await request.get("/api/v1/properties?include_archived=true")).json()) as {
    items: Array<{ id: string }>;
  };
  expect(properties.items.some((property) => property.id === empty.id)).toBe(false);
});
