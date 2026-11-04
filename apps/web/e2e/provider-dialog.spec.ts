import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";

const LONG_PATH = `organizations/${"very-long-endpoint-segment-".repeat(5)}`;
const LONG_SUFFIX = "x".repeat(120);
const LONG_NAME = "Y".repeat(110);
const MODEL_COUNT = 300;

let mockServer: http.Server;
let mockPort = 0;

const catalog = Array.from({ length: MODEL_COUNT }, (_, index) => ({
  id: `openrouter/vendor-${index}/model-${index}-${index}-${LONG_SUFFIX}`,
  name: `Model ${index} with an extremely long display name ${LONG_NAME}`,
  architecture: {
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
  },
  supported_parameters: ["tools", "structured_outputs"],
}));

test.beforeAll(async () => {
  mockServer = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request body; catalog requests are GETs.
    }
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      response.end(JSON.stringify({ data: catalog }));
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

function providerBaseUrl() {
  return `http://host.docker.internal:${mockPort}/${LONG_PATH}`;
}

async function resetProviders(request: APIRequestContext) {
  const response = await request.get("/api/v1/ai/settings");
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { providers: Array<{ id: string }> };
  for (const provider of body.providers) {
    const deleted = await request.delete(`/api/v1/ai/providers/${provider.id}`);
    expect(deleted.status()).toBe(204);
  }
}

async function horizontalMetrics(locator: Locator) {
  return locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
}

async function expectNoHorizontalOverflow(locator: Locator, label: string) {
  const metrics = await horizontalMetrics(locator);
  expect(
    metrics.scrollWidth,
    `${label} content width ${metrics.scrollWidth} exceeds ${metrics.clientWidth}`,
  ).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function expectDialogInsideViewport(page: Page, dialog: Locator) {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x, "dialog left edge").toBeGreaterThanOrEqual(-1);
  expect(box!.y, "dialog top edge").toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, "dialog right edge").toBeLessThanOrEqual(
    viewport!.width + 1,
  );
  expect(box!.y + box!.height, "dialog bottom edge").toBeLessThanOrEqual(
    viewport!.height + 1,
  );
  await expectNoHorizontalOverflow(dialog, "dialog");

  const documentMetrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    documentMetrics.scrollWidth,
    "page has a horizontal scrollbar",
  ).toBeLessThanOrEqual(documentMetrics.clientWidth + 1);
}

async function expectInsideDialogHorizontally(
  dialog: Locator,
  locator: Locator,
  label: string,
) {
  const dialogBox = await dialog.boundingBox();
  const box = await locator.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(box, `${label} is not rendered`).not.toBeNull();
  expect(box!.x, `${label} left edge`).toBeGreaterThanOrEqual(dialogBox!.x - 1);
  expect(box!.x + box!.width, `${label} right edge`).toBeLessThanOrEqual(
    dialogBox!.x + dialogBox!.width + 1,
  );
}

