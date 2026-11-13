import { expect, test } from "@playwright/test";

test("reviewed inventory journeys use the real isolated API", async ({ page }) => {
  const credentials = { email: "stagec-browser@example.com", password: "isolated-stagec-test-password" };
  const setup = await page.request.post("/api/v1/auth/setup", {
    data: { ...credentials, name: "Synthetic reviewer", household_name: "Stage C test home" },
  });
  if (!setup.ok()) {
    const login = await page.request.post("/api/v1/auth/login", { data: credentials });
    expect(login.ok(), await login.text()).toBeTruthy();
  }
  const suffix = Date.now().toString();
  const roomName = `Kitchen ${suffix}`;
  const itemName = `Drill ${suffix}`;
  const roomResponse = await page.request.post("/api/v1/rooms", { data: { name: roomName } });
  expect(roomResponse.ok(), await roomResponse.text()).toBeTruthy();
  const room = await roomResponse.json();
  const itemResponse = await page.request.post("/api/v1/items", { data: { name: itemName, quantity: 3 } });
  expect(itemResponse.ok(), await itemResponse.text()).toBeTruthy();
  const item = (await itemResponse.json()).item;

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await input.fill(`I want to move ${itemName} to ${roomName}`);
  await dialog.getByRole("button", { name: "Send question" }).click();
  const review = dialog.getByLabel("Action review").last();
  await expect(review.getByText(itemName, { exact: true })).toBeVisible();
  await expect(review.getByText(roomName, { exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api/v1/items/${item.id}`)).json()).item.room).toBeNull();
  await page.screenshot({ path: "../../docs/assistant-stage-c-desktop.png" });
  const applyRequestIds: string[] = [];
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", async (route) => {
    applyRequestIds.push(route.request().postDataJSON().request_id as string);
    const response = await route.fetch();
    if (applyRequestIds.length === 1) {
      await route.abort("failed");
    } else {
      await route.fulfill({ response });
    }
  });
  await review.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/items/${item.id}`)).json()).item.room?.id).toBe(room.id);
  await expect(review.getByRole("button", { name: "Apply" })).toBeEnabled();
  await review.getByRole("button", { name: "Apply" }).click();
  await expect(review.getByRole("status")).toContainText("Moved");
  expect(applyRequestIds).toHaveLength(2);
  expect(applyRequestIds[1]).toBe(applyRequestIds[0]);
  expect((await (await page.request.get(`/api/v1/items/${item.id}`)).json()).item.room.id).toBe(room.id);
  await page.unroute("**/api/v1/assistant/actions/proposals/*/apply");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Assistant" }).click();
  const mobileDialog = page.getByRole("dialog");
  await mobileDialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill(`Lend 2 ${itemName} to Sam`);
  await mobileDialog.getByRole("button", { name: "Send question" }).click();
  const loanReview = mobileDialog.getByLabel("Action review").last();
  await expect(loanReview.getByText("Sam", { exact: true })).toBeVisible();
  await expect(loanReview.getByText("2", { exact: true })).toBeVisible();
  await page.screenshot({ path: "../../docs/assistant-stage-c-mobile.png" });
  await loanReview.getByRole("button", { name: "Apply" }).click();
  await expect(loanReview.getByRole("status")).toContainText("Recorded loan");
  const loans = await (await page.request.get("/api/v1/loans")).json();
  expect(loans.items.filter((loan: { item_id: string }) => loan.item_id === item.id)).toHaveLength(1);

  const mobileInput = mobileDialog.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await mobileInput.fill("Return 1 it from Sam");
  await mobileDialog.getByRole("button", { name: "Send question" }).click();
  const returnReview = mobileDialog.getByLabel("Action review").last();
  await expect(returnReview.getByText("Returned by borrower")).toBeVisible();
  await returnReview.getByRole("button", { name: "Apply" }).click();
  await expect(returnReview.getByRole("status")).toBeVisible();
  const updatedLoans = await (await page.request.get("/api/v1/loans")).json();
  expect(updatedLoans.items.find((loan: { item_id: string }) => loan.item_id === item.id).outstanding_quantity).toBe(1);

  const borrowedName = `Ladder ${suffix}`;
  await mobileInput.fill(`Borrow 2 ${borrowedName} from Alex`);
  await mobileDialog.getByRole("button", { name: "Send question" }).click();
  const borrowReview = mobileDialog.getByLabel("Action review").last();
  await expect(borrowReview.getByText(borrowedName, { exact: true })).toBeVisible();
  await borrowReview.getByRole("button", { name: "Apply" }).click();
  await expect(borrowReview.getByRole("status")).toBeVisible();
  await mobileInput.fill(`Return 1 ${borrowedName} to Alex`);
  await mobileDialog.getByRole("button", { name: "Send question" }).click();
  const borrowedReturn = mobileDialog.getByLabel("Action review").last();
  await expect(borrowedReturn.getByText("Returned to owner")).toBeVisible();
  await borrowedReturn.getByRole("button", { name: "Apply" }).click();
  await expect(borrowedReturn.getByRole("status")).toBeVisible();
  const borrowed = await (await page.request.get("/api/v1/borrowed")).json();
  expect(borrowed.items.find((record: { item_name: string }) => record.item_name === borrowedName).outstanding_quantity).toBe(1);

  await mobileInput.fill(`Rename ${itemName} to Renamed Drill ${suffix}`);
  await mobileDialog.getByRole("button", { name: "Send question" }).click();
  const editReview = mobileDialog.getByLabel("Action review").last();
  await editReview.getByRole("button", { name: "Edit change" }).click();
  await editReview.getByRole("textbox", { name: "Brand" }).fill("Synthetic brand");
  await editReview.getByLabel("Condition").selectOption("fair");
  await editReview.getByRole("button", { name: "Save change" }).click();
  await expect(editReview.getByText("Synthetic brand", { exact: true })).toBeVisible();
  await editReview.getByRole("button", { name: "Apply" }).click();
  await expect(editReview.getByRole("status")).toBeVisible();
  const updatedItem = (await (await page.request.get(`/api/v1/items/${item.id}`)).json()).item;
  expect(updatedItem.name).toBe(`Renamed Drill ${suffix}`);
  expect(updatedItem.brand).toBe("Synthetic brand");
  expect(updatedItem.condition).toBe("fair");
});

