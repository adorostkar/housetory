import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

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

// A text import with one row, read without AI, ready for review.
async function oneRowImport(request: APIRequestContext, name: string, roomId: string) {
  const created = await request.post("/api/v1/imports", {
    multipart: { text: `- ${name}`, title: `Review of ${name}`, room_id: roomId },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const batchId = ((await created.json()) as { id: string }).id;
  const stored = async () =>
    (await (await request.get(`/api/v1/imports/${batchId}`)).json()) as {
      status: string;
      entries: Array<{ status: string; proposed: { name: string; quantity: number } }>;
    };
  await expect.poll(async () => (await stored()).status, { timeout: 30_000 }).toBe("review");
  return { batchId, stored };
}

// Makes every request that keeps a draft fail in the browser, as it can while a page
// closes. It is switched on and off with a flag that outlives a reload. A request
// sent while the page closes is not seen by `page.route`, so the page itself is told.
async function loseDraftRequests(page: Page) {
  await page.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/\/draft$/.test(new URL(url, location.href).pathname) && sessionStorage.getItem("e2e-lose-drafts")) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return real(input, init);
    };
  });
}
const setLosing = (page: Page, lose: boolean) =>
  page.evaluate((on) => {
    if (on) sessionStorage.setItem("e2e-lose-drafts", "1");
    else sessionStorage.removeItem("e2e-lose-drafts");
  }, lose);

const localCopies = (page: Page) =>
  page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith("housetory:review-draft:v2:")),
  );

async function correctName(page: Page, from: string, to: string) {
  const editor = page.getByTestId("bar-editor");
  await page
    .getByRole("article", { name: from, exact: true })
    .getByRole("button", { name: `Edit name of ${from}` })
    .click();
  await editor.getByRole("textbox", { name: `Name of ${from}` }).fill(to);
  await editor.getByRole("button", { name: "Save name" }).click();
  await expect(editor).toHaveCount(0);
}

