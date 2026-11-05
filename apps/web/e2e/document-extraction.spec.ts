import { expect, test, type APIRequestContext } from "@playwright/test";
import http from "node:http";
import { AddressInfo } from "node:net";

let mockServer: http.Server;
let mockPort = 0;
let aiSuffix = "run";

test.beforeAll(async () => {
  mockServer = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/api/tags") {
      response.end(JSON.stringify({ models: [{ name: "document-model" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/chat") {
      const prompt =
        (JSON.parse(body || "{}") as { messages?: Array<{ content?: string }> }).messages
          ?.map((message) => message.content ?? "")
          .join("\n") ?? "";
      if (prompt.includes("Normalize already-extracted document metadata")) {
        response.end(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                merchant: null,
                purchase_date: null,
                total_cents: null,
                currency: null,
                product_names: null,
                invoice_number: null,
                serial_numbers: null,
                brand: null,
                model: null,
              }),
            },
          }),
        );
        return;
      }
      if (prompt.includes("extract structured receipt/document facts")) {
        const evidence = `Cordless Drill ${aiSuffix} Makita XPH12 1 x 75.00 75.00`;
        response.end(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                fields: {
                  merchant: "Corner Hardware AI",
                  purchase_date: "2026-02-14",
                  currency: "USD",
                  total_cents: 7500,
                  brand: "Makita",
                  model: "XPH12",
                  evidence: {
                    merchant: "CORNER HARDWARE",
                    purchase_date: "Date: 02/14/2026",
                    currency: "Total $75.00",
                    total_cents: "Total $75.00",
                    brand: evidence,
                    model: evidence,
                  },
                },
                lines: [
                  {
                    description: `Cordless Drill ${aiSuffix}`,
                    kind: "product",
                    quantity: 1,
                    unit_price_cents: 7500,
                    line_total_cents: 7500,
                    evidence,
                    uncertainty: [],
                  },
                ],
                warnings: ["Mock AI refinement for browser verification."],
                notes: [],
              }),
            },
          }),
        );
        return;
      }
      response.end(JSON.stringify({ message: { content: JSON.stringify({ matches: [], warnings: [] }) } }));
      return;
    }
    response.end(JSON.stringify({}));
  });
  await new Promise<void>((resolve) => mockServer.listen(0, "0.0.0.0", resolve));
  mockPort = (mockServer.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    mockServer.close((error) => (error ? reject(error) : resolve())),
  );
});

async function resetProviders(request: APIRequestContext) {
  const settings = (await (await request.get("/api/v1/ai/settings")).json()) as {
    providers: Array<{ id: string }>;
  };
  for (const provider of settings.providers) {
    await request.delete(`/api/v1/ai/providers/${provider.id}`);
  }
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
  expect(purchase.allocated_total_cents).toBe(10449);
  expect(purchase.unallocated_cents).toBe(836);
  expect(purchase.allocations).toHaveLength(2);
  expect(
    purchase.allocations.every(
      (allocation: { item_id: string; allocated_cents: number }) =>
        [existing.item.id, created.id].includes(allocation.item_id) &&
        allocation.allocated_cents > 0,
    ),
  ).toBeTruthy();

  await page.goto(`/purchases?q=${encodeURIComponent("Corner Hardware")}`);
  await expect(page.getByText("Reviewed item allocations").first()).toBeVisible();
  await expect(page.getByText(/104\.49/).first()).toBeVisible();
});


test("AI-refines fields and lines, then applies reviewed allocations", async ({
  page,
  request,
}) => {
  await resetProviders(request);
  const providerResponse = await request.post("/api/v1/ai/providers", {
    data: {
      provider: "ollama",
      display_name: "Mock document AI",
      base_url: `http://host.docker.internal:${mockPort}`,
      default_model: "document-model",
      enabled: true,
      cloud_consent: false,
    },
  });
  expect(providerResponse.ok()).toBeTruthy();
  const provider = (await providerResponse.json()) as { id: string };
  const task = await request.put("/api/v1/ai/tasks/documents", {
    data: { provider_id: provider.id, model: "document-model", enabled: true },
  });
  expect(task.ok()).toBeTruthy();

  const suffix = Date.now().toString().slice(-6);
  aiSuffix = suffix;
  const room = await createRoom(request, `AI refinement room ${suffix}`);
  const existing = await createItem(request, {
    name: `Cordless Drill ${suffix}`,
    brand: "Makita",
    model: "XPH12",
    room_id: room.id,
    quantity: 1,
  });
  const receipt = `CORNER HARDWARE
Date: 02/14/2026
Cordless Drill ${suffix} Makita XPH12 1 x 75.00 75.00
Total $75.00
`;
  const upload = await request.post("/api/v1/documents", {
    multipart: {
      file: { name: `ai-receipt-${suffix}.txt`, mimeType: "text/plain", buffer: Buffer.from(receipt) },
      title: `AI receipt ${suffix}`,
      document_type: "receipt",
    },
  });
  expect(upload.ok()).toBeTruthy();
  const document = (await upload.json()) as { id: string };
  await expect
    .poll(
      async () => {
        const current = (await (await request.get(`/api/v1/documents/${document.id}`)).json()) as {
          ocr_status: string;
        };
        return current.ocr_status;
      },
      { timeout: 30_000 },
    )
    .toBe("succeeded");

  await page.goto(`/documents/${document.id}`);
  await expect(page.getByRole("heading", { name: "Review extracted items" })).toBeVisible();
  await page.getByRole("button", { name: "Refine fields & lines" }).first().click();
  await expect(page.getByText("AI refinement proposal")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Accept AI refinement" }).click();
  await expect(page.getByText("AI-refined proposal")).toBeVisible();
  await page.getByLabel(/^Merchant/).fill("Edited AI Shop");
  await page.getByRole("button", { name: "Apply reviewed changes" }).click();
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();

  const documentAfter = await (await request.get(`/api/v1/documents/${document.id}`)).json();
  expect(documentAfter.merchant).toBe("Edited AI Shop");
  const purchaseId = documentAfter.extracted_metadata.extraction_applied.purchase_id;
  const purchase = await (await request.get(`/api/v1/purchases/${purchaseId}`)).json();
  expect(purchase.price_cents).toBe(7500);
  expect(purchase.allocations).toHaveLength(1);
  expect(purchase.allocated_total_cents).toBe(7500);
  expect(purchase.unallocated_cents).toBe(0);
  expect(purchase.allocations[0].item_id).toBe(existing.item.id);
  const itemAfter = await (await request.get(`/api/v1/items/${existing.item.id}`)).json();
  expect(itemAfter.item.quantity).toBe(1);
  expect(itemAfter.item.purchase.allocations).toHaveLength(1);

  await page.reload();
  await expect(page.getByText("This extraction was already applied")).toBeVisible();

  await resetProviders(request);
  await request.put("/api/v1/ai/tasks/documents", {
    data: { provider_id: null, enabled: false },
  });
});
