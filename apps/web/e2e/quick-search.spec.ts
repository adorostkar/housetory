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
    name: string;
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
  return (await response.json()) as { id: string; name: string; room_id: string };
}

async function createItem(
  request: APIRequestContext,
  payload: Record<string, unknown>,
) {
  const response = await request.post("/api/v1/items", { data: payload });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

async function createLegacyContainer(
  request: APIRequestContext,
  legacyId: string,
  roomName: string,
  itemName: string,
) {
  const markdown = `# Quick search fixture\n\n## Box list\n\n### ${legacyId} (${roomName})\n- ${itemName}\n`;
  const created = await request.post("/api/v1/imports", {
    multipart: {
      title: `Quick search legacy ${legacyId}`,
      file: {
        name: "quick-search.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(markdown),
      },
    },
  });
  expect(created.status()).toBe(201);
  const batch = (await created.json()) as { id: string };
  await expect
    .poll(async () => {
      const response = await request.get(`/api/v1/imports/${batch.id}`);
      return ((await response.json()) as { status: string }).status;
    })
    .toBe("review");
  const detail = (await (
    await request.get(`/api/v1/imports/${batch.id}`)
  ).json()) as {
    entries: Array<{
      id: string;
      entity_type: string;
      parent_entry_id: string | null;
      legacy_identifier: string | null;
    }>;
  };
  const applied = await request.post(`/api/v1/imports/${batch.id}/apply`, {
    data: {
      entries: detail.entries.map((entry) => ({
        id: entry.id,
        action: "import",
        entity_type: entry.entity_type,
        parent_entry_id: entry.parent_entry_id,
        legacy_identifier: entry.legacy_identifier,
      })),
    },
  });
  expect(applied.ok()).toBeTruthy();
  const containers = (await (
    await request.get(`/api/v1/containers?q=${encodeURIComponent(legacyId)}`)
  ).json()) as { items: Array<{ id: string; identifier: string }> };
  expect(containers.items[0]).toBeTruthy();
  return containers.items[0];
}

async function focusQuickSearch(page: Page) {
  const input = page.getByRole("combobox", { name: "Search or ask about your inventory" }).first();
  await expect(input).toBeVisible();
  await input.click();
  return input;
}

test("desktop sidebar and mobile overview quick search find and open records", async ({
  page,
  browser,
  request,
}) => {
  const suffix = Date.now().toString().slice(-6);
  const room = await createRoom(request, `Quick search room ${suffix}`);
  const container = await createContainer(request, room.id, `Toolbox ${suffix}`);
  const shelf = await createLocation(request, room.id, `Top shelf ${suffix}`);
  const camera = await createItem(request, {
    name: `Camera ${suffix}`,
    brand: "Acme",
    model: "C-1",
    room_id: room.id,
    storage_location_id: container.id,
  });
  const passport = await createItem(request, {
    name: `Passport ${suffix}`,
    room_id: room.id,
    storage_location_id: shelf.id,
  });
  const legacyId = `QSR-${Date.now() % 10000}`;
  const legacyContainer = await createLegacyContainer(
    request,
    legacyId,
    `Legacy room ${suffix}`,
    `Legacy item ${suffix}`,
  );

  await page.goto("/");
  const addItem = page.locator("aside").getByRole("button", { name: "Add items" });
  const sidebarInput = page
    .locator("aside")
    .getByRole("combobox", { name: "Search or ask about your inventory" });
  await expect(addItem).toBeVisible();
  await expect(sidebarInput).toBeVisible();
  const addBox = await addItem.boundingBox();
  const inputBox = await sidebarInput.boundingBox();
  expect(addBox && inputBox && inputBox.y >= addBox.y + addBox.height).toBeTruthy();

  await sidebarInput.click();
  await sidebarInput.fill(`Camera ${suffix}`);
  const panel = page.getByRole("listbox", { name: "Quick search results" });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("option", { name: new RegExp(`Camera ${suffix}`) }),
  ).toBeVisible();
  await expect(panel.getByText("Owned items", { exact: true })).toBeVisible();
  await expect(panel.getByText(room.name, { exact: false })).toBeVisible();

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/items/${camera.item.id}`));

  await page.goto("/");
  const identifierInput = await focusQuickSearch(page);
  await identifierInput.fill(container.identifier);
  await expect(
    page.getByRole("option", { name: new RegExp(`^${container.identifier}`) }),
  ).toBeVisible();
  await page.getByRole("option", { name: new RegExp(`^${container.identifier}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/containers/${container.id}`));

  await page.goto("/");
  const locationInput = await focusQuickSearch(page);
  await locationInput.fill(shelf.name);
  await page
    .getByRole("option", { name: new RegExp(`^${shelf.name}`) })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/rooms/${room.id}\\?location_id=${shelf.id}`),
  );

  await page.goto("/");
  const legacyInput = await focusQuickSearch(page);
  await legacyInput.fill(legacyId);
  const legacyOption = page.getByRole("option", {
    name: new RegExp(`^${legacyContainer.identifier}`),
  });
  await expect(legacyOption).toBeVisible();
  await legacyOption.click();
  await expect(page).toHaveURL(new RegExp(`/containers/${legacyContainer.id}`));

  await page.goto("/");
  const allInput = await focusQuickSearch(page);
  await allInput.fill(`Camera ${suffix}`);
  await expect(
    page.getByRole("option", { name: new RegExp(`Camera ${suffix}`) }),
  ).toBeVisible();
  await page.getByRole("button", { name: /View all results/ }).click();
  await expect(page).toHaveURL(
    new RegExp(`/search\\?q=${encodeURIComponent(`Camera ${suffix}`)}`),
  );
  await expect(
    page.getByRole("textbox", { name: "Search or ask about your inventory" }),
  ).toHaveValue(`Camera ${suffix}`);

  await page.goto(`/search?q=${encodeURIComponent(shelf.name)}`);
  await expect(
    page.getByRole("heading", { name: "Places and containers" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Matching containers and locations" })
      .getByRole("link", { name: new RegExp(shelf.name) }),
  ).toBeVisible();

  await page.goto("/");
  const escapeInput = await focusQuickSearch(page);
  await escapeInput.fill(`Passport ${suffix}`);
  await expect(page.getByRole("listbox", { name: "Quick search results" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Quick search results" })).toHaveCount(0);

  const mobile = await browser.newContext({
    viewport: { width: 393, height: 852 },
    storageState: await page.context().storageState(),
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto("/");
  const mobileInput = mobilePage.getByRole("combobox", { name: "Search or ask about your inventory" });
  await expect(mobileInput).toBeVisible();
  const purchaseSummary = mobilePage.getByText("Purchase value", { exact: true });
  const mobileInputBox = await mobileInput.boundingBox();
  const summaryBox = await purchaseSummary.boundingBox();
  expect(
    mobileInputBox && summaryBox && mobileInputBox.y < summaryBox.y,
  ).toBeTruthy();
  await mobileInput.fill(container.identifier);
  await expect(
    mobilePage.getByRole("option", { name: new RegExp(`^${container.identifier}`) }),
  ).toBeVisible();
  await mobilePage.goto("/items");
  await expect(
    mobilePage.getByRole("link", { name: "Search or ask about your inventory" }),
  ).toBeVisible();
  await mobile.close();
});
