import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const photoPath = path.resolve(here, "../public/icons/icon-192.png");

async function createRoom(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/rooms", { data: { name } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
}

async function createContainer(
  request: APIRequestContext,
  roomId: string,
  type = "box",
) {
  const response = await request.post("/api/v1/containers", {
    data: { room_id: roomId, container_type: type },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    id: string;
    identifier: string;
    room_id: string;
  };
}

async function openContainers(page: Page) {
  await page.goto("/containers");
  await expect(page.getByRole("heading", { name: "Containers", level: 1 })).toBeVisible();
}

test("creates unnamed and bulk containers with permanent identifiers", async ({ page, request }) => {
  const room = await createRoom(request, `Storage ${Date.now()}`);
  await openContainers(page);
  await page.getByRole("button", { name: "New container" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Room").selectOption(room.id);
  await dialog.getByRole("button", { name: "Create container" }).click();
  await expect(page.getByText(/BOX-\d{3}/).first()).toBeVisible();

  await page.getByRole("button", { name: "New container" }).click();
  const bulk = page.getByRole("dialog");
  await bulk.getByLabel("Room").selectOption(room.id);
  await bulk.getByLabel("How many?").fill("3");
  await bulk.getByRole("button", { name: /Create 3 containers/ }).click();
  await expect(bulk).toBeHidden();
  await expect
    .poll(async () => {
      const listResponse = await request.get(`/api/v1/containers?room_id=${room.id}`);
      return (await listResponse.json()).total;
    })
    .toBe(4);
});

test("moves a container across rooms without changing its identity or contents", async ({
  page,
  request,
}) => {
  const source = await createRoom(request, `Source ${Date.now()}`);
  const destination = await createRoom(request, `Attic ${Date.now()}`);
  const container = await createContainer(request, source.id);
  const itemResponse = await request.post("/api/v1/items", {
    data: {
      name: "Camera charger",
      room_id: source.id,
      storage_location_id: container.id,
    },
  });
  expect(itemResponse.ok()).toBeTruthy();

  await page.goto(`/containers/${container.id}`);
  await expect(page.getByRole("heading", { name: container.identifier, level: 1, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Move" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Destination room").selectOption(destination.id);
  await dialog.getByRole("button", { name: "Move container" }).click();
  await expect(page.getByText(destination.name).first()).toBeVisible();
  await expect(page.getByText("Camera charger").first()).toBeVisible();

  await page.goto(`/search?q=${container.identifier}`);
  await expect(page.getByText("Camera charger").first()).toBeVisible();
});

test("previews, downloads and calibrates a label sheet", async ({ page, request }) => {
  const room = await createRoom(request, `Labels ${Date.now()}`);
  const container = await createContainer(request, room.id);
  await page.goto(`/labels?ids=${container.id}`);
  await expect(page.getByRole("heading", { name: "Labels", level: 1 })).toBeVisible();
  await expect(page.getByText("Avery L7165")).toBeVisible();
  await expect(
    page.getByText(/Labels never print item names, counts, contents, or the current room/i),
  ).toBeVisible();
  await page.getByLabel("Layout").selectOption("detailed");
  await page.getByLabel("First empty position").selectOption("3");
  await expect(page.locator("iframe[title='Label sheet preview']")).toBeVisible({ timeout: 30_000 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  expect(fs.statSync(path as string).size).toBeGreaterThan(10_000);

  const calibrationPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download calibration sheet" }).click();
  const calibration = await calibrationPromise;
  expect(calibration.suggestedFilename()).toContain("calibration");
});

test("shows an authenticated QR destination and mobile container view", async ({
  page,
  browser,
  request,
}) => {
  const room = await createRoom(request, `QR ${Date.now()}`);
  const container = await createContainer(request, room.id, "bin");
  await page.goto(`/containers/${container.id}`);
  await page.getByRole("button", { name: "QR" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("img")).toBeVisible();
  const payload = await dialog.locator("code").innerText();
  expect(payload).toContain(`/containers/${container.id}`);

  const mobile = await browser.newContext({
    viewport: { width: 393, height: 852 },
    storageState: await page.context().storageState(),
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`/containers/${container.id}`);
  await expect(mobilePage.getByRole("heading", { name: container.identifier, level: 1, exact: true })).toBeVisible();
  await expect(mobilePage.getByRole("button", { name: "Move" })).toBeVisible();
  await mobilePage.goto("/labels");
  await expect(mobilePage.getByText("Printer checklist")).toBeVisible();
  await mobile.close();
});


async function uploadRoomPhoto(request: APIRequestContext, roomId: string, name: string) {
  const response = await request.post(`/api/v1/rooms/${roomId}/photos`, {
    multipart: {
      files: {
        name,
        mimeType: "image/png",
        buffer: fs.readFileSync(photoPath),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function uploadContainerPhoto(
  request: APIRequestContext,
  containerId: string,
  name: string,
) {
  const response = await request.post(`/api/v1/locations/${containerId}/photos`, {
    multipart: {
      files: {
        name,
        mimeType: "image/png",
        buffer: fs.readFileSync(photoPath),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function expectPhotoFrame(
  page: Page,
  state: "empty" | "photo",
  limits: { min: number; max: number },
) {
  const frame = page.getByTestId("entity-photo-frame");
  await expect(frame).toBeVisible();
  if (state === "empty") {
    await expect(frame.getByText("Add a photograph")).toBeVisible();
  } else {
    await expect(
      page.getByRole("button", { name: /photograph full screen$/ }),
    ).toBeVisible();
  }
  const box = await frame.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(limits.min);
  expect(box!.height).toBeLessThanOrEqual(limits.max);
  const metrics = await frame.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  const documentMetrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(documentMetrics.scrollWidth).toBeLessThanOrEqual(
    documentMetrics.clientWidth + 1,
  );
}

test("keeps room and container photo areas compact for empty and populated states", async ({
  page,
  request,
}) => {
  const room = await createRoom(request, `Photos ${Date.now()}`);
  const container = await createContainer(request, room.id);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/rooms/${room.id}`);
  await expectPhotoFrame(page, "empty", { min: 160, max: 220 });
  await expect(page.getByRole("button", { name: "Take photo" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Choose photo" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Take a photo" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose a photo" })).toHaveCount(0);

  await page.setViewportSize({ width: 393, height: 852 });
  await expectPhotoFrame(page, "empty", { min: 160, max: 230 });

  await uploadRoomPhoto(request, room.id, "room-one.png");
  await page.reload();
  await expectPhotoFrame(page, "photo", { min: 180, max: 300 });
  await expect(page.getByRole("button", { name: "View photograph 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Take a photo" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Choose a photo" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Take photo" })).toHaveCount(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expectPhotoFrame(page, "photo", { min: 180, max: 300 });
  await uploadRoomPhoto(request, room.id, "room-two.png");
  await page.reload();
  await expectPhotoFrame(page, "photo", { min: 180, max: 300 });
  await expect(page.getByRole("button", { name: /^View photograph \d/ })).toHaveCount(2);

  await page.goto(`/containers/${container.id}`);
  await expectPhotoFrame(page, "empty", { min: 160, max: 220 });
  await expect(page.getByRole("button", { name: "Take photo" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Choose photo" })).toHaveCount(1);
  await uploadContainerPhoto(request, container.id, "container-one.png");
  await page.reload();
  await expectPhotoFrame(page, "photo", { min: 180, max: 300 });
  await expect(page.getByRole("button", { name: "View photograph 1" })).toBeVisible();

  await page.setViewportSize({ width: 393, height: 852 });
  await expectPhotoFrame(page, "photo", { min: 180, max: 300 });
});
