import { expect, test, type APIRequestContext } from "@playwright/test";

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
  quantity = 1,
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

async function createTag(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/tags", { data: { name } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string };
}

async function createCategory(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/categories", { data: { name } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string };
}

test("bulk organisation selects loaded records, previews moves and updates tags/categories", async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString().slice(-6);
  const office = await createRoom(request, `Bulk office ${suffix}`);
  const garage = await createRoom(request, `Bulk garage ${suffix}`);
  const source = await createContainer(request, office.id, `Bulk source ${suffix}`);
  const destination = await createContainer(request, garage.id, `Bulk destination ${suffix}`);
  const tag = await createTag(request, `Fragile ${suffix}`);
  const category = await createCategory(request, `Electronics ${suffix}`);

  for (let index = 0; index < 25; index += 1) {
    await createItem(request, `Filler ${suffix} ${index}`, office.id, source.id);
  }
  const camera = await createItem(request, `Camera ${suffix}`, office.id, source.id, 2);
  const tent = await createItem(request, `Tent ${suffix}`, office.id, source.id, 3);
  await request.post("/api/v1/loans", {
    data: {
      item_id: camera.item.id,
      borrower_name: "Bulk browser borrower",
      quantity: 1,
      lent_on: "2026-01-01",
      request_id: crypto.randomUUID(),
    },
  });

  await page.goto(`/items?room_id=${office.id}`);
  await expect(page.getByText(`Camera ${suffix}`)).toBeVisible();
  await expect(
    page.getByText(new RegExp("Showing 24 of 27; only loaded items can be selected")),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: "Select all loaded items" }).check();
  await expect(page.getByText(/24 items selected/)).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).last().click();
  await expect(page.getByText(/items selected/)).not.toBeVisible();

  await page.getByRole("checkbox", { name: `Select Camera ${suffix}` }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByText(/1 item selected/)).toBeVisible();
  await page.getByRole("checkbox", { name: `Select Camera ${suffix}` }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByText(/items selected/)).not.toBeVisible();

  const cameraCheckbox = page.getByRole("checkbox", { name: `Select Camera ${suffix}` });
  const tentCheckbox = page.getByRole("checkbox", { name: `Select Tent ${suffix}` });
  await cameraCheckbox.check();
  await tentCheckbox.check();
  await expect(page.getByText(/2 items selected · 5 units/)).toBeVisible();
  await page.getByRole("button", { name: "Move" }).click();
  await expect(page.getByText(/2 selected item\(s\), 5 recorded unit\(s\)/)).toBeVisible();
  await expect(page.getByText(/does not return the loaned units/i)).toBeVisible();
  await page.getByLabel("Destination room").selectOption(garage.id);
  await page.getByLabel(/Storage place or container/).selectOption(destination.id);
  await page.getByRole("button", { name: "Move selected" }).click();
  await expect(page.getByText(/Moved 2 items\. Each moved item/i)).toBeVisible();
  await expect(page.getByText(/items selected/)).not.toBeVisible();

  await page.goto(`/items?room_id=${garage.id}`);
  await expect(page.getByText(`Camera ${suffix}`)).toBeVisible();
  await page.getByRole("checkbox", { name: `Select Camera ${suffix}` }).check();
  await page.getByRole("checkbox", { name: `Select Tent ${suffix}` }).check();
  await page.getByRole("button", { name: "Tags" }).click();
  await page.getByRole("button", { name: `Fragile ${suffix}` }).click();
  await page.getByRole("button", { name: "Add selected tags" }).click();
  await expect(page.getByText(/Added tags on 2 items/)).toBeVisible();

  await page.getByRole("checkbox", { name: `Select Camera ${suffix}` }).check();
  await page.getByRole("checkbox", { name: `Select Tent ${suffix}` }).check();
  await page.getByRole("button", { name: "Category" }).click();
  await page.getByLabel("Category", { exact: true }).selectOption(category.id);
  await page.getByRole("button", { name: "Apply category" }).click();
  await expect(page.getByText(/Set category on 2 items/)).toBeVisible();

  const finalItem = await (
    await request.get(`/api/v1/items/${camera.item.id}`)
  ).json();
  expect(finalItem.item.tags.map((entry: { id: string }) => entry.id)).toContain(tag.id);
  expect(finalItem.item.category?.id).toBe(category.id);

  await page.getByRole("button", { name: "Compact list view" }).click();
  await expect(page.getByRole("button", { name: "Compact list view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await page.evaluate(() => localStorage.getItem("housetory.items.view"))).toBe(
    "list",
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Compact list view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText(`Camera ${suffix}`)).toBeVisible();
  await expect(page.getByText(/1 on loan · 1 at home/).first()).toBeVisible();
});
