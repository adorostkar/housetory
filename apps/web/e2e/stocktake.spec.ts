import fs from "node:fs/promises";

import { expect, test, type APIRequestContext } from "@playwright/test";

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createRoom(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/rooms", { data: { name } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
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
      storage_location_id: locationId,
      quantity,
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

async function createLoan(request: APIRequestContext, itemId: string) {
  const response = await request.post("/api/v1/loans", {
    data: {
      item_id: itemId,
      borrower_name: "Private Borrower",
      quantity: 1,
      lent_on: "2026-01-01",
      notes: "Private loan note not for stocktake summaries",
      request_id: crypto.randomUUID(),
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function startViaUi(page: import("@playwright/test").Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await page.getByRole("button", { name: "Start stocktake" }).click();
  await expect(page).toHaveURL(/\/stocktake\//);
}

test("checks a room, resumes after refresh, reviews a move and completes partial coverage", async ({
  page,
  request,
}) => {
  await fs.mkdir("../../docs/walkthrough/stocktake", { recursive: true });
  const id = suffix();
  const room = await createRoom(request, `Stocktake room ${id}`);
  const garage = await createRoom(request, `Stocktake garage ${id}`);
  const box = await createContainer(request, room.id, `Gear box ${id}`);
  const garageShelf = await createContainer(request, garage.id, `Shelf ${id}`);
  const drill = await createItem(request, `Drill ${id}`, room.id, box.id, 3);
  const tent = await createItem(request, `Tent ${id}`, room.id, box.id, 1);
  const rope = await createItem(request, `Rope ${id}`, room.id, box.id, 1);
  await createItem(request, `Unchecked lamp ${id}`, room.id, box.id, 1);
  await createLoan(request, drill.item.id);

  await startViaUi(page, room.id);
  await expect(page.getByRole("heading", { name: `Room: ${room.name}` })).toBeVisible();
  await expect(page.getByText(/Opening this page does not mark it present/).first()).toBeVisible();

  await page.getByRole("button", { name: `Mark ${drill.item.name} present` }).click();
  const drillDialog = page.getByRole("dialog");
  await expect(drillDialog.getByText(/At home 2/)).toBeVisible();
  await expect(drillDialog.getByText(/Loans excluded/)).toBeVisible();
  await drillDialog.getByRole("button", { name: "Save present" }).click();
  await expect(drillDialog).not.toBeVisible();

  await page.getByRole("button", { name: `Mark ${tent.item.name} missing` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save missing" }).click();
  await expect(page.getByText("Reported missing; no inventory deletion or write-off.")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: `Room: ${room.name}` })).toBeVisible();
  await expect(page.getByText("Reported missing; no inventory deletion or write-off.")).toBeVisible();
  await page.getByRole("button", { name: /^Unchecked/ }).click();
  await expect(page.getByRole("button", { name: /^Unchecked/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.reload();
  await expect(page.getByRole("button", { name: /^Unchecked/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: /^All/ }).click();

  await page.getByRole("button", { name: `Mark ${rope.item.name} moved` }).click();
  const moveDialog = page.getByRole("dialog");
  await moveDialog.getByLabel("Existing room").selectOption(garage.id);
  await moveDialog.getByLabel("Existing place (optional)").selectOption(garageShelf.id);
  await moveDialog.getByRole("button", { name: "Save moved" }).click();
  await expect(moveDialog).not.toBeVisible();

  await page.waitForTimeout(4200);
  await page.getByRole("button", { name: "Review changes" }).click();
  const reviewDialog = page.getByRole("dialog");
  const movedPath = `${garage.name} / ${garageShelf.identifier} · ${garageShelf.name}`;
  await expect(reviewDialog.getByText(movedPath).first()).toBeVisible();
  await expect(reviewDialog.getByText(/Recorded location will change/)).toBeVisible();
  await reviewDialog.getByText("Review proposed corrections").waitFor();
  await page.waitForTimeout(700);
  await page.screenshot({
    path: "../../docs/walkthrough/stocktake/00-review-desktop-light.png",
    fullPage: false,
  });
  await reviewDialog.getByRole("button", { name: "Apply corrections" }).click();
  await expect(reviewDialog).not.toBeVisible();
  await expect(page.getByText("Correction applied")).toBeVisible();
  await page.waitForTimeout(4200);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "../../docs/walkthrough/stocktake/02-checklist-mobile.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole("button", { name: "Finish" }).click();
  const finishDialog = page.getByRole("dialog");
  await expect(finishDialog.getByText("This is a partial stocktake.")).toBeVisible();
  await finishDialog
    .getByRole("checkbox", { name: /I understand this records partial coverage/ })
    .check();
  await finishDialog.getByRole("button", { name: "Complete stocktake" }).click();
  await expect(page.getByText("Completed · partial")).toBeVisible();
  await page.waitForTimeout(4200);

  const itemResponse = await request.get(`/api/v1/items/${rope.item.id}`);
  expect(itemResponse.ok()).toBeTruthy();
  const itemBody = (await itemResponse.json()) as {
    item: {
      room: { id: string };
      location: { id: string };
      last_verified: {
        status: string;
        location_id: string;
        quantity: number;
        stale: boolean;
      } | null;
    };
  };
  expect(itemBody.item.room.id).toBe(garage.id);
  expect(itemBody.item.location.id).toBe(garageShelf.id);
  expect(itemBody.item.last_verified?.status).toBe("moved");
  expect(itemBody.item.last_verified?.location_id).toBe(garageShelf.id);
  expect(itemBody.item.last_verified?.stale).toBe(false);

  await fs.mkdir("../../docs/walkthrough/stocktake", { recursive: true });
  const stocktakeUrl = page.url();
  await page.screenshot({
    path: "../../docs/walkthrough/stocktake/01-completed-desktop-light.png",
    fullPage: false,
  });
  await page.getByRole("link", { name: "Back to room" }).click();
  await expect(page.getByText(/Last checked/)).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/stocktake/05-room-last-checked-desktop.png",
    fullPage: false,
  });

  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "dark");
  });
  await page.goto(stocktakeUrl);
  await expect(page.getByText("Completed · partial")).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/stocktake/03-completed-desktop-dark.png",
    fullPage: false,
  });
});

test("handles keyboard close, a failed save and an abandoned stocktake on mobile", async ({
  page,
  request,
}) => {
  const id = suffix();
  const room = await createRoom(request, `Abandon room ${id}`);
  const box = await createContainer(request, room.id, `Abandon box ${id}`);
  const item = await createItem(request, `Ladder ${id}`, room.id, box.id);

  await startViaUi(page, room.id);
  await page.getByRole("button", { name: `Mark ${item.item.name} present` }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByText("Not checked yet. Opening this page does not mark it present.")).toBeVisible();

  await page.route("**/api/v1/stocktake/sessions/*/observations", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        detail: { code: "fixture_failure", message: "The observation could not be saved." },
      }),
    });
  });
  await page.getByRole("button", { name: `Mark ${item.item.name} present` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save present" }).click();
  await expect(page.getByRole("dialog").getByText("The observation could not be saved.")).toBeVisible();
  await expect(page.getByText("Not checked yet. Opening this page does not mark it present.")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await page.unrouteAll();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Stocktake options" }).click();
  await page.getByRole("menuitem", { name: "Abandon stocktake" }).click();
  const abandonDialog = page.getByRole("dialog");
  await expect(abandonDialog.getByText(/will not update last-verified dates/)).toBeVisible();
  await abandonDialog.getByRole("button", { name: "Abandon stocktake" }).click();
  await expect(page.getByText("Abandoned").first()).toBeVisible();

  const itemResponse = await request.get(`/api/v1/items/${item.item.id}`);
  const itemBody = (await itemResponse.json()) as { item: { last_verified: unknown } };
  expect(itemBody.item.last_verified).toBeNull();

  await fs.mkdir("../../docs/walkthrough/stocktake", { recursive: true });
  await page.screenshot({
    path: "../../docs/walkthrough/stocktake/04-abandoned-mobile.png",
    fullPage: false,
  });
});
