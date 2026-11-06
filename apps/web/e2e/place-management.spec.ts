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
  const propertiesResponse = await request.get("/api/v1/properties", { headers });
  expect(propertiesResponse.ok()).toBeTruthy();
  const properties = (await propertiesResponse.json()) as {
    items: Array<{ id: string }>;
  };
  const response = await request.post("/api/v1/rooms", {
    headers,
    data: { name, property_id: properties.items[0]?.id },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
}

async function createBox(request: APIRequestContext, roomId: string, name: string) {
  const response = await request.post("/api/v1/containers", {
    headers: await currentHeaders(request),
    data: { room_id: roomId, container_type: "box", name },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    id: string;
    identifier: string;
    name: string;
  };
}

async function createItem(
  request: APIRequestContext,
  name: string,
  roomId: string,
  locationId?: string,
) {
  const response = await request.post("/api/v1/items", {
    headers: await currentHeaders(request),
    data: {
      name,
      room_id: roomId,
      ...(locationId ? { storage_location_id: locationId } : {}),
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    item: { id: string; name: string; quantity: number };
  };
}

async function itemPlace(request: APIRequestContext, itemId: string) {
  const response = await request.get(`/api/v1/items/${itemId}`, {
    headers: await currentHeaders(request),
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    item: {
      id: string;
      name: string;
      quantity: number;
      room: { id: string; name: string };
      location: { id: string; name: string } | null;
    };
  };
}

test("box item list selects only its contents and bulk-moves them to a room", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const id = suffix();
  const sourceRoom = await createRoom(request, `Packing room ${id}`);
  const destinationRoom = await createRoom(request, `Empty room ${id}`);
  const box = await createBox(request, sourceRoom.id, `Packing box ${id}`);
  const otherBox = await createBox(request, sourceRoom.id, `Other box ${id}`);
  const first = await createItem(request, `Lamp ${id}`, sourceRoom.id, box.id);
  const second = await createItem(request, `Cable ${id}`, sourceRoom.id, box.id);
  const untouched = await createItem(
    request,
    `Untouched ${id}`,
    sourceRoom.id,
    otherBox.id,
  );

  await page.goto(`/containers/${box.id}`);
  await expect(page.getByRole("heading", { name: box.identifier })).toBeVisible();
  await expect(page.getByText(`Lamp ${id}`)).toBeVisible();
  await expect(page.getByText(`Cable ${id}`)).toBeVisible();
  await page.getByRole("checkbox", { name: "Select all loaded items" }).check();
  await expect(page.getByText(/2 items selected/)).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/place-management/01-box-bulk-selection.png",
    fullPage: false,
  });

  const bulkBar = page
    .locator("div.surface")
    .filter({ hasText: "2 items selected" })
    .last();
  await bulkBar.getByRole("button", { name: "Move", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Move selected items" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Destination room").selectOption(destinationRoom.id);
  await page.screenshot({
    path: "../../docs/walkthrough/place-management/02-box-move-dialog.png",
    fullPage: false,
  });
  await dialog.getByRole("button", { name: "Move selected" }).click();
  await expect(page.getByText(/Moved 2 items/)).toBeVisible();

  const firstState = await itemPlace(request, first.item.id);
  const secondState = await itemPlace(request, second.item.id);
  expect(firstState.item.room.id).toBe(destinationRoom.id);
  expect(firstState.item.location).toBeNull();
  expect(secondState.item.room.id).toBe(destinationRoom.id);
  expect(secondState.item.location).toBeNull();

  const otherState = await itemPlace(request, untouched.item.id);
  expect(otherState.item.room.id).toBe(sourceRoom.id);
  expect(otherState.item.location?.id).toBe(otherBox.id);
});

test("room/box origin survives edit, save, move and cancel", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const id = suffix();
  const sourceRoom = await createRoom(request, `Origin room ${id}`);
  const destinationRoom = await createRoom(request, `Destination room ${id}`);
  const box = await createBox(request, sourceRoom.id, `Origin box ${id}`);
  const item = await createItem(request, `Origin lamp ${id}`, sourceRoom.id, box.id);

  await page.goto(`/containers/${box.id}`);
  await page.getByRole("link", { name: new RegExp(`Origin lamp ${id}`) }).click();
  await expect(page.getByRole("link", { name: `Back to ${box.identifier}` })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/items/${item.item.id}`));
  await expect(page).toHaveURL(/from=/);

  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page).toHaveURL(/\/edit\?from=/);
  await expect(page.getByRole("link", { name: "Back to item" })).toBeVisible();
  await page.getByLabel("Item name").fill(`Renamed origin lamp ${id}`);
  await page.getByLabel("Room").selectOption(destinationRoom.id);
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByRole("heading", { name: `Renamed origin lamp ${id}` })).toBeVisible();
  await expect(page.getByRole("link", { name: `Back to ${box.identifier}` })).toBeVisible();
  const moved = await itemPlace(request, item.item.id);
  expect(moved.item.room.id).toBe(destinationRoom.id);
  expect(moved.item.location).toBeNull();
  await page.screenshot({
    path: "../../docs/walkthrough/place-management/03-origin-after-save.png",
    fullPage: false,
  });

  await page.getByRole("link", { name: `Back to ${box.identifier}` }).click();
  await expect(page.getByRole("heading", { name: box.identifier })).toBeVisible();
  await expect(page.getByText("This container is empty.")).toBeVisible();

  // Cancel returns to the same item detail and does not save the draft.
  await page.goto(`/items/${item.item.id}?from=${encodeURIComponent(`/containers/${box.id}`)}&from_label=${encodeURIComponent(box.identifier)}`);
  await page.getByRole("link", { name: "Edit" }).click();
  await page.getByLabel("Item name").fill(`Discarded rename ${id}`);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: `Renamed origin lamp ${id}` })).toBeVisible();
  await expect(page.getByRole("link", { name: `Back to ${box.identifier}` })).toBeVisible();
});

test("container delete offers empty confirmation, move-all, and move-contents-and-delete", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const id = suffix();
  const sourceRoom = await createRoom(request, `Delete room ${id}`);
  const destinationRoom = await createRoom(request, `Delete target ${id}`);
  const emptyBox = await createBox(request, sourceRoom.id, `Empty box ${id}`);
  const fullBox = await createBox(request, sourceRoom.id, `Full box ${id}`);
  const movedItem = await createItem(request, `Delete lamp ${id}`, sourceRoom.id, fullBox.id);

  // Empty deletion from the containers list.
  await page.goto(`/containers?room_id=${sourceRoom.id}`);
  await expect(page.getByText(emptyBox.identifier).first()).toBeVisible();
  const emptyCard = page
    .locator("article")
    .filter({ hasText: emptyBox.identifier });
  await emptyCard.getByRole("button", { name: `Delete ${emptyBox.identifier}` }).click();
  const emptyDialog = page.getByRole("dialog");
  await expect(emptyDialog.getByText(/is empty and can be removed/i)).toBeVisible();
  await emptyDialog.getByRole("button", { name: "Delete container" }).click();
  await expect(emptyDialog).toBeHidden();
  await expect(
    page.locator("article").filter({ hasText: emptyBox.identifier }),
  ).toHaveCount(0);

  // Standalone move-all on a nonempty container keeps the container.
  await page.goto(`/containers/${fullBox.id}`);
  await page.getByRole("button", { name: "Move contents" }).click();
  const moveDialog = page.getByRole("dialog", { name: /Move all contents out of/i });
  await moveDialog.getByLabel("Destination room").selectOption(destinationRoom.id);
  await expect(moveDialog.getByText(/Deleting .* is permanent/i)).toHaveCount(0);
  await page.screenshot({
    path: "../../docs/walkthrough/place-management/04-move-contents-preview.png",
    fullPage: false,
  });
  await moveDialog.getByRole("button", { name: "Move all contents" }).click();
  await expect(page.getByText(/Moved .*out of/)).toBeVisible();
  await expect(page.getByText("This container is empty.")).toBeVisible();
  const preserved = await itemPlace(request, movedItem.item.id);
  expect(preserved.item.room.id).toBe(destinationRoom.id);
  expect(preserved.item.location).toBeNull();

  // Put an item back and delete the nonempty container through the list action.
  const secondItem = await createItem(
    request,
    `Delete cable ${id}`,
    sourceRoom.id,
    fullBox.id,
  );
  await page.goto(`/containers?room_id=${sourceRoom.id}`);
  const fullCard = page
    .locator("article")
    .filter({ hasText: fullBox.identifier });
  await fullCard.getByRole("button", { name: `Delete ${fullBox.identifier}` }).click();
  const deleteDialog = page.getByRole("dialog", { name: /Move contents and delete/i });
  await deleteDialog.getByLabel("Destination room").selectOption(destinationRoom.id);
  await expect(deleteDialog.getByText(/Deleting .* is permanent/i)).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/place-management/05-move-and-delete-preview.png",
    fullPage: false,
  });
  await deleteDialog.getByRole("button", { name: "Move contents and delete" }).click();
  await expect(
    page.locator("article").filter({ hasText: fullBox.identifier }),
  ).toHaveCount(0);
  const preservedSecond = await itemPlace(request, secondItem.item.id);
  expect(preservedSecond.item.room.id).toBe(destinationRoom.id);
  expect(preservedSecond.item.location).toBeNull();
});
