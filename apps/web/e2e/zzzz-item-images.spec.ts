import fs from "node:fs/promises";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAaElEQVR4nNXOQREAIAzAsFKZiEAJohGxB9coyNr3UCZxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEufvwNQD/V4BtOYVtIgAAAAASUVORK5CYII=",
  "base64",
);

const REFERENCE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420"><rect width="640" height="420" fill="#e7efe9"/><rect x="150" y="80" width="340" height="210" rx="14" fill="#27332d"/><rect x="175" y="105" width="290" height="160" rx="6" fill="#89a99a"/><path d="M260 330h120M320 290v40" stroke="#27332d" stroke-width="14" stroke-linecap="round"/><text x="320" y="390" text-anchor="middle" font-family="serif" font-size="28" fill="#27332d">LG OLED reference</text></svg>`;

const AI_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420"><rect width="640" height="420" fill="#f1e8dd"/><path d="M210 250c0-55 45-100 110-100s110 45 110 100" fill="none" stroke="#6f5f4f" stroke-width="22"/><rect x="180" y="245" width="280" height="80" rx="28" fill="#c8a67d"/><path d="M210 325v35M430 325v35" stroke="#6f5f4f" stroke-width="18" stroke-linecap="round"/><text x="320" y="390" text-anchor="middle" font-family="serif" font-size="28" fill="#6f5f4f">AI chair illustration</text></svg>`;

interface SessionState {
  household: { id: string; name: string };
}

async function currentHeaders(request: APIRequestContext) {
  const response = await request.get("/api/v1/auth/session");
  const session = (await response.json()) as SessionState;
  return { "X-Household-Id": session.household.id };
}

