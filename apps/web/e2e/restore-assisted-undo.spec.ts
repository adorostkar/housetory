import { expect, test, type APIRequestContext } from "@playwright/test";

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function currentHeaders(request: APIRequestContext) {
  const response = await request.get("/api/v1/auth/session");
  const session = (await response.json()) as { household: { id: string } };
  return { "X-Household-Id": session.household.id };
}

async function createRoom(request: APIRequestContext, name: string) {
  const headers = await currentHeaders(request);
  const propertiesResponse = await request.get("/api/v1/properties", {
    headers,
  });
  const properties = (await propertiesResponse.json()) as {
    items: Array<{ id: string }>;
  };
  const response = await request.post("/api/v1/rooms", {
    headers,
    data: { name, property_id: properties.items[0]?.id },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
}

async function createContainer(
  request: APIRequestContext,
  roomId: string,
  name: string,
) {
  const response = await request.post("/api/v1/containers", {
    headers: await currentHeaders(request),
    data: { room_id: roomId, container_type: "box", name },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as { id: string; name: string; identifier: string };
}

async function createItem(
  request: APIRequestContext,
  name: string,
  roomId: string,
  locationId: string,
) {
  const response = await request.post("/api/v1/items", {
    headers: await currentHeaders(request),
    data: { name, room_id: roomId, storage_location_id: locationId },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

async function moveItem(
  request: APIRequestContext,
  itemId: string,
  roomId: string,
  locationId: string | null,
) {
  const response = await request.patch(`/api/v1/items/${itemId}`, {
    headers: await currentHeaders(request),
    data: { room_id: roomId, storage_location_id: locationId },
  });
  expect(response.ok()).toBeTruthy();
}

async function deleteContainer(request: APIRequestContext, containerId: string) {
  const response = await request.delete(`/api/v1/containers/${containerId}`, {
    headers: await currentHeaders(request),
  });
  expect(response.ok()).toBeTruthy();
}

test("restores a recoverable container and returns one item from history", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const id = suffix();
  const office = await createRoom(request, `Restore office ${id}`);
  const garage = await createRoom(request, `Restore garage ${id}`);
  const box = await createContainer(request, office.id, `Recovery box ${id}`);
  const item = await createItem(
    request,
    `Recovery router ${id}`,
    office.id,
    box.id,
  );
  await moveItem(request, item.item.id, garage.id, null);
  await deleteContainer(request, box.id);

  await page.goto(`/items/${item.item.id}`);
  await expect(
    page.getByRole("heading", { name: new RegExp(`Recovery router ${id}`) }),
  ).toBeVisible();
  const restoreButton = page.getByRole("button", {
    name: /Restore container and undo move/,
  });
  await expect(restoreButton).toBeVisible();
  await expect(page.getByText(/Undo unavailable/)).toHaveCount(0);
  await restoreButton.click();

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", {
      name: "Restore container and undo one move?",
    }),
  ).toBeVisible();
  await expect(dialog.getByText(box.identifier, { exact: true })).toBeVisible();
  await expect(dialog.getByText(`Recovery router ${id}`)).toBeVisible();
  await expect(dialog.getByText(/Only this item move is reversed/)).toBeVisible();
  await expect(dialog.getByText(/Restore office/).first()).toBeVisible();
  await page.waitForTimeout(450);
  await page.screenshot({
    path: "../../docs/walkthrough/restore-assisted-undo/01-preview.png",
    fullPage: false,
  });

  const restored = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/restore-undo"),
  );
  await dialog.getByRole("button", { name: "Restore and undo" }).click();
  expect((await restored).ok()).toBeTruthy();
  await expect(
    page.getByText(/Container restored and one item move undone/),
  ).toBeVisible();
  await expect(
    page.getByText(/Container restored and one item move undone/),
  ).toBeHidden({ timeout: 10_000 });
  await expect(restoreButton).toHaveCount(0);
  await expect(page.getByText(/Restored container and/)).toBeVisible();
  await page.waitForTimeout(350);
  await page.screenshot({
    path: "../../docs/walkthrough/restore-assisted-undo/02-restored.png",
    fullPage: false,
  });

  const headers = await currentHeaders(request);
  const container = await request.get(`/api/v1/containers/${box.id}`, { headers });
  expect(container.ok()).toBeTruthy();
  expect((await container.json()).identifier).toBe(box.identifier);
  const state = await request.get(`/api/v1/items/${item.item.id}`, { headers });
  expect(state.ok()).toBeTruthy();
  const body = await state.json();
  expect(body.item.location.id).toBe(box.id);
  expect(body.item.room.id).toBe(office.id);
});

test("shows an honest blocker when the item moved again after container deletion", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const id = suffix();
  const office = await createRoom(request, `Conflict office ${id}`);
  const garage = await createRoom(request, `Conflict garage ${id}`);
  const attic = await createRoom(request, `Conflict attic ${id}`);
  const box = await createContainer(request, office.id, `Conflict box ${id}`);
  const item = await createItem(
    request,
    `Conflict router ${id}`,
    office.id,
    box.id,
  );
  await moveItem(request, item.item.id, garage.id, null);
  await deleteContainer(request, box.id);
  await moveItem(request, item.item.id, attic.id, null);

  await page.goto(`/items/${item.item.id}`);
  await expect(
    page.getByText(/Restore unavailable: The item has moved since this action/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Restore container and undo move/ }),
  ).toHaveCount(0);
  const state = await request.get(`/api/v1/items/${item.item.id}`, {
    headers: await currentHeaders(request),
  });
  const body = await state.json();
  expect(body.item.room.id).toBe(attic.id);
  expect(body.item.location).toBeNull();
});

test("room deletion warns about detached recoverable places and leaves an honest blocker", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const id = suffix();
  const office = await createRoom(request, `Detach office ${id}`);
  const garage = await createRoom(request, `Detach garage ${id}`);
  const box = await createContainer(request, office.id, `Detach box ${id}`);
  const item = await createItem(
    request,
    `Detach router ${id}`,
    office.id,
    box.id,
  );
  await moveItem(request, item.item.id, garage.id, null);
  await deleteContainer(request, box.id);

  await page.goto(`/rooms/${office.id}`);
  await page.getByRole("button", { name: "Room options" }).click();
  await page.getByRole("menuitem", { name: "Delete room" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(/recoverable-deleted place/),
  ).toBeVisible();
  await expect(
    dialog.getByText(/item-move restoration becomes unavailable/),
  ).toBeVisible();
  await page.waitForTimeout(350);
  await page.screenshot({
    path: "../../docs/walkthrough/restore-assisted-undo/03-room-delete-warning.png",
    fullPage: false,
  });
  await dialog.getByRole("button", { name: "Delete room" }).click();
  await expect(page.getByText("Room deleted")).toBeVisible();
  await page.waitForTimeout(350);

  const headers = await currentHeaders(request);
  const rooms = await request.get("/api/v1/rooms", { headers });
  const roomBody = (await rooms.json()) as { items: Array<{ id: string }> };
  expect(roomBody.items.some((entry) => entry.id === office.id)).toBe(false);
  const container = await request.get(`/api/v1/containers/${box.id}`, {
    headers,
  });
  expect(container.status()).toBe(410);

  await page.goto(`/items/${item.item.id}`);
  await expect(
    page.getByText(/Restore unavailable: The original room no longer exists/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Restore container and undo move/ }),
  ).toHaveCount(0);
  await page
    .getByText(/Restore unavailable: The original room no longer exists/)
    .scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);
  await page.screenshot({
    path: "../../docs/walkthrough/restore-assisted-undo/04-detached-blocker.png",
    fullPage: false,
  });
});
