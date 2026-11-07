import fs from "node:fs/promises";

import { expect, test, type APIRequestContext } from "@playwright/test";

function suffix() {
  return Date.now().toString().slice(-6);
}

async function headers(request: APIRequestContext) {
  const response = await request.get("/api/v1/auth/session");
  const state = (await response.json()) as { household: { id: string } };
  return { "X-Household-Id": state.household.id };
}

test("container contents summary is live after quantity and move changes", async ({
  page,
  request,
}) => {
  const auth = await headers(request);
  const id = suffix();
  const properties = await request.get("/api/v1/properties", { headers: auth });
  const property = ((await properties.json()) as { items: Array<{ id: string }> })
    .items[0]!;
  const room = await request.post("/api/v1/rooms", {
    headers: auth,
    data: { name: `Live summary room ${id}`, property_id: property.id },
  });
  const roomId = ((await room.json()) as { id: string }).id;
  const box = await request.post("/api/v1/containers", {
    headers: auth,
    data: { room_id: roomId, container_type: "box", name: `Live summary box ${id}` },
  });
  const boxId = ((await box.json()) as { id: string }).id;
  const nested = await request.post("/api/v1/containers", {
    headers: auth,
    data: { room_id: roomId, parent_id: boxId, container_type: "box", name: `Nested ${id}` },
  });
  const nestedId = ((await nested.json()) as { id: string }).id;
  const tools = await request.post("/api/v1/categories", {
    headers: auth,
    data: { name: `Tools ${id}` },
  });
  const toolsId = ((await tools.json()) as { id: string }).id;
  const gear = await request.post("/api/v1/categories", {
    headers: auth,
    data: { name: `Gear ${id}` },
  });
  const gearId = ((await gear.json()) as { id: string }).id;
  const first = await request.post("/api/v1/items", {
    headers: auth,
    data: {
      name: `Live drill ${id}`,
      room_id: roomId,
      storage_location_id: boxId,
      category_id: toolsId,
      quantity: 3,
    },
  });
  const firstId = ((await first.json()) as { item: { id: string } }).item.id;
  await request.post("/api/v1/items", {
    headers: auth,
    data: {
      name: `Live gloves ${id}`,
      room_id: roomId,
      storage_location_id: nestedId,
      category_id: gearId,
      quantity: 2,
    },
  });

  await page.goto(`/containers/${boxId}`);
  await expect(page.getByRole("heading", { name: /Inside/ })).toBeVisible();
  const summary = page.getByText(/nested units/).locator("..");
  await expect(summary).toContainText(`2 items · 5 nested units`);
  await expect(summary).toContainText(`1 item · 3 directly here`);
  await expect(summary).toContainText(`Tools ${id} · 1`);
  await expect(summary).toContainText(`Gear ${id} · 1`);
  await fs.mkdir("../../docs/walkthrough/simplification", { recursive: true });
  await page.getByRole("heading", { name: /Inside/ }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "../../docs/walkthrough/simplification/01-container-live-summary.png",
    fullPage: false,
  });

  const quantity = await request.patch(`/api/v1/items/${firstId}`, {
    headers: auth,
    data: { quantity: 5 },
  });
  expect(quantity.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByText(/nested units/).locator("..")).toContainText(
    `2 items · 7 nested units`,
  );

  const moved = await request.patch(`/api/v1/items/${firstId}`, {
    headers: auth,
    data: { storage_location_id: null, room_id: roomId },
  });
  expect(moved.ok()).toBeTruthy();
  await page.reload();
  const movedSummary = page.getByText(/nested units/).locator("..");
  await expect(movedSummary).toContainText(`1 item · 2 nested units`);
  await expect(movedSummary).toContainText(`0 items · 0 directly here`);
  await expect(movedSummary).not.toContainText(`Tools ${id} · 1`);
  await expect(page.getByRole("button", { name: "Regenerate" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "AI headline" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit summary" })).toHaveCount(0);
  await expect(page.getByText(/summary no longer matches/)).toHaveCount(0);
});
