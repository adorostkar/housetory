import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  here,
  "../../../services/api/tests/fixtures/home_inventory_actual.md",
);
const photoPath = path.resolve(here, "../public/icons/icon-192.png");

let mockServer: http.Server;
let mockPort = 0;
let scanSuffix = "run";

test.beforeAll(async () => {
  mockServer = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/api/tags") {
      response.end(
        JSON.stringify({
          models: [{ name: "llava:latest" }, { name: "qwen2.5:7b" }],
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/chat") {
      const payload = JSON.parse(body || "{}") as {
        messages?: Array<{ content?: string }>;
      };
      const prompt = payload.messages?.map((message) => message.content ?? "").join("\n") ?? "";
      if (prompt.includes("Identify every clearly visible household possession")) {
        response.end(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                suggestions: [
                  {
                    name: `Phase six camera ${scanSuffix}`,
                    quantity: 1,
                    description: null,
                    category: "Electronics",
                    brand: "Acme",
                    model: "C-1",
                    tags: ["photography"],
                    notes: null,
                    confidence: 88,
                    field_sources: { name: "inferred", brand: "inferred" },
                  },
                  {
                    name: `Phase six cables ${scanSuffix}`,
                    quantity: 3,
                    description: null,
                    category: "Electronics",
                    brand: null,
                    model: null,
                    tags: [],
                    notes: null,
                    confidence: 74,
                    field_sources: { name: "inferred" },
                  },
                ],
                warnings: [],
              }),
            },
          }),
        );
        return;
      }
      response.end(JSON.stringify({ message: { content: "{}" } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => mockServer.listen(0, "0.0.0.0", resolve));
  mockPort = (mockServer.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
});

function mockProviderUrl() {
  return process.env.E2E_AI_BASE_URL ?? `http://host.docker.internal:${mockPort}`;
}

async function resetProviders(request: APIRequestContext) {
  const settings = await request.get("/api/v1/ai/settings");
  expect(settings.ok()).toBeTruthy();
  const body = (await settings.json()) as {
    providers: Array<{ id: string }>;
  };
  for (const provider of body.providers) {
    const deleted = await request.delete(`/api/v1/ai/providers/${provider.id}`);
    expect(deleted.status()).toBe(204);
  }
}

async function ensureMockProvider(request: APIRequestContext) {
  const settingsResponse = await request.get("/api/v1/ai/settings");
  expect(settingsResponse.ok()).toBeTruthy();
  const settings = (await settingsResponse.json()) as {
    providers: Array<{ id: string; provider: string }>;
  };
  let provider = settings.providers.find((entry) => entry.provider === "ollama");
  if (!provider) {
    const created = await request.post("/api/v1/ai/providers", {
      data: {
        provider: "ollama",
        display_name: "Mock local vision",
        base_url: mockProviderUrl(),
        default_model: "llava:latest",
        enabled: true,
        cloud_consent: false,
      },
    });
    expect(created.ok()).toBeTruthy();
    provider = (await created.json()) as { id: string; provider: string };
  } else {
    const updated = await request.patch(`/api/v1/ai/providers/${provider.id}`, {
      data: {
        base_url: mockProviderUrl(),
        default_model: "llava:latest",
        enabled: true,
      },
    });
    expect(updated.ok()).toBeTruthy();
  }
  const task = await request.put("/api/v1/ai/tasks/vision", {
    data: { provider_id: provider.id, model: "llava:latest", enabled: true },
  });
  expect(task.ok()).toBeTruthy();
  return provider;
}

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
  };
}

