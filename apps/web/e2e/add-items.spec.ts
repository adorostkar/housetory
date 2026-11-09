import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function createRoom(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/rooms", { data: { name } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
}

async function createContainer(
  request: APIRequestContext,
  roomId: string,
  name: string,
) {
  const response = await request.post("/api/v1/containers", {
    data: { room_id: roomId, container_type: "box", name },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    id: string;
    identifier: string;
    room_id: string;
  };
}

async function createLocation(
  request: APIRequestContext,
  roomId: string,
  name: string,
) {
  const response = await request.post("/api/v1/storage-locations", {
    data: { room_id: roomId, name, kind: "shelf" },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
}

async function expectSmartAdd(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Add items" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Add items" })).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Describe items or paste a product link" }),
  ).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Take photo" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Choose photo" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Record voice note" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Review items" })).toBeDisabled();
  await expect(
    dialog.getByRole("link", { name: "or fill in the form yourself" }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Enter manually/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Describe or show/ })).toHaveCount(0);
  return dialog;
}

test("unified Add items input detects input kinds and preserves context", async ({
  page,
  browser,
  request,
}) => {
  const suffix = Date.now().toString().slice(-6);
  const room = await createRoom(request, `Add items room ${suffix}`);
  const container = await createContainer(request, room.id, `Add items box ${suffix}`);
  const shelf = await createLocation(request, room.id, `Add items shelf ${suffix}`);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  const sidebarAdd = page.locator("aside").getByRole("button", { name: "Add items" });
  await expect(sidebarAdd).toBeVisible();
  await sidebarAdd.click();
  let dialog = await expectSmartAdd(page);
  const textbox = dialog.getByRole("textbox", {
    name: "Describe items or paste a product link",
  });
  await textbox.fill("Two camping chairs");
  await expect(dialog.getByText("Text", { exact: true })).toBeVisible();
  await textbox.fill("https://shop.example/osprey");
  await expect(dialog.getByText("Link", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Record voice note" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await expect(sidebarAdd).toBeFocused();

  await sidebarAdd.click();
  await (await expectSmartAdd(page))
    .getByRole("link", { name: "or fill in the form yourself" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/items\/new(\?property_id=[^&]+)?$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);

  await page.goto(`/containers/${container.id}`);
  await expect(
    page.getByRole("heading", { name: container.identifier, level: 1, exact: true }),
  ).toBeVisible();
  const containerAdd = page.locator("main").getByRole("button", { name: "Add items" }).first();
  await containerAdd.click();
  dialog = await expectSmartAdd(page);
  await expect(
    dialog.getByRole("button", {
      name: new RegExp(`Place: ${room.name} · ${container.identifier}`),
    }),
  ).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Describe items or paste a product link" })
    .fill(`- Context import item ${suffix}`);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]+$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const contextBatchId = page.url().split("/").pop();
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/v1/imports/${contextBatchId}`);
      return ((await response.json()) as { status: string }).status;
    })
    .toBe("review");
  const contextDetail = (await (
    await page.request.get(`/api/v1/imports/${contextBatchId}`)
  ).json()) as {
    entries: Array<{
      proposed: {
        room: { matched_id: string } | null;
        storage_location: { matched_id: string } | null;
      };
    }>;
  };
  expect(contextDetail.entries[0].proposed.room?.matched_id).toBe(room.id);
  expect(contextDetail.entries[0].proposed.storage_location?.matched_id).toBe(
    container.id,
  );

  await page.goto(`/add-items?room_id=${room.id}&location_id=${container.id}`);
  await expect(page).toHaveURL(/\/$/);
  dialog = await expectSmartAdd(page);
  await expect(
    dialog.getByRole("button", {
      name: new RegExp(`Place: ${room.name} · ${container.identifier}`),
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.goto(`/rooms/${room.id}?location_id=${shelf.id}`);
  await page.getByRole("button", { name: "Add items" }).first().click();
  dialog = await expectSmartAdd(page);
  await dialog.getByRole("button", { name: /^Place:/ }).click();
  const picker = dialog.getByRole("group", { name: "Where are these items?" });
  await expect(picker.getByLabel("Room")).toHaveValue(room.id);
  await expect(picker.getByLabel("Place")).toHaveValue(shelf.id);
  await picker.getByRole("button", { name: "Done" }).click();
  await dialog.getByRole("link", { name: "or fill in the form yourself" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/items/new\\?(?:property_id=[^&]+&)?room_id=${room.id}&location_id=${shelf.id}`),
  );

  const mobile = await browser.newContext({
    viewport: { width: 393, height: 852 },
    storageState: await page.context().storageState(),
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto("/");
  await mobilePage.getByRole("button", { name: "Add items" }).first().click();
  const sheet = await expectSmartAdd(mobilePage);
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox).not.toBeNull();
  expect(Math.round((sheetBox?.y ?? 0) + (sheetBox?.height ?? 0))).toBeGreaterThanOrEqual(851);
  expect(Math.round(sheetBox?.width ?? 0)).toBe(393);
  await mobilePage.keyboard.press("Escape");
  await expect(mobilePage.getByRole("dialog")).toHaveCount(0);
  await mobilePage.goto("/items");
  await mobilePage.getByRole("button", { name: "Add items" }).click();
  await (await expectSmartAdd(mobilePage))
    .getByRole("link", { name: "or fill in the form yourself" })
    .click();
  await expect(mobilePage).toHaveURL(/\/items\/new/);
  await mobile.close();
});
