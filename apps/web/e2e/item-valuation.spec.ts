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
  const existingResponse = await request.get("/api/v1/ai/settings", {
    headers: await headers(request),
  });
  expect(existingResponse.ok()).toBeTruthy();
  const existing = (await existingResponse.json()) as {
    providers: Array<{ id: string; display_name: string }>;
  };
  const previous = existing.providers.find(
    (entry) => entry.display_name === "Valuation E2E mock",
  );
  const payload = {
    provider: "openai",
    display_name: "Valuation E2E mock",
    base_url: `http://host.docker.internal:${MOCK_PORT}/v1`,
    default_model: "valuation-mock",
    api_key: "sk-valuation-e2e-not-real",
    enabled: true,
    cloud_consent: true,
  };
  const provider = previous
    ? await request.patch(`/api/v1/ai/providers/${previous.id}`, {
        headers: await headers(request),
        data: payload,
      })
    : await request.post("/api/v1/ai/providers", {
        headers: await headers(request),
        data: payload,
      });
  expect(provider.ok()).toBeTruthy();
  const providerBody = (await provider.json()) as { id: string };
  const online = await request.put("/api/v1/settings/online-search", {
    headers: await headers(request),
    data: {
      manual_enabled: true,
      api_key: "e2e-fixture-key",
    },
  });
  expect(online.ok()).toBeTruthy();
  return providerBody.id;
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

test("insurance list uses AI replacement estimates without changing item values", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  const valuationProviderId = await configureProviders(request);
  const room = await createRoom(request, `Valuation E2E room ${Date.now()}`);
  const item = await createItem(request, "Mirrorless camera", room.id, 2);

  await page.goto(`/insurance?item_ids=${item.item.id}`);
  await page.getByRole("button", { name: "Estimate 1 with AI" }).click();
  const amount = page.getByLabel("Replacement value for Mirrorless camera");
  await expect(amount).toHaveValue("80.00");
  await amount.fill("85");
  await expect(page.getByText("$170", { exact: true })).toBeVisible();
  await shot(page, "01-insurance-review");

  await page.getByRole("button", { name: "Generate insurance list" }).click();
  const pdfLink = page.getByRole("link", { name: "Download PDF" });
  await expect(pdfLink).toBeVisible();
  const csvLink = page.getByRole("link", { name: "Download CSV" });
  await expect(csvLink).toBeVisible();
  expect(aiCalls).toBeGreaterThan(0);

  const pdf = await request.get((await pdfLink.getAttribute("href"))!);
  expect(pdf.ok()).toBeTruthy();
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  const csv = await request.get((await csvLink.getAttribute("href"))!);
  expect(csv.ok()).toBeTruthy();
  expect(await csv.text()).toContain("replacement_value_total_cents");
  expect(await csv.text()).toContain("17000");

  const saved = await itemDetail(request, item.item.id);
  expect(saved.current_value_cents).toBeNull();
  expect(saved.current_value_basis).toBeNull();
  expect(saved.current_value_estimate).toBeNull();

  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
  }
  await shot(page, "02-insurance-mobile");

  await request.put("/api/v1/settings/online-search", {
    headers: await headers(request),
    data: { manual_enabled: false, reference_enabled: false, clear_api_key: true },
  });
  await request.delete(`/api/v1/ai/providers/${valuationProviderId}`, {
    headers: await headers(request),
  });
});
