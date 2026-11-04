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

async function expectChooser(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Add items" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Enter manually/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Scan a photo/ })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Record a voice note/ }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Import a list or file/ }),
  ).toBeVisible();
  return dialog;
}

test("unified Add items chooser consolidates workflows and preserves context", async ({
  page,
  browser,
  request,
}) => {
  const suffix = Date.now().toString().slice(-6);
  const room = await createRoom(request, `Add items room ${suffix}`);
  const container = await createContainer(request, room.id, `Add items box ${suffix}`);
  const shelf = await createLocation(request, room.id, `Add items shelf ${suffix}`);

  await page.goto("/");
  const sidebarAdd = page.locator("aside").getByRole("button", { name: "Add items" });
  await expect(sidebarAdd).toBeVisible();
  await sidebarAdd.click();
  let dialog = await expectChooser(page);
  expect(await dialog.getByText(/Starting from/).count()).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);

  await sidebarAdd.click();
  await (await expectChooser(page))
    .getByRole("button", { name: /Enter manually/ })
    .click();
  await expect(page).toHaveURL(/\/items\/new$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);

  await page.goto(`/containers/${container.id}`);
  await expect(
    page.getByRole("heading", { name: container.identifier, level: 1, exact: true }),
  ).toBeVisible();
  const containerAdd = page.locator("main").getByRole("button", { name: "Add items" }).first();
  await containerAdd.click();
  dialog = await expectChooser(page);
  await expect(dialog.getByText(room.name)).toBeVisible();
  await expect(dialog.getByText(container.identifier)).toBeVisible();
  await dialog.getByRole("button", { name: /Scan a photo/ }).click();
  await expect(page).toHaveURL(
    new RegExp(`/scan\\?room_id=${room.id}&location_id=${container.id}`),
  );
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/containers/${container.id}`));

  await page.locator("main").getByRole("button", { name: "Add items" }).first().click();
  await (await expectChooser(page))
    .getByRole("button", { name: /Import a list or file/ })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/imports\\?room_id=${room.id}&location_id=${container.id}`),
  );
  await expect(page.getByText(/New entries without their own location/)).toBeVisible();
  await expect(page.getByText(container.identifier)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Import history" })).toBeVisible();
  await page.getByLabel("Notes").fill(`- Context import item ${suffix}`);
  await page.getByRole("button", { name: "Process import" }).click();
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]+$/);
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

  await page.goto(`/rooms/${room.id}?location_id=${shelf.id}`);
  await page.getByRole("button", { name: "Add items" }).first().click();
  await (await expectChooser(page))
    .getByRole("button", { name: /Enter manually/ })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/items/new\\?room_id=${room.id}&location_id=${shelf.id}`),
  );

  const mobile = await browser.newContext({
    viewport: { width: 393, height: 852 },
    storageState: await page.context().storageState(),
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto("/");
  await mobilePage.getByRole("button", { name: "Add items" }).first().click();
  await expectChooser(mobilePage);
  await mobilePage.keyboard.press("Escape");
  await expect(mobilePage.getByRole("dialog")).toHaveCount(0);
  await mobilePage.goto("/items");
  await mobilePage.getByRole("button", { name: "Add items" }).click();
  await expectChooser(mobilePage);
  await mobilePage.getByRole("button", { name: /Scan a photo/ }).click();
  await expect(mobilePage).toHaveURL(/\/scan$/);
  await mobile.close();
});
