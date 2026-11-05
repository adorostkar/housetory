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
  payload: Record<string, unknown>,
) {
  const response = await request.post("/api/v1/items", { data: payload });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string } };
}

test("reviews extracted receipt lines, matches existing inventory and applies only reviewed items", async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString().slice(-6);
  const room = await createRoom(request, `Extraction room ${suffix}`);
  const box = await createContainer(request, room.id, `Extraction box ${suffix}`);
  const serial = `SN-${suffix}`;
  const existing = await createItem(request, {
    name: `Cordless Drill ${suffix}`,
    serial_number: serial,
    room_id: room.id,
    storage_location_id: box.id,
    quantity: 1,
  });

  const receipt = `CORNER HARDWARE
123 Main Street
Date: 02/14/2026
Invoice: INV-${suffix}
Cordless Drill ${suffix} Serial ${serial} 1 x 79.99 79.99
Drill Bit Set ${suffix} 1 x 24.50 24.50
Subtotal 104.49
Tax 8.36
Total $112.85
Visa 112.85
`;

  await page.goto("/documents");
  await page.getByRole("button", { name: "Add document" }).click();
  await page.locator("#document-file").setInputFiles({
    name: `receipt-${suffix}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(receipt),
  });
  await page.getByLabel(/^Title/).fill(`Corner Hardware receipt ${suffix}`);
  await page.getByRole("button", { name: "Add document" }).last().click();

  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+/);
  await expect(page.getByRole("heading", { name: "Review extracted items" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("heading", { name: "Product lines" })).toBeVisible();
  const drillLine = page.locator("article").filter({ hasText: `Cordless Drill ${suffix}` });
  await expect(drillLine.getByText("Identifier verified")).toBeVisible();
  await expect(drillLine.getByText(/serial number matches/)).toBeVisible();

  await page.getByLabel(/^Merchant/).fill("Corner Hardware");
  const bitLine = page.locator("article").filter({ hasText: `Drill Bit Set ${suffix}` });
  await expect(bitLine.getByText("No likely household match")).toBeVisible();
  await bitLine.getByRole("button", { name: "Create new item" }).click();
  await bitLine.getByLabel("Destination room").selectOption(room.id);
  await bitLine.getByLabel("Optional container").selectOption(box.id);
  await page.getByRole("button", { name: "Apply reviewed changes" }).click();

  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
  const documentId = page.url().split("/").pop();
  expect(documentId).toBeTruthy();
  const document = await (await request.get(`/api/v1/documents/${documentId}`)).json();
  expect(document.merchant).toBe("Corner Hardware");
  expect(document.items).toHaveLength(2);

  const items = await (await request.get(`/api/v1/items?room_id=${room.id}`)).json();
  expect(items.total).toBe(2);
  const existingAfter = await (
    await request.get(`/api/v1/items/${existing.item.id}`)
  ).json();
  expect(existingAfter.item.quantity).toBe(1);
  const created = items.items.find(
    (item: { name: string }) => item.name === `Drill Bit Set ${suffix}`,
  );
  expect(created).toBeTruthy();
  const purchaseId = document.extracted_metadata?.extraction_applied?.purchase_id;
  expect(purchaseId).toBeTruthy();
  const purchase = await (await request.get(`/api/v1/purchases/${purchaseId}`)).json();
  expect(purchase.price_cents).toBe(11285);
  expect(purchase.receipt_document_id).toBe(documentId);
  expect(purchase.items).toHaveLength(2);
});
