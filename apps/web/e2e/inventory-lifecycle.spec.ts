import { expect, test, type APIRequestContext } from "@playwright/test";

async function createRoom(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/rooms", { data: { name } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
}

async function createItem(
  request: APIRequestContext,
  extra: { name: string } & Record<string, unknown>,
) {
  const response = await request.post("/api/v1/items", { data: extra });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

test("duplicate creates an independent unit and disposition preserves restorable history", async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString().slice(-7);
  const room = await createRoom(request, `Lifecycle room ${suffix}`);
  const source = await createItem(request, {
    name: `Lifecycle backpack ${suffix}`,
    brand: "Osprey",
    model: "Jet 18",
    serial_number: `SERIAL-${suffix}`,
    quantity: 2,
    room_id: room.id,
    purchase: {
      merchant: "Outdoor shop",
      price_cents: 6500,
      currency: "EUR",
    },
  });

  await page.goto(`/items/${source.item.id}`);
  await page.getByRole("button", { name: "Item options" }).click();
  await page.getByRole("menuitem", { name: "Duplicate item" }).click();
  await expect(page).toHaveURL(/\/items\/new\?duplicate_of=/);
  await expect(page.getByLabel("Item name")).toHaveValue(`Lifecycle backpack ${suffix}`);
  await expect(page.getByLabel("Quantity")).toHaveValue("1");
  await page.getByRole("button", { name: /Identity & organisation/ }).click();
  await expect(page.getByLabel(/^Serial number/)).toHaveValue("");
  await page.getByRole("button", { name: "Add to your home" }).click();
  await expect(page).toHaveURL(new RegExp(`/items/(?!${source.item.id})[0-9a-f-]+`));
  await expect(page.getByRole("heading", { name: `Lifecycle backpack ${suffix}` })).toBeVisible();

  const duplicateUrl = page.url();
  const duplicateId = duplicateUrl.split("/items/")[1]!.split(/[?/]/)[0]!;
  expect(duplicateId).not.toBe(source.item.id);

  await page.getByRole("button", { name: "Item options" }).click();
  await page.getByRole("menuitem", { name: "Mark as no longer owned" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("What happened?").selectOption("given_away");
  await dialog.getByLabel(/^Note/).fill("Given to a friend");
  await dialog.getByRole("button", { name: "Mark as no longer owned" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Given away", { exact: true }).first()).toBeVisible();

  const disposed = await request.get(`/api/v1/items/${duplicateId}`);
  expect(disposed.ok()).toBeTruthy();
  expect((await disposed.json()).item).toMatchObject({
    is_archived: true,
    disposition: "given_away",
    disposition_note: "Given to a friend",
  });

  await page.getByRole("button", { name: "Item options" }).click();
  const restoreResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/v1/items/${duplicateId}`) &&
      response.request().method() === "PATCH" &&
      response.ok(),
  );
  await page.getByRole("menuitem", { name: "Restore item" }).click();
  await restoreResponse;
  const restored = await request.get(`/api/v1/items/${duplicateId}`);
  expect((await restored.json()).item).toMatchObject({
    is_archived: false,
    disposition: null,
    disposed_on: null,
    disposition_note: null,
  });
});