async function expectFooterReachable(
  page: Page,
  dialog: Locator,
  label: RegExp,
) {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const button = dialog.getByRole("button", { name: label });
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x, `${label} left edge`).toBeGreaterThanOrEqual(-1);
  expect(box!.y, `${label} top edge`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${label} right edge`).toBeLessThanOrEqual(
    viewport!.width + 1,
  );
  expect(box!.y + box!.height, `${label} bottom edge`).toBeLessThanOrEqual(
    viewport!.height + 1,
  );
  await expectInsideDialogHorizontally(dialog, button, `${label} button`);
  return button;
}

async function assertDialogLayout(
  page: Page,
  dialog: Locator,
  size: string,
) {
  await expectDialogInsideViewport(page, dialog);
  const fields = [
    { label: "Display name", locator: dialog.getByLabel("Display name", { exact: true }) },
    { label: "Base URL", locator: dialog.getByLabel("Base URL", { exact: true }) },
    {
      label: "Default model",
      locator: dialog.getByRole("combobox", { name: "Default model" }),
    },
    { label: "API key", locator: dialog.getByLabel(/^API key/) },
  ];
  for (const { label, locator } of fields) {
    await expect(locator).toBeVisible();
    await expectInsideDialogHorizontally(dialog, locator, `${size} ${label}`);
  }
  for (const label of [/Cancel/, /Save endpoint\/key & refresh/, /Save selected model/]) {
    await expectFooterReachable(page, dialog, label);
  }
}

async function openModelList(dialog: Locator, picker: Locator) {
  await picker.scrollIntoViewIfNeeded();
  await picker.click();
  const listbox = dialog.getByRole("listbox");
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option").first()).toBeVisible();
  return listbox;
}

test.describe("provider dialog responsive layout", () => {
  test("fits after discovery, keeps the model list usable and escapes without closing the dialog", async ({
    page,
    request,
  }) => {
    await resetProviders(request);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/settings/ai");
    await page.getByRole("button", { name: "Add provider" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Add provider" })).toBeVisible();
    await dialog.getByLabel("Provider", { exact: true }).selectOption("openrouter");
    await dialog.getByLabel("Display name").fill(`Overflow test ${"D".repeat(60)}`);
    await dialog.getByLabel("Base URL").fill(providerBaseUrl());
    await dialog.getByLabel("API key").fill("sk-test-not-real");
    await dialog
      .getByRole("button", { name: /Save provider & discover models/ })
      .click();

    await expect(
      dialog.getByRole("heading", { name: "Edit provider" }),
    ).toBeVisible();
    await expect(
      dialog.getByText(/Provider saved and models discovered/),
    ).toBeVisible();

    const picker = dialog.getByRole("combobox", { name: "Default model" });
    const listbox = await openModelList(dialog, picker);
    await expect(dialog.getByText(/Showing 50 of 300/)).toBeVisible();

    const shotPrefix = process.env.E2E_SHOT_PREFIX;
    if (shotPrefix) {
      fs.mkdirSync(path.dirname(shotPrefix), { recursive: true });
      await page.screenshot({ path: `${shotPrefix}-desktop.png` });
    }

    await assertDialogLayout(page, dialog, "desktop");
    await expectNoHorizontalOverflow(listbox, "desktop model list");
    const listMetrics = await listbox.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(listMetrics.scrollHeight).toBeGreaterThan(listMetrics.clientHeight);
    const firstOption = listbox.getByRole("option").first();
    await expectInsideDialogHorizontally(dialog, firstOption, "desktop model option");
    await expectNoHorizontalOverflow(firstOption, "desktop model option");

    await picker.fill("model-247-");
    await expect(listbox.getByRole("option")).toHaveCount(1);
    await expect(listbox.getByRole("option")).toContainText("Model 247");

    await picker.press("Escape");
    await expect(listbox).not.toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Base URL")).toHaveValue(providerBaseUrl());
    await expect(dialog.getByLabel("Display name")).toHaveValue(
      `Overflow test ${"D".repeat(60)}`,
    );

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();

    await page.getByRole("button", { name: "Edit provider" }).first().click();
    const reopened = page.getByRole("dialog");
    await expect(reopened.getByRole("heading", { name: "Edit provider" })).toBeVisible();

    for (const viewport of [
      { width: 900, height: 560, label: "narrow desktop" },
      { width: 393, height: 852, label: "mobile" },
      { width: 320, height: 568, label: "narrow mobile" },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await assertDialogLayout(page, reopened, viewport.label);
      const reopenedPicker = reopened.getByRole("combobox", {
        name: "Default model",
      });
      const reopenedList = await openModelList(reopened, reopenedPicker);
      await expectNoHorizontalOverflow(reopenedList, `${viewport.label} model list`);
      await expectInsideDialogHorizontally(
        reopened,
        reopenedList,
        `${viewport.label} model list`,
      );
      if (viewport.width === 393 && shotPrefix) {
        await page.screenshot({ path: `${shotPrefix}-${viewport.width}.png` });
      }
      await reopenedPicker.press("Escape");
      await expect(reopenedList).not.toBeVisible();
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    const finalPicker = reopened.getByRole("combobox", { name: "Default model" });
    const finalList = await openModelList(reopened, finalPicker);
    await finalPicker.fill("model-247-");
    await expect(finalList.getByRole("option")).toHaveCount(1);
    await finalPicker.press("ArrowDown");
    await finalPicker.press("Enter");
    await reopened
      .getByRole("button", { name: /Save selected model/ })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    const settingsResponse = await request.get("/api/v1/ai/settings");
    expect(settingsResponse.ok()).toBeTruthy();
    const settings = (await settingsResponse.json()) as {
      providers: Array<{ provider: string; default_model: string | null }>;
    };
    expect(settings.providers).toContainEqual(
      expect.objectContaining({
        provider: "openrouter",
        default_model: catalog[247]!.id,
      }),
    );
  });
});