async function createRoom(request: APIRequestContext, name: string) {
  const headers = await currentHeaders(request);
  const propertiesResponse = await request.get("/api/v1/properties", { headers });
  expect(propertiesResponse.ok()).toBeTruthy();
  const properties = (await propertiesResponse.json()) as {
    items: Array<{ id: string }>;
  };
  const response = await request.post("/api/v1/rooms", {
    headers,
    data: { name, property_id: properties.items[0]?.id },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string };
}

async function createItem(
  request: APIRequestContext,
  name: string,
  roomId: string,
  extra: Record<string, unknown> = {},
) {
  const response = await request.post("/api/v1/items", {
    headers: await currentHeaders(request),
    data: { name, room_id: roomId, ...extra },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: Record<string, unknown> & { id: string } };
}

function image(
  sourceType: "reference" | "ai" | "builtin",
  overrides: Record<string, unknown> = {},
) {
  return {
    id: sourceType === "builtin" ? null : `image-${sourceType}`,
    source_type: sourceType,
    label:
      sourceType === "reference"
        ? "Reference image"
        : sourceType === "ai"
          ? "AI illustration"
          : "Generic illustration",
    status: "active",
    illustration_key: sourceType === "builtin" ? "tv" : null,
    url:
      sourceType === "builtin"
        ? null
        : `/api/v1/item-images/image-${sourceType}/file`,
    thumbnail_url:
      sourceType === "builtin"
        ? null
        : `/api/v1/item-images/image-${sourceType}/thumbnail`,
    width: sourceType === "builtin" ? null : 640,
    height: sourceType === "builtin" ? null : 420,
    source_name: sourceType === "reference" ? "lg.com" : sourceType === "ai" ? "OpenAI" : null,
    source_url:
      sourceType === "reference" ? "https://media.lg.com/oled.png" : null,
    source_page_url:
      sourceType === "reference" ? "https://www.lg.com/us/tvs/oled" : null,
    license_note:
      sourceType === "reference"
        ? "Download allowed by the server's configured permitted-source policy for lg.com. Source page and retrieval time are recorded. This records an operator policy, not a legal determination or permission guarantee; review the source's terms before reuse."
        : null,
    license_name: null,
    license_url: null,
    permission_basis: sourceType === "reference" ? "configured_source_policy" : null,
    retrieved_at: sourceType === "builtin" ? null : "2026-11-06T00:00:00Z",
    exact_model_confirmed: false,
    model_label: null,
    provider_label: sourceType === "ai" ? "OpenAI Images" : null,
    automatic: sourceType === "builtin",
    created_at: sourceType === "builtin" ? null : "2026-11-06T00:00:00Z",
    ...overrides,
  };
}

function imageState(
  itemId: string,
  selected: ReturnType<typeof image> | null,
  overrides: Record<string, unknown> = {},
) {
  const builtin = image("builtin");
  return {
    item_id: itemId,
    actual_photo_count: 0,
    image: selected ?? builtin,
    selected,
    automatic_builtin: builtin,
    pending: [],
    builtin_options: [
      { key: "tv", label: "Television" },
      { key: "chair", label: "Chair" },
      { key: "generic", label: "Generic item" },
    ],
    settings: {
      auto_reference: false,
      auto_generate: false,
      daily_generation_cap: 10,
      daily_generations_used: 0,
      daily_generations_remaining: 10,
    },
    search_configured: true,
    search_provider_label: "Brave Image Search API",
    search_reason: null,
    generation_configured: true,
    generation_provider_label: "OpenAI Images",
    generation_reason: null,
    ...overrides,
  };
}

async function mockImageAsset(page: Page, kind: "reference" | "ai") {
  const body = kind === "reference" ? REFERENCE_SVG : AI_SVG;
  await page.route(`**/api/v1/item-images/image-${kind}/thumbnail`, (route) =>
    route.fulfill({ status: 200, contentType: "image/svg+xml", body }),
  );
  await page.route(`**/api/v1/item-images/image-${kind}/file`, (route) =>
    route.fulfill({ status: 200, contentType: "image/svg+xml", body }),
  );
}

test("built-in fallback, automatic reference selection, and actual-photo priority", async ({
  page,
  request,
}) => {
  await fs.mkdir("../../docs/walkthrough/item-images", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const id = suffix();
  const room = await createRoom(request, `Images room ${id}`);
  const item = await createItem(request, `LG OLED TV ${id}`, room.id, {
    brand: "LG",
    description: "OLED television, 77-inch, slim bezel",
  });
  await mockImageAsset(page, "reference");
  let found = false;
  const reference = image("reference");
  await page.route(new RegExp(`/api/v1/items/${item.item.id}/image$`), async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      json: found
        ? imageState(item.item.id, reference)
        : imageState(item.item.id, null),
    });
  });
  await page.route(
    new RegExp(`/api/v1/items/${item.item.id}/image/find$`),
    async (route) => {
      found = true;
      await route.fulfill({
        status: 200,
        json: imageState(item.item.id, reference),
      });
    },
  );
  const detailResponse = await request.get(`/api/v1/items/${item.item.id}`);
  const detail = await detailResponse.json();
  await page.route(new RegExp(`/api/v1/items/${item.item.id}$`), async (route) => {
    if (route.request().method() !== "GET" || !found) return route.continue();
    await route.fulfill({
      status: 200,
      json: {
        item: {
          ...detail.item,
          primary_photo: null,
          representative_image: reference,
        },
      },
    });
  });

  await page.goto(`/items/${item.item.id}`);
  await expect(page.getByRole("img", { name: "Generic illustration" })).toBeVisible();
  await expect(page.getByText("Generic illustration").first()).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/item-images/01-builtin-light.png",
    fullPage: false,
  });

  await page.getByRole("button", { name: "Find image" }).click();
  await expect(page.getByText("Reference image").first()).toBeVisible();
  await expect(page.getByText(/exact model not confirmed/i).first()).toBeVisible();
  await expect(page.getByText(/lg\.com/).first()).toBeVisible();
  await expect(page.getByRole("img", { name: /reference image/i }).first()).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/item-images/02-reference-light.png",
    fullPage: false,
  });

  await page.getByRole("button", { name: "Switch to dark mode" }).first().click();
  await page.locator("html.dark").waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({
    path: "../../docs/walkthrough/item-images/03-reference-dark.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "Switch to light mode" }).first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "../../docs/walkthrough/item-images/04-reference-mobile.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  const uploaded = await request.post(`/api/v1/items/${item.item.id}/photos`, {
    headers: await currentHeaders(request),
    multipart: {
      files: {
        name: "actual.png",
        mimeType: "image/png",
        buffer: PNG_1X1,
      },
    },
  });
  expect(uploaded.ok(), await uploaded.text()).toBeTruthy();
  await page.unroute(new RegExp(`/api/v1/items/${item.item.id}$`));
  await page.unroute(new RegExp(`/api/v1/items/${item.item.id}/image$`));
  await page.reload();
  await expect(page.getByRole("img", { name: item.item.name as string })).toBeVisible();
  await expect(page.getByText("Actual photo is used")).toBeVisible();
  await expect(page.getByRole("button", { name: "Find image" })).toHaveCount(0);
  await page.screenshot({
    path: "../../docs/walkthrough/item-images/05-actual-photo-priority.png",
    fullPage: false,
  });
});

