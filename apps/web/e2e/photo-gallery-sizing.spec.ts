import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type APIRequestContext } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, "fixtures/photo-sizing");

function suffix() {
  return Date.now().toString().slice(-6);
}

async function property(client: APIRequestContext) {
  const response = await client.get("/api/v1/properties");
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { items: Array<{ id: string }> };
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
  return (await response.json()) as { id: string };
}

async function createItem(
  client: APIRequestContext,
  name: string,
  roomId: string,
) {
  const response = await client.post("/api/v1/items", {
    data: { name, room_id: roomId, quantity: 1 },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string } };
}

async function uploadPhoto(
  client: APIRequestContext,
  itemId: string,
  filename: string,
) {
  const buffer = await fs.readFile(path.join(fixtureDir, filename));
  const response = await client.post(`/api/v1/items/${itemId}/photos`, {
    multipart: {
      files: {
        name: filename,
        mimeType: "image/png",
        buffer,
      },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

const photos = [
  { filename: "landscape-3x2.png", width: 900, height: 600, label: "landscape" },
  { filename: "portrait-2x3.png", width: 600, height: 900, label: "portrait" },
  { filename: "square-1x1.png", width: 700, height: 700, label: "square" },
];

const viewports = [
  { width: 390, height: 844, frameHeight: 240 },
  { width: 869, height: 900, frameHeight: 320 },
  { width: 1440, height: 1000, frameHeight: 340 },
];

test("actual photos stay inside a bounded gallery with their complete aspect ratio", async ({
  page,
  request,
}) => {
  await fs.mkdir("../../docs/walkthrough/photo-sizing", { recursive: true });
  const id = suffix();
  const home = await property(request);
  const room = await createRoom(request, `Photo sizing room ${id}`, home.id);
  const itemName = `Photo sizing drill ${id}`;
  const item = await createItem(request, itemName, room.id);
  for (const photo of photos) {
    await uploadPhoto(request, item.item.id, photo.filename);
  }

  for (const viewport of viewports) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.goto(`/items/${item.item.id}`);
    await expect(
      page.getByRole("heading", { name: itemName, level: 1 }),
    ).toBeVisible();

    const frame = page.getByTestId("photo-gallery-frame");
    await expect(frame).toBeVisible();
    const frameBox = await frame.boundingBox();
    expect(frameBox).not.toBeNull();
    expect(Math.abs((frameBox?.height ?? 0) - viewport.frameHeight)).toBeLessThan(1.5);

    for (const [index, photo] of photos.entries()) {
      await page.getByRole("button", { name: `View photograph ${index + 1}` }).click();
      const image = page.getByAltText(`${itemName} photograph`);
      await expect
        .poll(async () =>
          image.evaluate((element) => {
            const img = element as HTMLImageElement;
            return img.complete ? img.naturalWidth : 0;
          }),
        )
        .toBe(photo.width);

      const metrics = await image.evaluate((element) => {
        const img = element as HTMLImageElement;
        const box = img.getBoundingClientRect();
        const style = window.getComputedStyle(img);
        return {
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          width: box.width,
          height: box.height,
          objectFit: style.objectFit,
        };
      });
      expect(metrics.objectFit).toBe("contain");
      expect(metrics.width).toBeLessThanOrEqual((frameBox?.width ?? 0) + 0.5);
      expect(metrics.height).toBeLessThanOrEqual((frameBox?.height ?? 0) + 0.5);
      expect(metrics.width / metrics.height).toBeCloseTo(
        metrics.naturalWidth / metrics.naturalHeight,
        1,
      );
    }

    const galleryImage = page.getByAltText(`${itemName} photograph`);
    const waitForWidth = async (width: number) => {
      await expect
        .poll(async () =>
          galleryImage.evaluate((element) => {
            const img = element as HTMLImageElement;
            return img.complete ? img.naturalWidth : 0;
          }),
        )
        .toBe(width);
    };
    if (viewport.width === 1440) {
      await page.getByRole("button", { name: "View photograph 1" }).click();
      await waitForWidth(900);
      await page.screenshot({
        path: "../../docs/walkthrough/photo-sizing/01-gallery-landscape-desktop.png",
        fullPage: false,
      });
      await page.getByRole("button", { name: "View photograph 2" }).click();
      await waitForWidth(600);
      await page.screenshot({
        path: "../../docs/walkthrough/photo-sizing/02-gallery-portrait-desktop.png",
        fullPage: false,
      });
    }
    if (viewport.width === 869) {
      await page.getByRole("button", { name: "View photograph 3" }).click();
      await waitForWidth(700);
      await page.screenshot({
        path: "../../docs/walkthrough/photo-sizing/03-gallery-square-tablet.png",
        fullPage: false,
      });
    }
    if (viewport.width === 390) {
      await page.getByRole("button", { name: "View photograph 1" }).click();
      await waitForWidth(900);
      await page.screenshot({
        path: "../../docs/walkthrough/photo-sizing/04-gallery-landscape-mobile.png",
        fullPage: false,
      });
    }
  }
});

test("inventory grid and compact list fit complete actual photos without cropping", async ({
  page,
  request,
}) => {
  const id = suffix();
  const home = await property(request);
  const room = await createRoom(request, `Photo card room ${id}`, home.id);
  const itemName = `Photo card drill ${id}`;
  const item = await createItem(request, itemName, room.id);
  await uploadPhoto(request, item.item.id, "portrait-2x3.png");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/items");
  const card = page.locator(`a[href^="/items/${item.item.id}"]`).first();
  await expect(card).toBeVisible();
  const cardImage = card.locator("img").first();
  await expect(cardImage).toHaveClass(/object-contain/);
  await expect
    .poll(async () =>
      cardImage.evaluate((element) => {
        const img = element as HTMLImageElement;
        return img.complete ? img.naturalWidth : 0;
      }),
    )
    .toBeGreaterThan(0);
  const cardMetrics = await cardImage.evaluate((element) => {
    const img = element as HTMLImageElement;
    const box = img.getBoundingClientRect();
    return {
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      width: box.width,
      height: box.height,
    };
  });
  expect(cardMetrics.width / cardMetrics.height).toBeCloseTo(
    cardMetrics.naturalWidth / cardMetrics.naturalHeight,
    1,
  );
  await page.screenshot({
    path: "../../docs/walkthrough/photo-sizing/05-item-card-actual-photo.png",
    fullPage: false,
  });

  await page.getByRole("button", { name: "Compact list view" }).click();
  const row = page.locator(`a[href^="/items/${item.item.id}"]`).first();
  await expect(row).toBeVisible();
  const rowImage = row.locator("img").first();
  await expect(rowImage).toHaveClass(/object-contain/);
  await expect
    .poll(async () =>
      rowImage.evaluate((element) => {
        const img = element as HTMLImageElement;
        return img.complete ? img.naturalWidth : 0;
      }),
    )
    .toBeGreaterThan(0);
  const rowMetrics = await rowImage.evaluate((element) => {
    const img = element as HTMLImageElement;
    const box = img.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      objectFit: window.getComputedStyle(img).objectFit,
    };
  });
  expect(rowMetrics.objectFit).toBe("contain");
  expect(rowMetrics.width).toBeGreaterThan(0);
  expect(rowMetrics.height).toBeGreaterThan(0);
  await page.screenshot({
    path: "../../docs/walkthrough/photo-sizing/06-item-list-actual-photo.png",
    fullPage: false,
  });
});
