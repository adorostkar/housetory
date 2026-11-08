import http from "node:http";
import { AddressInfo } from "node:net";

import fs from "node:fs/promises";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const MOCK_PORT = 50555;
let mockServer: http.Server;
let aiCalls = 0;

function currencyPayload(purpose: string) {
  const replacement = purpose === "replacement";
  return {
    currency: "USD",
    low_cents: replacement ? 7000 : 3500,
    suggested_cents: replacement ? 8000 : 4000,
    high_cents: replacement ? 9000 : 5000,
    confidence: replacement ? "low" : "medium",
    reasoning: replacement
      ? "Comparable replacement listings are broad and vary by availability."
      : "Comparable used listings support this range for the recorded condition.",
    assumptions: [
      replacement
        ? "A comparable replacement is available in the same condition."
        : "Battery and charger are included.",
    ],
  };
}

test.beforeAll(async () => {
  mockServer = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST" && requestUrl.pathname.endsWith("/chat/completions")) {
      aiCalls += 1;
      let purpose = "resale";
      const normalizedBody = body.replaceAll('\\"', '"');
      if (/"purpose":\s*"replacement"/.test(normalizedBody)) {
        purpose = "replacement";
      }
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(currencyPayload(purpose)),
              },
            },
          ],
        }),
      );
      return;
    }
    if (request.method === "GET" && requestUrl.pathname.endsWith("/res/v1/web/search")) {
      response.end(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Used market camera listing",
                url: "https://example.com/used-camera",
                description: "Good condition camera, asking USD 45.00.",
                extra_snippets: ["Includes battery and charger."],
              },
              {
                title: "Replacement camera availability",
                url: "https://example.org/replacement-camera",
                description: "Comparable replacement listed around USD 120.00.",
              },
            ],
          },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => mockServer.listen(MOCK_PORT, "0.0.0.0", resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
});

async function headers(request: APIRequestContext) {
  const response = await request.get("/api/v1/auth/session");
  const state = (await response.json()) as { household: { id: string } };
  return { "X-Household-Id": state.household.id };
}

async function createRoom(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/rooms", {
    headers: await headers(request),
    data: { name },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string };
}