test("duplicate items can be clarified by location against the real API", async ({ page }) => {
  const credentials = { email: "stagec-browser@example.com", password: "isolated-stagec-test-password" };
  const login = await page.request.post("/api/v1/auth/login", { data: credentials });
  expect(login.ok(), await login.text()).toBeTruthy();
  const suffix = Date.now().toString();
  const officeName = `Office ${suffix}`;
  const garageName = `Garage ${suffix}`;
  const kitchenName = `Kitchen ${suffix}`;
  const itemName = `Drill ${suffix}`;
  const office = await (await page.request.post("/api/v1/rooms", { data: { name: officeName } })).json();
  const garage = await (await page.request.post("/api/v1/rooms", { data: { name: garageName } })).json();
  const kitchen = await (await page.request.post("/api/v1/rooms", { data: { name: kitchenName } })).json();
  const officeItem = (await (await page.request.post("/api/v1/items", { data: { name: itemName, quantity: 1, room_id: office.id } })).json()).item;
  const garageItem = (await (await page.request.post("/api/v1/items", { data: { name: itemName, quantity: 1, room_id: garage.id } })).json()).item;

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/items");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Assistant" }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await input.fill(`Move ${itemName} to ${kitchenName}`);
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByRole("button", { name: `${itemName} · ${officeName}` })).toBeVisible();
  await expect(dialog.getByRole("button", { name: `${itemName} · ${garageName}` })).toBeVisible();
  await input.fill(`اون توی ${officeName}`);
  await dialog.getByRole("button", { name: "Send question" }).click();
  const review = dialog.getByLabel("Action review");
  await expect(review).toContainText(`Selected: ${itemName} · ${officeName}`);
  expect((await (await page.request.get(`/api/v1/items/${officeItem.id}`)).json()).item.room.id).toBe(office.id);
  await review.getByRole("button", { name: "Apply" }).click();
  await expect(review.getByRole("status")).toContainText("Moved");
  expect((await (await page.request.get(`/api/v1/items/${officeItem.id}`)).json()).item.room.id).toBe(kitchen.id);
  expect((await (await page.request.get(`/api/v1/items/${garageItem.id}`)).json()).item.room.id).toBe(garage.id);

  await input.fill("Lend 1 it to Sam");
  await dialog.getByRole("button", { name: "Send question" }).click();
  const lendReview = dialog.getByLabel("Action review").last();
  await expect(lendReview).toContainText(itemName);
  await lendReview.getByRole("button", { name: "Apply" }).click();
  await expect(lendReview.getByRole("status")).toContainText("Recorded loan");
  const loans = await (await page.request.get("/api/v1/loans")).json();
  expect(loans.items.find((loan: { item_id: string }) => loan.item_id === officeItem.id)).toBeTruthy();

  const borrowedName = `نردبان ${suffix}`;
  await input.fill(`۲ ${borrowedName} رو از سارا قرض بگیر`);
  await dialog.getByRole("button", { name: "Send question" }).click();
  const borrowReview = dialog.getByLabel("Action review").last();
  await expect(borrowReview).toContainText(borrowedName);
  await expect(borrowReview.getByText("پیش از ثبت، اطلاعات قرض گرفتن را بررسی کنید.")).toHaveAttribute("dir", "auto");
  await borrowReview.getByRole("button", { name: "Apply" }).click();
  await expect(borrowReview.getByRole("status")).toContainText("Recorded borrowing");
  await input.fill(`۱ ${borrowedName} رو به سارا پس بده`);
  await dialog.getByRole("button", { name: "Send question" }).click();
  const returnReview = dialog.getByLabel("Action review").last();
  await expect(returnReview).toContainText("Returned to owner");
  await returnReview.getByRole("button", { name: "Apply" }).click();
  await expect(returnReview.getByRole("status")).toContainText("Recorded return");
  const borrowed = await (await page.request.get("/api/v1/borrowed")).json();
  expect(borrowed.items.find((record: { item_name: string }) => record.item_name === borrowedName).outstanding_quantity).toBe(1);
});
