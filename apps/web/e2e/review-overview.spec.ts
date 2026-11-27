import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";

const database = process.env.REVIEW_E2E_DATABASE_URL;
declare global {
  interface Window { reviewLeakedAmounts: boolean }
}
test.skip(!database, "Requires an explicitly isolated REVIEW_E2E_DATABASE_URL");

test.beforeAll(async ({ request }) => {
  const url = new URL(database!);
  expect(url.hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(url.pathname).toMatch(/^\/housetory_review_/);
  expect(new URL(process.env.E2E_BASE_URL!).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  const session = await (await request.get("/api/v1/auth/session")).json();
  const rooms = await (await request.get("/api/v1/rooms")).json();
  if (rooms.items.some((entry: { name: string }) => entry.name === "Review batch fixture")) return;
  const roomResponse = await request.post("/api/v1/rooms", { data: { name: "Review batch fixture" } });
  expect(roomResponse.ok()).toBeTruthy();
  const room = await roomResponse.json();
  const categoryResponse = await request.post("/api/v1/categories", { data: { name: `Batch tools ${Date.now()}` } });
  expect(categoryResponse.ok()).toBeTruthy();
  const category = await categoryResponse.json();
  const apiDir = path.resolve("../..", "services/api");
  execFileSync(path.join(apiDir, ".venv/bin/python"), ["-c", `
import uuid
from housetory_api.db import SessionLocal
from housetory_api.models import Item, Room
with SessionLocal() as db:
    room = db.get(Room, uuid.UUID("${room.id}"))
    assert str(room.household_id) == "${session.household.id}"
    db.add_all([Item(household_id=room.household_id, room_id=room.id,
        category_id=uuid.UUID("${category.id}") if index % 2 else None,
        name=f"Batch fixture {index // 2:03}", quantity=1) for index in range(206)])
    db.commit()
`], { cwd: apiDir, env: { ...process.env, DATABASE_URL: database }, stdio: "pipe" });
  for (const [index, days] of [365, 7, -1].entries()) {
    const end = new Date();
    end.setDate(end.getDate() + days);
    const response = await request.post("/api/v1/items", { data: {
      name: `Warranty fixture ${index}`, room_id: room.id,
      purchase: index < 2 ? {
        price_cents: index ? 67890 : 12345, currency: index ? "EUR" : "USD",
        purchase_date: "2026-01-01",
      } : null,
      warranty: { end_date: end.toISOString().slice(0, 10) },
    } });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
});

for (const mobile of [false, true]) {
  test(`${mobile ? "narrow mobile" : "desktop"} real local review cancels, reloads and resumes all batches without duplicate suggestions`, async ({ page, request }) => {
    await page.setViewportSize(mobile ? { width: 320, height: 640 } : { width: 1366, height: 768 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let intercepted = false;
    await page.route("**/inventory-review/runs/*/continue", async (route) => {
      const response = await route.fetch();
      if (!intercepted) {
        intercepted = true;
        await held;
      }
      await route.fulfill({ response });
    });
    await page.goto("/review");
    const total = (await (await request.get("/api/v1/overview")).json()).item_count as number;
    expect(total).toBeGreaterThan(200);
    await expect(page.getByRole("checkbox", { name: /Include AI suggestions/ })).toBeDisabled();
    await page.getByText("What gets sent?").click();
    await expect(page.getByText(/Descriptions may contain personal information/)).toBeVisible();
    await page.getByRole("button", { name: "Find suggestions" }).click();
    try {
      await expect.poll(() => intercepted).toBe(true);
      await page.getByRole("button", { name: "Cancel after current batch" }).click();
    } finally {
      release();
    }
    await expect(page.getByRole("button", { name: "Resume review", exact: true }).first()).toBeEnabled();
    const paused = (await (await request.get("/api/v1/inventory-review/summary")).json()).last_run;
    expect(paused.batch_state).toBe("cancelled");
    expect(paused.item_count_scanned).toBe(80);
    expect(paused.remaining_item_count).toBe(total - 80);
    await page.reload();
    await expect(page.getByText(`Reviewed 80 of ${total} items locally`, { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Resume review", exact: true }).first().click();
    await expect(page.getByRole("status")).toContainText(`Reviewed ${total} items locally`);
    const summary = await (await request.get("/api/v1/inventory-review/summary")).json();
    expect(summary.last_run.item_count_scanned).toBe(total);
    expect(summary.last_run.status).toBe("completed");
    expect(summary.last_run.ai_reviewed_count).toBe(0);
    await expect(page.getByText("AI not included. Local checks only.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Next suggestions" })).toBeEnabled();
    const firstItem = await page.locator("#review-suggestions li").first().innerText();
    await page.getByRole("button", { name: "Next suggestions" }).click();
    await expect(page.getByText(/51–100 of/)).toBeVisible();
    expect(await page.locator("#review-suggestions li").first().innerText()).not.toBe(firstItem);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const proposals: Array<{ fingerprint: string }> = [];
    for (let offset = 0; offset < summary.pending_count; offset += 100) {
      proposals.push(...(await (await request.get(`/api/v1/inventory-review/suggestions?status=pending&limit=100&offset=${offset}`)).json()).items);
    }
    expect(new Set(proposals.map((entry) => entry.fingerprint)).size).toBe(summary.pending_count);
    expect((await (await request.get("/api/v1/overview")).json()).item_count).toBe(total);
    await page.screenshot({ path: test.info().outputPath(`review-${mobile ? "mobile" : "desktop"}.png`) });
    // The old Overview pointed at the suggestions that wait for a decision. That count now
    // sits on the assistant button and in the item list's notice row.
    const household = (await (await request.get("/api/v1/auth/session")).json()).household.id as string;
    const waiting =
      ((await (await request.get("/api/v1/inventory-review/summary")).json()).pending_count as number) +
      ((await (await request.get("/api/v1/inventory-review/captures?dismissed=false")).json()) as unknown[]).length +
      ((await (await request.get(`/api/v1/assistant/actions/proposals/pending?household_id=${household}&limit=1`)).json()).total as number);
    expect(waiting).toBeGreaterThan(0);
    await page.goto("/items");
    await expect(page.getByTestId("bottom-bar").getByRole("button", {
      name: `Open assistant, ${waiting} unresolved reviews`, exact: true,
    })).toBeVisible();
    const notice = page.getByTestId("list-notices").getByRole("link", {
      name: `${waiting} ${waiting === 1 ? "finding" : "findings"} to review`, exact: true,
    });
    await expect(notice).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await notice.click();
    await expect(page).toHaveURL(/\/review$/);
  });

  test(`${mobile ? "narrow mobile" : "desktop"} purchase privacy persists through loading and warranty counts include expiring coverage`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 320, height: 640 } : { width: 1366, height: 768 });
    // The totals moved from the old Overview to the top of Purchases, one line until opened.
    await page.goto("/purchases");
    const totals = page.getByTestId("purchase-totals");
    await totals.getByRole("button", { name: /^Totals/ }).click();
    const hide = totals.getByRole("button", { name: "Hide purchase values", exact: true });
    await expect(hide).toBeVisible();
    await hide.click({ trial: true });
    const box = await hide.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    // The button sits beside the line that opens the totals, not over it.
    const line = await totals.getByRole("button", { name: /^Totals/ }).boundingBox();
    expect(box!.x >= line!.x + line!.width || box!.y >= line!.y + line!.height).toBe(true);
    await hide.click();
    await expect(page).toHaveURL(/\/purchases$/);
    await expect(totals.getByRole("button", { name: "Show purchase values" })).toBeVisible();
    // This hides the totals. The purchase rows below still show their own prices,
    // so only the totals are checked for amounts.
    await expect(totals).not.toContainText(/\$123\.[45]|€678\.9/);
    await page.addInitScript(() => {
      window.reviewLeakedAmounts = false;
      new MutationObserver(() => {
        const totalsText =
          document.querySelector<HTMLElement>('[data-testid="purchase-totals"]')?.innerText ?? "";
        if (/\$123\.[45]|€678\.9/.test(totalsText)) {
          window.reviewLeakedAmounts = true;
        }
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await page.reload();
    await expect(totals.getByRole("button", { name: "Show purchase values" })).toBeVisible();
    expect(await page.evaluate(() => window.reviewLeakedAmounts)).toBe(false);
    const warranty = totals.getByRole("link", { name: /Active warranties/ });
    await expect(warranty).toContainText("2");
    await expect(warranty).toContainText("1 expiring soon · 1 expired");
    await expect(warranty).toHaveAttribute("href", "/warranties");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`totals-hidden-${mobile ? "mobile" : "desktop"}.png`) });
    await totals.getByRole("button", { name: "Show purchase values" }).click();
    await expect(totals.getByRole("button", { name: /^Totals/ })).toContainText("$123.5");
    await warranty.click();
    await expect(page).toHaveURL(/\/warranties$/);
  });
}
