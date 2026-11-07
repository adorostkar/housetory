import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createItem(request: APIRequestContext, name: string, extra = {}) {
  const response = await request.post("/api/v1/items", {
    data: { name, ...extra },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

async function waitForPackage(request: APIRequestContext, packageId: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await request.get(`/api/v1/evidence-exports/${packageId}`);
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as { status: string };
    if (body.status === "succeeded") return;
    if (body.status === "failed" || body.status === "cancelled") {
      throw new Error(`Evidence package ended as ${body.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Evidence package did not finish in time");
}

function setLegacyValue(itemId: string, totalCents: number) {
  const sql = `
    UPDATE items
    SET current_value_cents = ${totalCents},
        current_value_basis = 'legacy_record_total',
        current_value_estimated_at = NULL
    WHERE id = '${itemId}';
  `;
  execFileSync(
    "docker",
    [
      "exec",
      process.env.E2E_DB_CONTAINER ?? "housetory-e2e-db-1",
      "psql",
      "-U",
      "housetory",
      "-d",
      "housetory",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { stdio: "pipe" },
  );
}

test("item and evidence report show $40 per unit, owned quantity 2 and $80 total", async ({
  page,
  request,
}) => {
  const id = suffix();
  const itemName = `Unit value camera ${id}`;
  const item = await createItem(request, itemName, {
    quantity: 2,
    purchase: {
      merchant: "Browser Camera Shop",
      purchase_date: "2026-02-01",
      price_cents: 10000,
      currency: "USD",
    },
    current_value_cents: 4000,
    current_value_currency: "USD",
  });
  const loan = await request.post("/api/v1/loans", {
    data: {
      item_id: item.item.id,
      borrower_name: "Private Borrower",
      quantity: 1,
      lent_on: "2026-02-10",
      request_id: randomUUID(),
    },
  });
  expect(loan.ok()).toBeTruthy();

  await fs.mkdir("../../docs/walkthrough/current-value", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/items/${item.item.id}`);
  await expect(page.getByRole("heading", { name: itemName, level: 1 })).toBeVisible();
  await expect(page.getByText(/40.*per unit/)).toBeVisible();
  await expect(page.getByText(/2 owned units/)).toBeVisible();
  await expect(page.getByText(/80.*total/)).toBeVisible();
  await expect(page.getByText(/includes 1 on loan/)).toBeVisible();
  await expect(page.getByText("Purchase total", { exact: true })).toBeVisible();
  await expect(page.getByText("Original transaction total, not a per-unit price.")).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/current-value/01-item-unit-value-desktop.png",
    fullPage: false,
  });

  const previewResponse = await request.post("/api/v1/evidence-exports/preview", {
    data: { scope: { item_ids: [item.item.id] }, options: {} },
  });
  expect(previewResponse.ok()).toBeTruthy();
  const preview = (await previewResponse.json()) as {
    fingerprint: string;
    scope: Record<string, unknown>;
    options: Record<string, unknown>;
    currency_totals: Array<{ currency: string; current_value_total_cents: number }>;
  };
  expect(preview.currency_totals[0]?.currency).toBe("USD");
  expect(preview.currency_totals[0]?.current_value_total_cents).toBe(8000);

  const createResponse = await request.post("/api/v1/evidence-exports", {
    data: {
      scope: { item_ids: [item.item.id] },
      options: preview.options,
      fingerprint: preview.fingerprint,
      request_id: randomUUID(),
    },
  });
  expect(createResponse.status()).toBe(202);
  const packageId = ((await createResponse.json()) as { id: string }).id;
  await waitForPackage(request, packageId);

  const pdfResponse = await request.get(`/api/v1/evidence-exports/${packageId}/pdf`);
  expect(pdfResponse.ok()).toBeTruthy();
  const pdfBytes = await pdfResponse.body();
  expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");
  await fs.writeFile(
    "../../docs/walkthrough/current-value/unit-value-evidence.pdf",
    pdfBytes,
  );

  await page.goto("/items");
  await page.getByRole("checkbox", { name: `Select ${itemName}` }).check();
  await page.getByRole("button", { name: "Export evidence" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Export 1 selected item with evidence",
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("columnheader", { name: "Current estimate totals" }),
  ).toBeVisible();
  await expect(dialog.getByText(/\$80/)).toBeVisible();
  await dialog.screenshot({
    path: "../../docs/walkthrough/current-value/02-evidence-preview-desktop.png",
  });
});

test("legacy record total is reviewed and explicitly converted in the item form", async ({
  page,
  request,
}) => {
  const id = suffix();
  const itemName = `Legacy value camera ${id}`;
  const item = await createItem(request, itemName, {
    quantity: 2,
    current_value_cents: 4000,
    current_value_currency: "USD",
  });
  setLegacyValue(item.item.id, 8000);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/items/${item.item.id}`);
  await expect(page.getByText(/Legacy record total/)).toBeVisible();
  await expect(page.getByText(/not multiplied by quantity/)).toBeVisible();
  await expect(page.getByText(/\$80/)).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/current-value/03-legacy-record-total.png",
    fullPage: false,
  });

  await page.getByRole("link", { name: "Edit" }).first().click();
  await expect(page.getByText("Legacy recorded total", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Convert to per-unit" }).click();
  const preview = page.getByTestId("current-value-preview");
  await expect(preview).toContainText("2 owned units");
  await expect(preview).toContainText("$40");
  await expect(preview).toContainText("$80");
  const currentValueSection = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Current value" }) });
  await currentValueSection.scrollIntoViewIfNeeded();
  await currentValueSection.screenshot({
    path: "../../docs/walkthrough/current-value/04-legacy-conversion-review.png",
  });

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("heading", { name: itemName, level: 1 })).toBeVisible();
  await expect(page.getByText(/40.*per unit/)).toBeVisible();
  await expect(page.getByText(/80.*total/)).toBeVisible();
  await expect(page.getByText(/Legacy record total/)).toHaveCount(0);

  await expect
    .poll(async () => {
      const detail = await request.get(`/api/v1/items/${item.item.id}`);
      expect(detail.ok()).toBeTruthy();
      const body = (await detail.json()) as {
        item: { current_value_basis: string };
      };
      return body.item.current_value_basis;
    })
    .toBe("per_unit");
  const detail = await request.get(`/api/v1/items/${item.item.id}`);
  const body = (await detail.json()) as {
    item: {
      current_value_basis: string;
      current_value_cents: number;
      current_value_total_cents: number;
    };
  };
  expect(body.item.current_value_cents).toBe(4000);
  expect(body.item.current_value_total_cents).toBe(8000);
});
