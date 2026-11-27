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

async function expectSmartAdd(page: Page, layout: "dialog" | "sheet" = "dialog") {
  const dialog = page.getByRole("dialog", { name: "Add items" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Add items" })).toBeVisible();
  const textbox = dialog.getByRole("textbox", { name: "Describe items or paste a product link" });
  if (layout === "sheet") {
    // The phone sheet does not open the keyboard by itself: focus waits on the title.
    await expect(dialog.getByRole("heading", { name: "Add items" })).toBeFocused();
    await expect(textbox).not.toBeFocused();
  } else {
    await expect(textbox).toBeFocused();
  }
  await expect(dialog.getByRole("button", { name: "Take photo" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Choose photo" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Record voice note" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Review items" })).toBeDisabled();
  await expect(
    dialog.getByRole("link", { name: "or fill in the form yourself" }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Enter manually/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Describe or show/ })).toHaveCount(0);
  return dialog;
}

test("unified Add items input detects input kinds and preserves context", async ({
  page,
  browser,
  request,
}) => {
  const suffix = Date.now().toString().slice(-6);
  const room = await createRoom(request, `Add items room ${suffix}`);
  const container = await createContainer(request, room.id, `Add items box ${suffix}`);
  const shelf = await createLocation(request, room.id, `Add items shelf ${suffix}`);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  // "/" opens the item list. Add is the round button in the bottom bar.
  await expect(page).toHaveURL(/\/items$/);
  const sidebarAdd = page.getByTestId("bottom-bar").getByRole("button", { name: "Add items", exact: true });
  await expect(sidebarAdd).toBeVisible();
  await sidebarAdd.click();
  let dialog = await expectSmartAdd(page);
  const textbox = dialog.getByRole("textbox", {
    name: "Describe items or paste a product link",
  });
  await textbox.fill("Two camping chairs");
  await expect(dialog.getByText("Text", { exact: true })).toBeVisible();
  await textbox.fill("https://shop.example/osprey");
  await expect(dialog.getByText("Link", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Record voice note" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/items$/);
  await expect(sidebarAdd).toBeFocused();

  await sidebarAdd.click();
  await (await expectSmartAdd(page))
    .getByRole("link", { name: "or fill in the form yourself" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/items\/new(\?property_id=[^&]+)?$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/items$/);

  await page.goto(`/containers/${container.id}`);
  await expect(
    page.getByRole("heading", { name: container.identifier, level: 1, exact: true }),
  ).toBeVisible();
  const containerAdd = page.getByTestId("bottom-bar").getByRole("button", { name: "Add items", exact: true });
  await containerAdd.click();
  dialog = await expectSmartAdd(page);
  await expect(
    dialog.getByRole("button", {
      name: new RegExp(`Place: ${room.name} · ${container.identifier}`),
    }),
  ).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Describe items or paste a product link" })
    .fill(`- Context import item ${suffix}`);
  await page.keyboard.press("ControlOrMeta+Enter");
  // The capture is reviewed inline in the assistant panel on the same page.
  await expect(page).toHaveURL(new RegExp(`/containers/${container.id}#assistant$`));
  await expect(page.getByRole("dialog", { name: "Add items" })).toHaveCount(0);
  const inlineReview = page.getByTestId("assistant-panel").getByLabel("Assistant capture status").last();
  await expect(inlineReview.getByRole("region", { name: "Assistant item review" })).toBeVisible();
  const contextBatchId = await inlineReview.getAttribute("data-capture-id");
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

  await page.goto(`/add-items?room_id=${room.id}&location_id=${container.id}`);
  await expect(page).toHaveURL(/\/items$/);
  dialog = await expectSmartAdd(page);
  await expect(
    dialog.getByRole("button", {
      name: new RegExp(`Place: ${room.name} · ${container.identifier}`),
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // An empty room has its own "Add items" button too; this is the one in the bottom bar.
  await page.goto(`/rooms/${room.id}?location_id=${shelf.id}`);
  await page.getByTestId("bottom-bar").getByRole("button", { name: "Add items", exact: true }).click();
  dialog = await expectSmartAdd(page);
  await dialog.getByRole("button", { name: /^Place:/ }).click();
  const picker = dialog.getByRole("group", { name: "Where are these items?" });
  await expect(picker.getByRole("combobox", { name: "Room", exact: true })).toHaveValue(room.id);
  await expect(picker.getByRole("combobox", { name: "Place", exact: true })).toHaveValue(shelf.id);
  await picker.getByRole("button", { name: "Done" }).click();
  await dialog.getByRole("link", { name: "or fill in the form yourself" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/items/new\\?(?:property_id=[^&]+&)?room_id=${room.id}&location_id=${shelf.id}`),
  );

  const mobile = await browser.newContext({
    viewport: { width: 393, height: 852 },
    storageState: await page.context().storageState(),
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto("/");
  await mobilePage.getByRole("button", { name: "Add items", exact: true }).first().click();
  const sheet = await expectSmartAdd(mobilePage, "sheet");
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox).not.toBeNull();
  expect(Math.round((sheetBox?.y ?? 0) + (sheetBox?.height ?? 0))).toBeGreaterThanOrEqual(851);
  expect(Math.round(sheetBox?.width ?? 0)).toBe(393);
  await mobilePage.keyboard.press("Escape");
  await expect(mobilePage.getByRole("dialog")).toHaveCount(0);
  await mobilePage.goto("/items");
  await mobilePage.getByRole("button", { name: "Add items", exact: true }).click();
  await (await expectSmartAdd(mobilePage, "sheet"))
    .getByRole("link", { name: "or fill in the form yourself" })
    .click();
  await expect(mobilePage).toHaveURL(/\/items\/new/);
  await mobile.close();
});

test("corrections of a review row are kept across a reload without Skip or Add", async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID().slice(0, 6);
  const room = await createRoom(request, `Kept draft room ${suffix}`);
  const read = `Kept draft widget ${suffix}`;
  const corrected = `Kept draft lamp ${suffix}`;
  const created = await request.post("/api/v1/imports", {
    multipart: { text: `- ${read}`, title: `Kept draft ${suffix}`, room_id: room.id },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const batchId = ((await created.json()) as { id: string }).id;
  const stored = async () => {
    const detail = (await (await request.get(`/api/v1/imports/${batchId}`)).json()) as {
      status: string;
      entries: Array<{ status: string; proposed: { name: string; quantity: number } }>;
    };
    return detail;
  };
  await expect.poll(async () => (await stored()).status, { timeout: 30_000 }).toBe("review");
  expect((await stored()).entries).toHaveLength(1);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/imports/${batchId}`);
  const row = page.getByRole("article", { name: read, exact: true });
  await expect(row.getByRole("checkbox", { name: `Select ${read}` })).not.toBeChecked();
  // A value of a closed row is changed in the bar at the foot of the page.
  const editor = page.getByTestId("bar-editor");
  await row.getByRole("button", { name: `Edit name of ${read}` }).click();
  await editor.getByRole("textbox", { name: `Name of ${read}` }).fill(corrected);
  await editor.getByRole("button", { name: "Save name" }).click();
  await expect(editor).toHaveCount(0);
  const correctedRow = page.getByRole("article", { name: corrected, exact: true });
  await correctedRow.getByRole("button", { name: `Edit quantity of ${corrected}` }).click();
  await editor.getByRole("textbox", { name: `Quantity of ${corrected}` }).fill("2");
  await editor.getByRole("button", { name: "Save quantity" }).click();
  await expect(editor).toHaveCount(0);
  await expect(correctedRow.getByRole("button", { name: `Edit quantity of ${corrected}` })).toHaveText("×2");

  // The corrections are kept by themselves: no Skip, no Add, no Save button. The row
  // still waits, and nothing is in the inventory yet.
  await expect
    .poll(async () => {
      const entry = (await stored()).entries[0]!;
      return [entry.status, entry.proposed.name, entry.proposed.quantity];
    })
    .toEqual(["proposed", corrected, 2]);
  const listed = async () =>
    ((await (await request.get(`/api/v1/items?q=${encodeURIComponent(corrected)}`)).json()) as {
      total: number;
      items: Array<{ name: string; quantity: number; room: { id: string } | null }>;
    });
  expect((await listed()).total).toBe(0);

  await page.reload();
  await expect(correctedRow).toBeVisible();
  await expect(page.getByRole("article", { name: read, exact: true })).toHaveCount(0);
  await expect(correctedRow.getByRole("button", { name: `Edit name of ${corrected}` })).toHaveText(corrected);
  await expect(correctedRow.getByRole("button", { name: `Edit quantity of ${corrected}` })).toHaveText("×2");
  await expect(correctedRow.getByRole("checkbox", { name: `Select ${corrected}` })).not.toBeChecked();
  await expect(page.getByText("Your corrections are not saved yet. Trying again.")).toHaveCount(0);

  // The row is added as it was corrected before the reload.
  await correctedRow.getByRole("button", { name: "Add item", exact: true }).click();
  await expect.poll(async () => (await listed()).total).toBe(1);
  const item = (await listed()).items[0]!;
  expect([item.name, item.quantity, item.room?.id]).toEqual([corrected, 2, room.id]);
});