test("manual AI preview, explicit accept, and unconfigured search state", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  const id = suffix();
  const room = await createRoom(request, `AI image room ${id}`);
  const item = await createItem(request, `Oak reading chair ${id}`, room.id, {
    description: "Oak frame, pale fabric, reading chair for the study",
  });
  await mockImageAsset(page, "ai");
  const builtinState = imageState(item.item.id, null, {
    search_configured: false,
    search_reason: "Set BRAVE_SEARCH_API_KEY to use reference-image search.",
  });
  const pendingImage = image("ai", { id: "image-ai", status: "pending" });
  const activeImage = image("ai", { id: "image-ai", status: "active", automatic: false });
  await page.route(new RegExp(`/api/v1/items/${item.item.id}/image$`), async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, json: builtinState });
    } else {
      await route.continue();
    }
  });
  await page.route(
    new RegExp(`/api/v1/items/${item.item.id}/illustration$`),
    async (route) => {
      await route.fulfill({
        status: 200,
        json: imageState(item.item.id, null, {
          search_configured: false,
          pending: [pendingImage],
        }),
      });
    },
  );
  await page.route(
    new RegExp(`/api/v1/items/${item.item.id}/images/image-ai/accept$`),
    async (route) => {
      await route.fulfill({
        status: 200,
        json: imageState(item.item.id, activeImage, {
          search_configured: false,
          generation_configured: true,
        }),
      });
    },
  );

  await page.goto(`/items/${item.item.id}`);
  await expect(
    page.getByText("Set BRAVE_SEARCH_API_KEY to use reference-image search."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByText("AI illustration preview")).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/item-images/06-ai-preview-light.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await expect(page.getByText("AI illustration").first()).toBeVisible();
  await expect(page.getByText(/not a photo/).first()).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/item-images/07-ai-accepted-light.png",
    fullPage: false,
  });
});

test("household image settings and explicit batch cancellation", async ({ page, request }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  const autoReference = page.getByLabel(/Automatically find a reference image/);
  if (!(await autoReference.isChecked())) await autoReference.check();
  const autoGenerate = page.getByLabel(/Fall back to an AI illustration/);
  if (!(await autoGenerate.isChecked())) await autoGenerate.check();
  const cap = String(3 + (Date.now() % 80));
  await page.getByLabel(/Daily AI illustration cap/).fill(cap);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Household settings updated")).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/item-images/08-household-settings-light.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "../../docs/walkthrough/item-images/09-household-settings-mobile.png",
    fullPage: false,
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/items");
  await page.getByLabel("Select all loaded items").check();
  await page.route("**/api/v1/items/images/batch/preview", (route) =>
    route.fulfill({
      status: 200,
      json: {
        action: "reference",
        selected_count: 2,
        eligible_count: 2,
        skipped_has_photo: 0,
        skipped_unavailable: 0,
        estimated_generations: 0,
        daily_generation_remaining: 2,
        hard_cap: 50,
        notices: [],
      },
    }),
  );
  await page.route("**/api/v1/items/images/batch", (route) =>
    route.fulfill({
      status: 202,
      json: {
        job_id: "job-images-1",
        status: "queued",
        action: "reference",
        total: 2,
        completed: 0,
        failed: 0,
        skipped: 0,
        error: null,
        created_at: "2026-11-06T00:00:00Z",
        finished_at: null,
      },
    }),
  );
  await page.route("**/api/v1/items/images/batch/job-images-1/cancel", (route) =>
    route.fulfill({
      status: 200,
      json: {
        job_id: "job-images-1",
        status: "cancelled",
        action: "reference",
        total: 2,
        completed: 0,
        failed: 0,
        skipped: 0,
        error: null,
        created_at: "2026-11-06T00:00:00Z",
        finished_at: "2026-11-06T00:01:00Z",
      },
    }),
  );
  await page.route("**/api/v1/items/images/batch/job-images-1", (route) =>
    route.fulfill({
      status: 200,
      json: {
        job_id: "job-images-1",
        status: "running",
        action: "reference",
        total: 2,
        completed: 0,
        failed: 0,
        skipped: 0,
        error: null,
        created_at: "2026-11-06T00:00:00Z",
        finished_at: null,
      },
    }),
  );

  await page.getByRole("button", { name: "Images" }).click();
  const dialog = page.getByRole("dialog", { name: "Find images for selected items" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Eligible")).toBeVisible();
  await dialog.getByRole("button", { name: "Start batch" }).click();
  await expect(dialog.getByText(/Queued|Running/)).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "../../docs/walkthrough/item-images/10-batch-queued-light.png",
    fullPage: false,
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "Cancel batch" }).click();
  await expect(dialog.getByText("Cancelled")).toBeVisible();
});

test("existing item generation stays opt-in and no external provider is required", async ({
  request,
}) => {
  await request.patch("/api/v1/household", {
    headers: await currentHeaders(request),
    data: {
      item_image_auto_reference: false,
      item_image_auto_generate: false,
    },
  });
  const id = suffix();
  const room = await createRoom(request, `No image AI room ${id}`);
  const item = await createItem(request, `Plain storage box ${id}`, room.id, {
    description: "Plain cardboard storage box",
  });
  const state = await request.get(`/api/v1/items/${item.item.id}/image`);
  expect(state.ok()).toBeTruthy();
  const body = await state.json();
  expect(body["selected"]).toBeNull();
  expect(body["automatic_builtin"]["illustration_key"]).toBe("box");
  expect(body["generation_configured"]).toBe(false);
});