test("a correction whose request was lost is back after a reload, and the row still waits", async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID().slice(0, 6);
  const room = await createRoom(request, `Lost save room ${suffix}`);
  const read = `Lost save widget ${suffix}`;
  const corrected = `Lost save lamp ${suffix}`;
  const { batchId, stored } = await oneRowImport(request, read, room.id);

  // Every request that keeps a draft is lost, as it can be while a page closes.
  await loseDraftRequests(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/imports/${batchId}`);
  await setLosing(page, true);
  await correctName(page, read, corrected);
  // The copy is on this device at once. The page is reloaded before anything is sent.
  expect(await localCopies(page)).toHaveLength(1);
  await page.reload();

  // The correction is back in its row. The row still waits: nothing was added.
  const row = page.getByRole("article", { name: corrected, exact: true });
  await expect(row).toBeVisible();
  await expect(page.getByRole("article", { name: read, exact: true })).toHaveCount(0);
  await expect(row.getByRole("checkbox", { name: `Select ${corrected}` })).not.toBeChecked();
  await expect(row.getByRole("button", { name: "Add item", exact: true })).toBeEnabled();
  // The server still does not have it, and the page says so in one quiet line.
  await expect(page.getByText("Your corrections are not saved yet. Trying again.")).toBeVisible();
  expect((await stored()).entries[0]!.proposed.name).toBe(read);
  expect(await localCopies(page)).toHaveLength(1);

  // When requests go through again, it is sent by itself and the copy is removed.
  await setLosing(page, false);
  await expect
    .poll(async () => {
      const entry = (await stored()).entries[0]!;
      return [entry.status, entry.proposed.name];
    }, { timeout: 20_000 })
    .toEqual(["proposed", corrected]);
  await expect.poll(() => localCopies(page)).toEqual([]);
  await expect(page.getByText("Your corrections are not saved yet. Trying again.")).toHaveCount(0);
  const items = await (await request.get(`/api/v1/items?q=${encodeURIComponent(corrected)}`)).json();
  expect(items.total).toBe(0);
});

// Two devices on one import review. The first one corrects a row while its requests
// are lost, so the correction is only on that device. The second one, a browser of
// its own with its own storage, corrects the same row and that is saved. Then the
// first one is reloaded.
async function twoDevices(page: Page, browser: Browser, request: APIRequestContext, label: string) {
  const suffix = crypto.randomUUID().slice(0, 6);
  const room = await createRoom(request, `${label} room ${suffix}`);
  const read = `${label} widget ${suffix}`;
  const here = `${label} from the phone ${suffix}`;
  const elsewhere = `${label} from the laptop ${suffix}`;
  const { batchId, stored } = await oneRowImport(request, read, room.id);

  await loseDraftRequests(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/imports/${batchId}`);
  await setLosing(page, true);
  await correctName(page, read, here);
  expect(await localCopies(page)).toHaveLength(1);
  expect((await stored()).entries[0]!.proposed.name).toBe(read);

  const laptop = await browser.newContext({
    baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 1000 },
  });
  const login = await laptop.request.post("/api/v1/auth/login", {
    data: {
      email: process.env.E2E_EMAIL ?? "phase5@example.com",
      password: process.env.E2E_PASSWORD ?? "phase-five-password-2026",
    },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const other = await laptop.newPage();
  await other.goto(`/imports/${batchId}`);
  await correctName(other, read, elsewhere);
  await expect.poll(async () => (await stored()).entries[0]!.proposed.name, { timeout: 20_000 }).toBe(elsewhere);
  await laptop.close();

  // The first device is opened again. Its own request is still lost.
  await page.reload();
  // The row shows what the server has. The correction of this device is not lost and
  // is not sent over it: it waits in one plain notice beside the row.
  const row = page.getByRole("article", { name: elsewhere, exact: true });
  await expect(row).toBeVisible();
  await expect(page.getByRole("article", { name: here, exact: true })).toHaveCount(0);
  const notice = page.getByRole("group", { name: "Two corrections" });
  await expect(notice.getByRole("status")).toHaveText(
    `This row was also corrected on another device. Yours: «${here}», quantity 1.`,
  );
  // Requests go through again now. Nothing is sent by itself.
  await setLosing(page, false);
  await page.waitForTimeout(1500);
  expect((await stored()).entries[0]!.proposed.name).toBe(elsewhere);
  expect(await localCopies(page)).toHaveLength(1);
  await expect(page.getByText("Your corrections are not saved yet. Trying again.")).toHaveCount(0);
  return { here, elsewhere, stored, notice };
}

test("two devices correct one row: the older correction waits beside the row, and \"Use mine\" saves it", async ({
  page,
  browser,
  request,
}) => {
  const { here, stored, notice } = await twoDevices(page, browser, request, "Use mine");
  await notice.getByRole("button", { name: "Use mine" }).click();
  // The correction of this device is in the row and on the server. The row still
  // waits: it was not selected and nothing was added.
  const row = page.getByRole("article", { name: here, exact: true });
  await expect(row).toBeVisible();
  await expect
    .poll(async () => {
      const entry = (await stored()).entries[0]!;
      return [entry.status, entry.proposed.name];
    }, { timeout: 20_000 })
    .toEqual(["proposed", here]);
  await expect(notice).toHaveCount(0);
  await expect.poll(() => localCopies(page)).toEqual([]);
  await expect(row.getByRole("checkbox", { name: `Select ${here}` })).not.toBeChecked();
  const items = await (await request.get(`/api/v1/items?q=${encodeURIComponent(here)}`)).json();
  expect(items.total).toBe(0);
});

test("two devices correct one row: \"Keep the other\" drops the older correction and sends nothing", async ({
  page,
  browser,
  request,
}) => {
  const { elsewhere, stored, notice } = await twoDevices(page, browser, request, "Keep other");
  await notice.getByRole("button", { name: "Keep the other" }).click();
  await expect(notice).toHaveCount(0);
  expect(await localCopies(page)).toEqual([]);
  await page.waitForTimeout(1500);
  const entry = (await stored()).entries[0]!;
  expect([entry.status, entry.proposed.name]).toEqual(["proposed", elsewhere]);
  // After another reload the row is still the other device's, with no notice.
  await page.reload();
  await expect(page.getByRole("article", { name: elsewhere, exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Two corrections" })).toHaveCount(0);
});

test("signing out removes the copies of corrections on this device", async ({ page, browser, request }) => {
  const suffix = crypto.randomUUID().slice(0, 6);
  const room = await createRoom(request, `Sign-out room ${suffix}`);
  const read = `Sign-out widget ${suffix}`;
  const { batchId } = await oneRowImport(request, read, room.id);

  // A session of its own, so that signing out does not end the one the other tests use.
  const origin = new URL(page.url() === "about:blank" ? test.info().project.use.baseURL! : page.url()).origin;
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 } });
  const login = await context.request.post("/api/v1/auth/login", {
    data: {
      email: process.env.E2E_EMAIL ?? "phase5@example.com",
      password: process.env.E2E_PASSWORD ?? "phase-five-password-2026",
    },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const own = await context.newPage();
  await loseDraftRequests(own);
  await own.goto(`/imports/${batchId}`);
  await setLosing(own, true);
  await correctName(own, read, `Sign-out lamp ${suffix}`);
  expect(await localCopies(own)).toHaveLength(1);

  await own.goto("/settings");
  // The copy is still there after leaving the review: the server never confirmed it.
  expect(await localCopies(own)).toHaveLength(1);
  await own.getByRole("main").getByRole("button", { name: "Sign out" }).click();
  await expect(own).toHaveURL(/\/login/);
  expect(await localCopies(own)).toEqual([]);
  await context.close();
});
