import { expect, test, type APIRequestContext } from "@playwright/test";

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

test("purchase cards keep vendor-first hierarchy and readable item links", async ({
  page,
  request,
}) => {
  const id = suffix();
  const home = await property(request);
  const room = await createRoom(request, `Purchase room ${id}`, home.id);
  const drill = await createItem(
    request,
    `Hammer drill with a deliberately long product name ${id}`,
    room.id,
  );
  const bits = await createItem(request, `Carbide drill bit set ${id}`, room.id);
  const vendor = `Workshop Supply Co. ${id}`;
  const purchase = await request.post("/api/v1/purchases", {
    data: {
      merchant: vendor,
      purchase_date: "2026-02-01",
      price_cents: 123456,
      currency: "USD",
      order_number: `ORDER-${id}`,
      item_ids: [drill.item.id, bits.item.id],
    },
  });
  expect(purchase.ok(), await purchase.text()).toBeTruthy();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  await page.goto("/purchases");
  const card = page.locator("article").filter({ hasText: vendor });
  await expect(
    card.getByRole("heading", { name: vendor, level: 2 }),
  ).toBeVisible();
  await expect(
    card.getByRole("link", {
      name: new RegExp(`Hammer drill with a deliberately long product name ${id}`),
    }),
  ).toBeVisible();
  await expect(
    card.getByRole("link", { name: `Carbide drill bit set ${id}` }),
  ).toBeVisible();
  await expect(card.getByText("$1,234.56")).toBeVisible();
  await expect(card.getByText(new RegExp(`Shared · 2`))).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/local-polish/01-purchases-desktop-light.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "Switch to dark mode" }).first().click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "../../docs/walkthrough/local-polish/02-purchases-desktop-dark.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "Switch to light mode" }).first().click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/purchases");
  const mobileCard = page.locator("article").filter({ hasText: vendor });
  await expect(
    mobileCard.getByRole("heading", { name: vendor, level: 2 }),
  ).toBeVisible();
  const longItem = mobileCard.getByRole("link", {
    name: new RegExp(`Hammer drill with a deliberately long product name ${id}`),
  });
  await expect(longItem).toBeVisible();
  await longItem.evaluate((element) =>
    element.scrollIntoView({ block: "center", behavior: "instant" }),
  );
  const box = await longItem.boundingBox();
  expect(box?.x ?? 999).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 999) + (box?.width ?? 999)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "../../docs/walkthrough/local-polish/03-purchases-mobile-light.png",
    fullPage: false,
  });
});
