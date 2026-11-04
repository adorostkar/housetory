import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

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
  return (await response.json()) as { id: string; identifier: string };
}

async function createItem(
  request: APIRequestContext,
  name: string,
  roomId: string,
  locationId: string | null,
  quantity: number,
) {
  const response = await request.post("/api/v1/items", {
    data: {
      name,
      room_id: roomId,
      quantity,
      ...(locationId ? { storage_location_id: locationId } : {}),
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string } };
}

async function undoFirstMatching(page: Page, text: string) {
  const item = page.locator("li").filter({ hasText: text }).first();
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: "Undo safely" }).click();
}

test("lends partially, records returns, shows it on the loans list and undoes a return", async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString().slice(-6);
  const borrower = `E2E Borrower ${suffix}`;
  const office = await createRoom(request, `Lending office ${suffix}`);
  const container = await createContainer(request, office.id, `Lending box ${suffix}`);
  const item = await createItem(
    request,
    `Projector ${suffix}`,
    office.id,
    container.id,
    3,
  );

  await page.goto(`/items/${item.item.id}`);
  await page.getByRole("button", { name: "Lend" }).first().click();
  await page.getByLabel("Borrower").fill(borrower);
  await page.getByLabel("Quantity").fill("2");
  await page.getByLabel("Lent on").fill("2026-01-01");
  await page.getByLabel("Due back").fill("2026-01-10");
  await page.getByRole("button", { name: /Record loan/ }).click();
  await expect(page.getByText(/on loan 2/i).first()).toBeVisible();
  await expect(page.getByText(/at home 1/i).first()).toBeVisible();

  await page.goto("/loans");
  await expect(page.getByText(borrower)).toBeVisible();
  await expect(page.getByText("Past due").first()).toBeVisible();
  await expect(page.getByRole("link", { name: `Projector ${suffix}` })).toBeVisible();
  await page.getByRole("link", { name: borrower, exact: true }).click();

  await page.getByRole("button", { name: "Record return" }).click();
  await page.getByLabel("Quantity").fill("1");
  await page.getByRole("button", { name: /Record return/ }).click();
  await expect(page.getByRole("heading", { name: "1 of 2 still out" })).toBeVisible();
  await expect(page.getByText("Partially returned")).toBeVisible();

  await page.goto(`/items/${item.item.id}`);
  await undoFirstMatching(
    page,
    `Returned 1 of 2 × Projector ${suffix} from ${borrower}`,
  );
  await expect(page.getByText(/on loan 2/i).first()).toBeVisible();
});

test("item and container move history can be undone from the UI", async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString().slice(-6);
  const office = await createRoom(request, `Move office ${suffix}`);
  const garage = await createRoom(request, `Move garage ${suffix}`);
  const container = await createContainer(request, office.id, `Move box ${suffix}`);
  const item = await createItem(
    request,
    `Lantern ${suffix}`,
    office.id,
    container.id,
    2,
  );

  await request.patch(`/api/v1/items/${item.item.id}`, {
    data: { room_id: garage.id, storage_location_id: null },
  });
  await page.goto(`/items/${item.item.id}`);
  await undoFirstMatching(page, "Moved Lantern");
  await expect(page.getByRole("link", { name: office.name }).first()).toBeVisible();

  await request.post(`/api/v1/containers/${container.id}/move`, {
    data: { room_id: garage.id, parent_id: null },
  });
  await page.goto(`/containers/${container.id}`);
  await expect(page.getByText(/Movement history/i)).toBeVisible();
  await expect(page.getByText(/moved with it/i).first()).toBeVisible();
  await undoFirstMatching(page, "Moved container");
  await expect(page.getByRole("link", { name: office.name }).first()).toBeVisible();
});