async function createItem(
  request: APIRequestContext,
  name: string,
  roomId: string,
  quantity = 2,
) {
  const response = await request.post("/api/v1/items", {
    headers: await headers(request),
    data: {
      name,
      room_id: roomId,
      quantity,
      condition: "good",
      brand: "Fujifilm",
      model: "X-T4",
      description: "Mirrorless camera with battery and charger.",
      serial_number: "SERIAL-PRIVATE-VALUATION",
      purchase: {
        merchant: "Camera Shop",
        purchase_date: "2024-05-01",
        price_cents: 120000,
        currency: "USD",
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

async function configureProviders(request: APIRequestContext) {
  const provider = await request.post("/api/v1/ai/providers", {
    headers: await headers(request),
    data: {
      provider: "openai",
      display_name: "Valuation E2E mock",
      base_url: `http://host.docker.internal:${MOCK_PORT}/v1`,
      default_model: "valuation-mock",
      api_key: "sk-valuation-e2e-not-real",
      enabled: true,
      cloud_consent: true,
    },
  });
  expect(provider.ok()).toBeTruthy();
  const online = await request.put("/api/v1/settings/online-search", {
    headers: await headers(request),
    data: {
      manual_enabled: true,
      api_key: "brave-valuation-e2e-not-real",
    },
  });
  expect(online.ok()).toBeTruthy();
}

async function itemDetail(request: APIRequestContext, itemId: string) {
  const response = await request.get(`/api/v1/items/${itemId}`, {
    headers: await headers(request),
  });
  expect(response.ok()).toBeTruthy();
  return (
    (await response.json()) as {
      item: {
        current_value_cents: number | null;
        current_value_total_cents: number | null;
        current_value_basis: string | null;
        current_value_estimate: {
          purpose: string;
          source: string;
          confidence: string | null;
          sources: Array<{ url: string; price_kind: string }>;
        } | null;
      };
    }
  ).item;
}

async function shot(page: Page, name: string) {
  await fs.mkdir("../../docs/walkthrough/item-valuation", { recursive: true });
  await page.screenshot({
    path: `../../docs/walkthrough/item-valuation/${name}.png`,
    fullPage: false,
    animations: "disabled",
  });
}

test("on-demand item valuation previews, purpose separation, manual entry and responsive layout", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await configureProviders(request);
  const room = await createRoom(request, "Valuation E2E room");
  const item = await createItem(request, "Mirrorless camera", room.id, 2);
  const manualItem = await createItem(request, "Manual value tripod", room.id, 1);

  await page.goto(`/items/${item.item.id}`);
  await page.getByRole("button", { name: "Estimate value" }).click();
  await expect(
    page.getByRole("radio", { name: /Resale value/ }),
  ).toBeChecked();
  await expect(
    page.getByRole("radio", { name: /Replacement value/ }),
  ).not.toBeChecked();
  await shot(page, "01-valuation-purpose");

  await page.getByRole("checkbox", { name: /Try online comparisons/ }).check();
  await page.getByRole("button", { name: "Get AI estimate" }).click();
  const preview = page.getByTestId("valuation-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Range $35 – $50 per unit");
  await expect(preview).toContainText("2 owned units");
  await expect(preview).toContainText("$80 owned total");
  await expect(preview).toContainText("Used market camera listing");
  await expect(preview).toContainText("asking/listed price");
  await expect(preview).toContainText("not a professional appraisal");
  await shot(page, "02-valuation-preview-web");

  await page.getByLabel("Per-unit value").fill("42");
  await expect(page.getByTestId("valuation-save-total")).toContainText(
    "$84 owned total",
  );
  await page.getByRole("button", { name: "Apply value" }).click();
  await expect(page.getByRole("dialog", { name: "Estimate value" })).toBeHidden();
  await expect(page.getByText(/Resale estimate/)).toBeVisible();
  await expect(page.getByText(/\$42 per unit/)).toBeVisible();
  await expect(page.getByText(/\$84 total/)).toBeVisible();
  const saved = await itemDetail(request, item.item.id);
  expect(saved.current_value_cents).toBe(4200);
  expect(saved.current_value_total_cents).toBe(8400);
  expect(saved.current_value_basis).toBe("per_unit");
  expect(saved.current_value_estimate).toMatchObject({
    purpose: "resale",
    source: "ai_web",
    confidence: "medium",
  });
  expect(saved.current_value_estimate?.sources[0]).toMatchObject({
    url: "https://example.com/used-camera",
    price_kind: "asking",
  });
  await shot(page, "03-item-applied-value");

  const savedValue = saved.current_value_cents;
  await page.getByRole("button", { name: "Estimate value" }).click();
  await page.getByText("Replacement value", { exact: true }).click();
  await expect(page.getByTestId("valuation-preview")).toBeHidden();
  await page.getByRole("button", { name: "Get AI estimate" }).click();
  await expect(page.getByTestId("valuation-preview")).toContainText(
    "Range $70 – $90 per unit",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await itemDetail(request, item.item.id)).current_value_cents).toBe(
    savedValue,
  );

  const callsBeforeManual = aiCalls;
  await page.goto(`/items/${manualItem.item.id}`);
  await page.getByRole("button", { name: "Estimate value" }).click();
  await page.getByLabel("Per-unit value").fill("25");
  await page.getByRole("button", { name: "Apply value" }).click();
  await expect(page.getByRole("dialog", { name: "Estimate value" })).toBeHidden();
  expect(aiCalls).toBe(callsBeforeManual);
  const manual = await itemDetail(request, manualItem.item.id);
  expect(manual.current_value_cents).toBe(2500);
  expect(manual.current_value_estimate).toMatchObject({
    purpose: "resale",
    source: "manual",
    confidence: null,
  });

  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/items/${item.item.id}`);
    await page.getByRole("button", { name: "Estimate value" }).click();
    await expect(
      page.getByRole("heading", { name: "Estimate value" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    if (width === 390) await shot(page, "04-valuation-mobile");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  }
});
