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
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      response.end(JSON.stringify({ data: [{ id: "gpt-4o", name: "GPT-4o" }] }));
      return;
    }
    if (request.method === "POST" && request.url?.endsWith("/chat/completions")) {
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  suggestions: [
                    {
                      name: `Window ${scanSuffix}`,
                      quantity: 1,
                      confidence: 82,
                      field_sources: { name: "inferred" },
                    },
                    {
                      name: `Portable heater ${scanSuffix}`,
                      quantity: 1,
                      confidence: 80,
                      field_sources: { name: "inferred" },
                    },
                    {
                      name: `Radiator ${scanSuffix}`,
                      quantity: 1,
                      confidence: 78,
                      field_sources: { name: "inferred" },
                    },
                    {
                      name: `Mystery object ${scanSuffix}`,
                      quantity: 1,
                      confidence: 22,
                      field_sources: { name: "inferred" },
                    },
                  ],
                  warnings: [],
                }),
              },
            },
          ],
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/chat") {
      const payload = JSON.parse(body || "{}") as {
        messages?: Array<{ content?: string }>;
      };
      const prompt = payload.messages?.map((message) => message.content ?? "").join("\n") ?? "";
      if (prompt.includes("Identify clearly visible, movable household possessions")) {
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
  // With E2E_AI_BASE_URL (an API outside Docker) the mock listens on that URL's port.
  const fixedPort = process.env.E2E_AI_BASE_URL ? Number(new URL(process.env.E2E_AI_BASE_URL).port) : 0;
  await new Promise<void>((resolve) => mockServer.listen(fixedPort, "0.0.0.0", resolve));
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
  await expect(
    dialog.getByText(/consent to sending household data/i),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: /Save provider & discover models/ })
    .click();
  const modelPicker = dialog.getByRole("combobox", { name: "Default model" });
  await expect(modelPicker).toBeVisible();
  await modelPicker.click();
  await expect(
    dialog.getByRole("option", { name: /llava:latest/ }),
  ).toBeVisible();
  await expect(
    dialog.getByText(/Provider metadata|Heuristic — verify/).first(),
  ).toBeVisible();
  await dialog.getByRole("option", { name: /llava:latest/ }).click();
  await dialog.getByRole("button", { name: /Save selected model/ }).click();
  await expect(dialog).toBeHidden();

  const card = page
    .locator("article")
    .filter({ hasText: "Mock local vision" })
    .first();
  await expect(card).toContainText("Local");
  await expect(card).toContainText("llava:latest");
  await expect(card).toContainText(/2 model\(s\) available/);
  await card.getByRole("button", { name: "Test connection" }).click();
  await expect(card).toContainText(/Connected/);
  await card.getByRole("button", { name: "Refresh models" }).click();
  await expect(card).toContainText(/2 model\(s\) available/);
  await expect(page.getByText(/Configuring a cloud API key/)).toBeVisible();

  const taskModel = page.getByRole("combobox", {
    name: "Default text model",
  });
  await expect(taskModel).toHaveValue("llava:latest");
  await taskModel.click();
  await expect(
    page.getByRole("option", { name: /llava:latest/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Default text model" }),
  ).toBeVisible();
  await expect(page.getByText(/Inherited:/)).toContainText("Assistant");
  await page.getByText("Advanced task overrides").click();
  await expect(
    page.getByRole("combobox", { name: "Assistant model" }),
  ).toHaveValue("llava:latest");

  await page.setViewportSize({ width: 393, height: 852 });
  await page.getByRole("button", { name: "Edit provider" }).first().click();
  const mobileDialog = page.getByRole("dialog");
  const mobilePicker = mobileDialog.getByRole("combobox", {
    name: "Default model",
  });
  await expect(mobilePicker).toBeVisible();
  await mobilePicker.click();
  await expect(
    mobileDialog.getByRole("option", { name: /llava:latest/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await page.goto("/settings/services");
  await expect(
    page.getByRole("heading", { name: "Intelligence", level: 2 }),
  ).toBeVisible();
  await expect(page.getByText("Model listed by provider")).toBeVisible();
  await expect(page.getByText("2 models listed")).toBeVisible();
  await expect(page.getByText("Available models")).toHaveCount(0);
  await expect(page.getByText(/does not send a test prompt/i)).toBeVisible();
  await page.getByRole("button", { name: /Check provider/ }).click();
  await expect(page.getByText("Model listed by provider")).toBeVisible();
  await expect(page.getByText("2 models listed")).toBeVisible();

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
  await expect(
    page.getByRole("heading", { name: container.identifier, level: 1, exact: true }),
  ).toBeVisible();
  await page.locator("main").getByRole("button", { name: "Add items" }).first().click();
  // The photo goes through Add items, which already knows the container it was opened in.
  const addItems = page.getByRole("dialog", { name: "Add items" });
  await addItems.getByTestId("smart-add-camera").setInputFiles(photoPath);
  await expect(addItems.getByRole("button", { name: "Remove photo" })).toBeVisible();
  await addItems.getByRole("button", { name: "Review items" }).click();

  // The found items are reviewed in the assistant, on the page the photo was added from.
  const review = page
    .getByTestId("assistant-panel")
    .getByRole("region", { name: "Assistant item review" });
  await expect(review.getByRole("heading", { name: "Photo review: icon-192.png" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page).toHaveURL(new RegExp(`/containers/${container.id}#assistant$`));
  await expect(review.getByText(/2 proposals/)).toBeVisible();
  await expect(review.getByText("AI-assisted")).toBeVisible();
  await expect(review.getByRole("img", { name: "The photo these items were found in" })).toBeVisible();
  const cameraRow = review.getByRole("article", { name: cameraName });
  const cablesRow = review.getByRole("article", { name: cablesName });
  await expect(cameraRow).toBeVisible();
  await expect(cablesRow.getByLabel(`Quantity of ${cablesName}`)).toHaveValue("3");
  // The destination comes from the container. The full fields are behind Edit.
  await cameraRow.getByRole("button", { name: "Edit" }).click();
  await expect(cameraRow.getByLabel(/^Room/)).toHaveValue(room.id);
  await expect(cameraRow.getByLabel(/^Storage place/)).toHaveValue(container.id);

  // Nothing is selected at first, and nothing is added until asked.
  await expect(cameraRow.getByRole("checkbox", { name: `Select ${cameraName}` })).not.toBeChecked();
  await expect(review.getByRole("button", { name: "Add selected items" })).toBeDisabled();
  await review.getByRole("button", { name: "Select all" }).click();
  await review.getByRole("button", { name: "Add 2 selected items" }).first().click();
  await expect(page.getByText("2 items added")).toBeVisible();
  await expect(review.getByText(/2 proposals · 2 imported/)).toBeVisible();

  // The review no longer names the provider and model. They are recorded with it.
  const batches = (await (await request.get("/api/v1/imports?limit=1")).json()) as {
    items: Array<{ id: string; title: string }>;
  };
  expect(batches.items[0]?.title).toBe("Photo review: icon-192.png");
  const batch = (await (await request.get(`/api/v1/imports/${batches.items[0]!.id}`)).json()) as {
    metadata: { ai_provider: string; ai_model: string };
  };
  expect(batch.metadata).toMatchObject({ ai_provider: "ollama", ai_model: "llava:latest" });

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

test("scans into a room only, flags fixed fixtures and applies a per-suggestion destination", async ({
  page,
  request,
}) => {
  await resetProviders(request);
  scanSuffix = Date.now().toString().slice(-8);
  const heaterName = `Portable heater ${scanSuffix}`;
  const room = await createRoom(request, `Phase 6 room scan ${scanSuffix}`);
  const otherRoom = await createRoom(request, `Phase 6 room scan target ${scanSuffix}`);
  const providerResponse = await request.post("/api/v1/ai/providers", {
    data: {
      provider: "openai",
      display_name: "Fixture vision",
      base_url: `${mockProviderUrl()}/v1`,
      default_model: "gpt-4o",
      api_key: "sk-test-not-real",
      enabled: true,
      cloud_consent: true,
    },
  });
  expect(providerResponse.ok()).toBeTruthy();
  const provider = (await providerResponse.json()) as { id: string };
  const task = await request.put("/api/v1/ai/tasks/vision", {
    data: { provider_id: provider.id, model: "gpt-4o", enabled: true },
  });
  expect(task.ok()).toBeTruthy();

  // The old scan address opens Add items with the room already chosen, and no container.
  await page.goto(`/scan?room_id=${room.id}`);
  const addItems = page.getByRole("dialog", { name: "Add items" });
  await expect(addItems.getByRole("button", { name: `Place: ${room.name}. Change` })).toBeVisible();
  await addItems.getByTestId("smart-add-camera").setInputFiles(photoPath);
  await addItems.getByRole("button", { name: "Review items" }).click();
  const review = page
    .getByTestId("assistant-panel")
    .getByRole("region", { name: "Assistant item review" });
  await expect(review.getByRole("heading", { name: "Photo review: icon-192.png" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(review.getByText(/4 proposals/)).toBeVisible();
  const batches = (await (await request.get("/api/v1/imports?limit=1")).json()) as {
    items: Array<{ id: string }>;
  };
  const batch = (await (await request.get(`/api/v1/imports/${batches.items[0]!.id}`)).json()) as {
    metadata: { ai_provider: string; ai_model: string };
  };
  expect(batch.metadata).toMatchObject({ ai_provider: "openai", ai_model: "gpt-4o" });

  // Nothing is selected for the person: not the fixed features, not the unsure one,
  // and not the heater either.
  for (const name of [`Window ${scanSuffix}`, `Radiator ${scanSuffix}`, `Mystery object ${scanSuffix}`, heaterName]) {
    await expect(review.getByRole("checkbox", { name: `Select ${name}` })).not.toBeChecked();
  }
  await expect(review.getByRole("article", { name: `Mystery object ${scanSuffix}` })).toContainText("22% sure");
  // A window and a radiator are parts of the building. The closed row says so, before
  // anything is opened or added. The heater has no such warning.
  const windowRow = review.getByRole("article", { name: `Window ${scanSuffix}` });
  const radiatorRow = review.getByRole("article", { name: `Radiator ${scanSuffix}` });
  const heaterRow = review.getByRole("article", { name: heaterName });
  await expect(windowRow.getByRole("button", { name: "Edit" })).toHaveAttribute("aria-expanded", "false");
  await expect(windowRow.getByText(/^Check: /))
    .toContainText("Windows are fixed architectural features, not movable possessions.");
  await expect(radiatorRow.getByText(/^Check: /)).toContainText("Radiators are usually installed fixtures.");
  await expect(heaterRow).not.toContainText(/fixed architectural|installed fixtures/i);
  // The full reason is in the row's details.
  await windowRow.getByRole("button", { name: "Edit" }).click();
  await expect(windowRow.getByText(/fixed architectural features/i).first()).toBeVisible();
  await windowRow.getByRole("button", { name: "Close" }).click();

  await heaterRow.getByRole("button", { name: "Edit" }).click();
  await expect(heaterRow.getByLabel(/^Room/)).toHaveValue(room.id);
  await expect(heaterRow.getByLabel(/^Storage place/)).toHaveValue("");
  await heaterRow.getByLabel(/^Room/).selectOption(otherRoom.id);
  await expect(heaterRow.getByLabel(/^Storage place/)).toHaveValue("");
  // Only the heater is ticked, so only the heater is added.
  await review.getByRole("checkbox", { name: `Select ${heaterName}` }).check();
  await review.getByRole("button", { name: "Add 1 selected item" }).first().click();
  await expect(page.getByText("1 item added")).toBeVisible();
  await expect(review.getByText(/4 proposals · 1 imported/)).toBeVisible();

  const itemsResponse = await request.get(
    `/api/v1/items?limit=100&room_id=${otherRoom.id}`,
  );
  expect(itemsResponse.ok()).toBeTruthy();
  const items = (await itemsResponse.json()) as {
    items: Array<{ name: string; room: { id: string }; location: unknown }>;
  };
  const heater = items.items.find((item) => item.name === heaterName);
  expect(heater).toBeTruthy();
  expect(heater?.room.id).toBe(otherRoom.id);
  expect(heater?.location).toBeNull();
  expect(
    items.items.some((item) => item.name === `Window ${scanSuffix}`),
  ).toBe(false);
  expect(
    items.items.some((item) => item.name === `Radiator ${scanSuffix}`),
  ).toBe(false);
});

test("imports the actual Inventory.md, excludes indexes/templates and prevents duplicate items", async ({
  page,
  request,
}) => {
  const purchasesBefore = (await (await request.get("/api/v1/purchases")).json()) as {
    total: number;
  };
  const batch = await uploadFixture(request, `Actual hierarchy ${Date.now()}`);
  await waitForImport(request, batch.id);
  await page.goto(`/imports/${batch.id}`);
  await expect(page.getByText("Structured hierarchy")).toBeVisible();
  // Rooms, containers and items are rows of one tree.
  for (const name of ["Storage", "Storage room 2", "STO-03", "Keyboards (incl. Dell keyboard)", "Ethernet cables + long ethernet cable"]) {
    await expect(page.getByRole("article", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByText("Source reference").first()).toBeVisible();
  await expect(page.getByText("Sample item")).toHaveCount(0);
  await expect(page.getByText("Possible duplicate")).toHaveCount(0);
  const detailBefore = await (
    await request.get(`/api/v1/imports/${batch.id}`)
  ).json();
  expect(detailBefore.metadata.hierarchy_nodes).toBe(8);
  expect(detailBefore.metadata.hierarchy_items).toBe(52);
  expect(detailBefore.metadata.ai_used).toBe(false);

  // Nothing is selected at first. The button counts every record: rooms, containers, items.
  await expect(page.getByRole("button", { name: "Add selected records" }).first()).toBeDisabled();
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: "Add 60 selected records" }).first().click();
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
  expect(purchases.total).toBe(purchasesBefore.total);

  const duplicateBatch = await uploadFixture(request, `Actual duplicate ${Date.now()}`);
  await waitForImport(request, duplicateBatch.id);
  await page.goto(`/imports/${duplicateBatch.id}`);
  const keyboardRow = page
    .locator("article")
    .filter({ has: page.getByRole("checkbox", { name: "Select Keyboards (incl. Dell keyboard)" }) })
    .first();
  await expect(keyboardRow.getByText("Possible duplicate")).toBeVisible();
  // Nothing is selected to begin with, and there is no action dropdown.
  await expect(
    keyboardRow.getByRole("checkbox", { name: "Select Keyboards (incl. Dell keyboard)" }),
  ).not.toBeChecked();

  await keyboardRow
    .getByRole("checkbox", { name: "Select Keyboards (incl. Dell keyboard)" })
    .check();
  await page.getByRole("button", { name: /^Add \d+ selected records?$/ }).first().click();
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