async function waitForImport(request: APIRequestContext, batchId: string) {
  let detail: Record<string, unknown> = {};
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/v1/imports/${batchId}`);
        detail = await response.json();
        return detail.status;
      },
      { timeout: 30_000 },
    )
    .toBe("review");
  return detail;
}

async function uploadFixture(request: APIRequestContext, title: string) {
  const response = await request.post("/api/v1/imports", {
    multipart: {
      title,
      file: {
        name: "home_inventory.md",
        mimeType: "text/markdown",
        buffer: fs.readFileSync(fixturePath),
      },
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: string };
}

function captureInput(page: Page) {
  return page.locator("input[capture='environment']").first();
}

test("configures an Ollama provider through Settings with a mocked local service", async ({
  page,
  request,
}) => {
  await resetProviders(request);
  await page.goto("/settings/ai");
  await expect(
    page.getByRole("heading", { name: "AI providers", level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Provider", { exact: true }).selectOption("ollama");
  await dialog.getByLabel("Display name").fill("Mock local vision");
  await dialog.getByLabel("Base URL").fill(mockProviderUrl());
  await dialog.getByLabel("Default model").fill("llava:latest");
  await expect(
    dialog.getByText(/consent to sending household data/i),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add provider" }).click();
  await expect(dialog).toBeHidden();

  const card = page
    .locator("article")
    .filter({ hasText: "Mock local vision" })
    .first();
  await expect(card).toContainText("Local");
  await expect(card).toContainText("llava:latest");
  await card.getByRole("button", { name: "Test connection" }).click();
  await expect(card).toContainText(/Connected/);
  await card.getByRole("button", { name: "Discover models" }).click();
  await expect(card).toContainText("llava:latest");
  await expect(page.getByText(/Configuring a cloud API key/)).toBeVisible();

  const settings = await request.get("/api/v1/ai/settings");
  const body = (await settings.json()) as {
    providers: Array<{ provider: string; has_api_key: boolean; cloud_consent: boolean }>;
  };
  expect(body.providers[0]).toMatchObject({
    provider: "ollama",
    has_api_key: false,
    cloud_consent: false,
  });
  expect(JSON.stringify(body)).not.toContain("encrypted_api_key");
  expect(JSON.stringify(body)).not.toContain("sk-");
});

test("captures a camera photo, reviews multi-object suggestions and creates approved items in a container", async ({
  page,
  request,
}) => {
  await ensureMockProvider(request);
  scanSuffix = Date.now().toString().slice(-8);
  const cameraName = `Phase six camera ${scanSuffix}`;
  const cablesName = `Phase six cables ${scanSuffix}`;
  const room = await createRoom(request, `Phase 6 scan ${Date.now()}`);
  const container = await createContainer(request, room.id, "Camera gear");

  await page.goto(`/containers/${container.id}`);
  await page.getByRole("link", { name: "Scan contents" }).click();
  await expect(page).toHaveURL(new RegExp(`/scan\\?location_id=${container.id}`));
  await expect(
    page.getByText(/A vision-capable model is selected/),
  ).toBeVisible();

  await captureInput(page).setInputFiles(photoPath);
  await expect(
    page.getByRole("img", { name: "Captured photograph preview" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Upload photograph" }).click();
  await expect(
    page.getByRole("heading", { name: "Review 2 suggestions" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Local vision/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: cameraName }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: cablesName }),
  ).toBeVisible();
  await expect(page.getByLabel("Destination").first()).toHaveValue(container.id);
  await expect(page.getByLabel("Quantity").nth(1)).toHaveValue("3");

  await page.getByRole("button", { name: "Approve selected" }).click();
  await expect(page.getByText("Scan applied")).toBeVisible();
  await expect(page.getByText(/2 created/).first()).toBeVisible();

  const itemsResponse = await request.get(`/api/v1/items?limit=100&room_id=${room.id}`);
  expect(itemsResponse.ok()).toBeTruthy();
  const items = (await itemsResponse.json()) as {
    items: Array<{ id: string; name: string; quantity: number; location: { id: string } }>;
  };
  const camera = items.items.find((item) => item.name === cameraName);
  const cables = items.items.find((item) => item.name === cablesName);
  expect(camera).toBeTruthy();
  expect(cables?.quantity).toBe(3);
  expect(camera?.location.id).toBe(container.id);
  expect(cables?.location.id).toBe(container.id);

  const photos = await request.get(`/api/v1/items/${camera?.id}`);
  const detail = (await photos.json()) as { item: { photos: unknown[] } };
  expect(detail.item.photos).toHaveLength(0);
});

test("imports the actual Inventory.md, excludes indexes/templates and prevents duplicate items", async ({
  page,
  request,
}) => {
  const batch = await uploadFixture(request, `Actual hierarchy ${Date.now()}`);
  await waitForImport(request, batch.id);
  await page.goto(`/imports/${batch.id}`);
  await expect(page.getByText("Structured hierarchy")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Storage", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Storage room 2", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "STO-03", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Keyboards (incl. Dell keyboard)", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ethernet cables + long ethernet cable", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Source reference").first()).toBeVisible();
  await expect(page.getByText("Sample item")).toHaveCount(0);
  await expect(page.getByText("Possible duplicate")).toHaveCount(0);
  const detailBefore = await (
    await request.get(`/api/v1/imports/${batch.id}`)
  ).json();
  expect(detailBefore.metadata.hierarchy_nodes).toBe(8);
  expect(detailBefore.metadata.hierarchy_items).toBe(52);
  expect(detailBefore.metadata.ai_used).toBe(false);

  await page.getByRole("button", { name: "Approve selected" }).click();
  await expect(page.getByText("Import applied")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/0 failed/).first()).toBeVisible();

  const rooms = (await (
    await request.get("/api/v1/rooms")
  ).json()) as { items: Array<{ id: string; name: string; parent_id: string | null }> };
  const byRoom = new Map(rooms.items.map((room) => [room.name, room]));
  expect(byRoom.has("Storage")).toBeTruthy();
  expect(byRoom.get("Storage room 2")?.parent_id).toBe(byRoom.get("Storage")?.id);
  expect(byRoom.has("Apartment")).toBeFalsy();
  expect(byRoom.has("Car")).toBeFalsy();

  const containers = (await (
    await request.get("/api/v1/containers?limit=200")
  ).json()) as {
    items: Array<{ id: string; legacy_identifier: string | null; name: string }>;
  };
  const sto = containers.items.filter((container) =>
    container.legacy_identifier?.startsWith("STO-"),
  );
  expect(sto.map((container) => container.legacy_identifier).sort()).toEqual([
    "STO-01",
    "STO-02",
    "STO-03",
    "STO-04",
    "STO-05",
    "STO-06",
  ]);
  const sto03 = sto.find((container) => container.legacy_identifier === "STO-03");

  const items = (await (
    await request.get("/api/v1/items?limit=100")
  ).json()) as {
    items: Array<{ id: string; name: string; quantity: number; location: { id: string } | null }>;
    total: number;
  };
  const keyboards = items.items.find(
    (item) => item.name === "Keyboards (incl. Dell keyboard)",
  );
  expect(keyboards?.quantity).toBe(2);
  expect(keyboards?.location?.id).toBe(sto03?.id);
  const ethernet = items.items.find(
    (item) => item.name === "Ethernet cables + long ethernet cable",
  );
  expect(ethernet?.quantity).toBe(8);
  expect(items.items.some((item) => item.name === "Sample item")).toBeFalsy();
  expect(items.items.filter((item) => item.name === "Empty boxes (assorted)")).toHaveLength(1);
  const importedTotal = items.total;
  const purchases = (await (
    await request.get("/api/v1/purchases")
  ).json()) as { total: number };
  expect(purchases.total).toBe(0);

  const duplicateBatch = await uploadFixture(request, `Actual duplicate ${Date.now()}`);
  await waitForImport(request, duplicateBatch.id);
  await page.goto(`/imports/${duplicateBatch.id}`);
  const keyboardRow = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Keyboards (incl. Dell keyboard)" }) })
    .first();
  await expect(keyboardRow.getByText("Possible duplicate")).toBeVisible();
  await expect(
    keyboardRow.getByLabel("Action for Keyboards (incl. Dell keyboard)"),
  ).toHaveValue("skip");

  await keyboardRow
    .getByRole("checkbox", { name: "Include Keyboards (incl. Dell keyboard)" })
    .check();
  await page.getByRole("button", { name: /Approve .* entr/ }).click();
  await expect(page.getByText("Import applied")).toBeVisible({ timeout: 30_000 });
  const after = (await (
    await request.get("/api/v1/items?limit=100")
  ).json()) as { total: number };
  expect(after.total).toBe(importedTotal);
});

test("serves PWA assets, service worker registration and deep-link routing", async ({
  page,
  request,
}) => {
  const room = await createRoom(request, `PWA ${Date.now()}`);
  const container = await createContainer(request, room.id, "PWA box");
  await page.goto(`/containers/${container.id}`);
  await expect(
    page.getByRole("heading", { name: container.identifier, level: 1, exact: true }),
  ).toBeVisible();

  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBeTruthy();
  expect(await manifest.text()).toContain('"display": "standalone"');
  const worker = await request.get("/sw.js");
  expect(worker.ok()).toBeTruthy();
  expect(await worker.text()).toContain("housetory-shell");
  const headers = await request.get("/");
  expect(headers.headers()["x-content-type-options"]).toBe("nosniff");
  expect(headers.headers()["content-security-policy"]).toContain("default-src 'self'");

  await expect
    .poll(async () => {
      return page.evaluate(async () => {
        const registrations = await navigator.serviceWorker.getRegistrations();
        return registrations.length;
      });
    })
    .toBeGreaterThan(0);

  const mobile = await page.context().browser()?.newContext({
    viewport: { width: 393, height: 852 },
    storageState: await page.context().storageState(),
  });
  expect(mobile).toBeTruthy();
  const mobilePage = await mobile!.newPage();
  await mobilePage.goto("/settings/ai");
  await expect(
    mobilePage.getByRole("heading", { name: "AI providers", level: 1 }),
  ).toBeVisible();
  await expect(mobilePage.getByRole("button", { name: "Add provider" })).toBeVisible();
  await mobile!.close();
});
