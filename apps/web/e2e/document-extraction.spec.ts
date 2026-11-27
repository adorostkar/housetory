import { expect, test, type APIRequestContext } from "@playwright/test";
import http from "node:http";
import { AddressInfo } from "node:net";

// Run this file on a fresh household. Drills and drill bit sets left by an earlier run
// are offered as matches for the new receipt lines, and the checks below then fail.
//
// The mock AI is reached through Docker's host name by default. Set E2E_AI_BASE_URL
// (for example http://127.0.0.1:4893) when the API runs outside Docker; the mock then
// listens on that port.
const aiBaseUrl = process.env.E2E_AI_BASE_URL;
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
  const port = aiBaseUrl ? Number(new URL(aiBaseUrl).port) : 0;
  await new Promise<void>((resolve) => mockServer.listen(port, "0.0.0.0", resolve));
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
  // The file is saved as soon as it is chosen. Details are an optional step after that.
  const upload = page.getByRole("dialog", { name: "Add a document" });
  await upload.getByTestId("document-file").setInputFiles({
    name: `receipt-${suffix}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(receipt),
  });
  await upload.getByRole("button", { name: /Add details/ }).click();
  await upload.getByLabel("Type", { exact: true }).selectOption("receipt");
  await upload.getByLabel(/^Title/).fill(`Corner Hardware receipt ${suffix}`);
  await upload.getByRole("button", { name: "Save details" }).click();
  await upload.getByRole("link", { name: "View" }).click();

  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+/);
  // The review is closed until asked for.
  await page.getByRole("button", { name: "Review extraction" }).click({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Product lines" })).toBeVisible();
  // Each line is a closed row. Nothing is selected to begin with.
  const drillLine = page.getByRole("article", { name: `Cordless Drill ${suffix}` });
  await expect(drillLine.getByRole("checkbox")).not.toBeChecked();
  await expect(drillLine.getByRole("button", { name: "Link to item" })).toBeVisible();
  await drillLine.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(drillLine.getByText("Identifier verified")).toBeVisible();
  await expect(drillLine.getByText(/serial number matches/)).toBeVisible();

  const bitLine = page.getByRole("article", { name: `Drill Bit Set ${suffix}` });
  // A line without a match proposes a new item. Its room is chosen in the editor.
  await expect(bitLine.getByRole("button", { name: "Add item" })).toBeVisible();
  await bitLine.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(bitLine.getByText("No likely household match")).toBeVisible();
  await bitLine.getByLabel("Destination room").selectOption(room.id);
  await bitLine.getByLabel("Optional container").selectOption(box.id);

  // The fields at the top of the review are corrected too.
  await page.getByLabel(/^Merchant/).fill("Corner Hardware");
  await page.getByLabel(/^Order or invoice number/).fill(`ORD-${suffix}`);

  // The corrections of a line and of the fields at the top are kept by themselves:
  // no Skip, no Apply. The line still waits, and a reload shows all of it again.
  const reviewedId = page.url().split("/").pop();
  const reviewUrl = `/api/v1/documents/${reviewedId}/extraction`;
  await expect
    .poll(async () => {
      const review = (await (await request.get(reviewUrl)).json()) as {
        lines: Array<{ id: string; description: string }>;
        line_states?: Record<string, {
          status: string;
          draft?: { newItem?: { roomId?: string; locationId?: string } } | null;
        }>;
        header_draft?: { draft: { merchant?: string; order_number?: string } } | null;
      };
      const line = review.lines.find((entry) => entry.description === `Drill Bit Set ${suffix}`);
      const state = line ? review.line_states?.[line.id] : undefined;
      return [
        state?.status, state?.draft?.newItem?.roomId, state?.draft?.newItem?.locationId,
        review.header_draft?.draft.merchant, review.header_draft?.draft.order_number,
      ];
    })
    .toEqual(["pending", room.id, box.id, "Corner Hardware", `ORD-${suffix}`]);
  await page.reload();
  await page.getByRole("button", { name: "Review extraction" }).click({ timeout: 30_000 });
  await expect(bitLine.getByRole("checkbox")).not.toBeChecked();
  await expect(bitLine.getByRole("button", { name: "Add item" })).toBeEnabled();
  await bitLine.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(bitLine.getByLabel("Destination room")).toHaveValue(room.id);
  await expect(bitLine.getByLabel("Optional container")).toHaveValue(box.id);
  expect((await (await request.get(`/api/v1/items?room_id=${room.id}`)).json()).total).toBe(1);
  // The fields at the top are filled again. Filling them applied nothing: the
  // document itself is as it was read, with no items and no purchase.
  await expect(page.getByLabel(/^Merchant/)).toHaveValue("Corner Hardware");
  await expect(page.getByLabel(/^Order or invoice number/)).toHaveValue(`ORD-${suffix}`);
  const waiting = await (await request.get(`/api/v1/documents/${reviewedId}`)).json();
  expect(waiting.merchant).not.toBe("Corner Hardware");
  expect(waiting.items).toHaveLength(0);
  expect(waiting.extracted_metadata?.extraction_applied).toBeUndefined();

  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: /^Apply: add 1 item, link 1 item/ }).click();

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
  // A purchase is a short row; its allocations show when the row is opened.
  await page.getByTestId("purchase-row").first().getByRole("button").first().click();
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
      base_url: aiBaseUrl ?? `http://host.docker.internal:${mockPort}`,
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

  // With a document AI set up, the AI reading is prepared in the background.
  const aiReading = async () => {
    const review = (await (
      await request.get(`/api/v1/documents/${document.id}/extraction`)
    ).json()) as { enhancement?: { status: string } | null };
    return review.enhancement?.status;
  };
  await expect.poll(aiReading, { timeout: 30_000 }).toBe("ready");

  await page.goto(`/documents/${document.id}`);
  await page.getByRole("button", { name: "Review extraction" }).click();
  // An untouched review starts from the AI reading and says so.
  await expect(page.getByText("AI-assisted draft. Check every value before Apply.")).toBeVisible();
  // Go back to the local reading, ask the AI again, and accept its proposal by hand.
  await page.getByRole("button", { name: "Use deterministic proposal" }).click();
  await expect(page.getByText("AI-refined proposal")).toHaveCount(0);
  const asked = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/processing/retry"),
  );
  await page.getByRole("button", { name: "Refine fields & lines" }).first().click();
  expect((await asked).ok()).toBeTruthy();
  await expect.poll(aiReading, { timeout: 30_000 }).toBe("ready");
  await page.getByRole("button", { name: "Review AI suggestions" }).click();
  await expect(page.getByText("AI refinement proposal")).toBeVisible();
  await page.getByRole("button", { name: "Accept AI refinement" }).click();
  await expect(page.getByText("AI-refined proposal")).toBeVisible();
  await page.getByLabel(/^Merchant/).fill("Edited AI Shop");
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: /^Apply: / }).click();
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
  // The closed review says it is applied; the full sentence is inside.
  const reviewSection = page.getByRole("region", { name: "Extraction review" });
  await expect(reviewSection.getByText("Already applied", { exact: true })).toBeVisible();
  await reviewSection.getByRole("button", { name: "Review extraction" }).click();
  await expect(page.getByText("This extraction was already applied")).toBeVisible();

  await resetProviders(request);
  await request.put("/api/v1/ai/tasks/documents", {
    data: { provider_id: null, enabled: false },
  });
});
