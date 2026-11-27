import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import path from "node:path";

const database = process.env.REVIEW_E2E_DATABASE_URL;
test.skip(!database, "Requires an explicitly isolated REVIEW_E2E_DATABASE_URL");

let server: Server;
let providerId: string;
let holdNext = false;
let release: (() => void) | undefined;
let invalidNext = false;
const calls: string[][] = [];

test.beforeAll(async ({ request }) => {
  const url = new URL(database!);
  expect(url.hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(url.pathname).toMatch(/^\/housetory_review_/);
  expect(new URL(process.env.E2E_BASE_URL!).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/tags") {
      res.end(JSON.stringify({ models: [{ name: "review-browser-test" }] }));
      return;
    }
    if (req.url !== "/api/chat") {
      res.writeHead(404).end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const prompt = body.messages.at(-1).content as string;
    const items = JSON.parse(prompt.split("Items: ")[1].split("\nReturn ")[0]) as Array<{
      index: number; name: string; current_tags?: string[];
    }>;
    calls.push(items.map((item) => item.name));
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((resolve) => { release = resolve; });
      release = undefined;
    }
    const invalid = invalidNext;
    invalidNext = false;
    const tags = [{ name: "camping" }, { name: "organised" }];
    res.end(JSON.stringify({ message: { role: "assistant", content: invalid
      ? JSON.stringify({ suggestions: "invalid synthetic output" })
      // Every item must get a usable answer: a proposal, or a reason for making none.
      // The same tags again for an item that has them is neither, and leaves it unreviewed.
      : JSON.stringify({ suggestions: items.map((item) => tags.every((tag) => (item.current_tags ?? []).includes(tag.name)) ? {
        index: item.index, category: null, no_category_reason: "Already organised with these tags.",
        tags: [], confidence: "high", reason: `Synthetic explanation variant ${calls.length}`,
      } : {
        index: item.index, tags: calls.length % 2 ? tags : [...tags].reverse(),
        confidence: "high", reason: `Synthetic explanation variant ${calls.length}`,
      }) }),
    } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test provider port");
  const provider = await request.post("/api/v1/ai/providers", { data: {
    provider: "ollama", display_name: "Synthetic browser review provider",
    base_url: `http://127.0.0.1:${address.port}`, default_model: "review-browser-test", enabled: true,
  } });
  expect(provider.ok(), await provider.text()).toBeTruthy();
  providerId = (await provider.json()).id;
  const task = await request.put("/api/v1/ai/tasks/assistant", { data: {
    provider_id: providerId, model: "review-browser-test", enabled: true,
  } });
  expect(task.ok(), await task.text()).toBeTruthy();
});

test.afterEach(() => {
  holdNext = false;
  invalidNext = false;
  release?.();
});

test.afterAll(async ({ request }) => {
  release?.();
  if (providerId) {
    const response = await request.delete(`/api/v1/ai/providers/${providerId}`);
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function seed(request: APIRequestContext) {
  const id = crypto.randomUUID().slice(0, 8);
  const roomResponse = await request.post("/api/v1/rooms", { data: { name: `Memory room ${id}` } });
  expect(roomResponse.ok()).toBeTruthy();
  const room = await roomResponse.json();
  const apiDir = path.resolve("../..", "services/api");
  execFileSync(path.join(apiDir, ".venv/bin/python"), ["-c", `
import uuid
from housetory_api.db import SessionLocal
from housetory_api.models import Item, Room
with SessionLocal() as db:
    room = db.get(Room, uuid.UUID("${room.id}"))
    assert room is not None
    db.add_all([Item(household_id=room.household_id, room_id=room.id,
        name=f"Memory ${id} object {index:03}", quantity=1) for index in range(81)])
    db.commit()
`], { cwd: apiDir, env: { ...process.env, DATABASE_URL: database }, stdio: "pipe" });
  return { room, id };
}

async function showAgainOptions(page: Page) {
  const options = page.locator("details").filter({ hasText: "Review again options" });
  if (!(await options.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await options.locator("summary").click();
  }
}

async function start(page: Page, again = false) {
  if (again) await showAgainOptions(page);
  await page.getByRole("button", { name: again ? "Review again" : "Review with AI", exact: true }).click();
  await page.getByRole("button", { name: "Run review with AI", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}

async function finished(page: Page) {
  await expect(page.getByRole("button", { name: "Review with AI", exact: true })).toBeEnabled();
}

async function summary(request: APIRequestContext) {
  return (await (await request.get("/api/v1/inventory-review/summary")).json()).last_run;
}

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"} delayed AI cancels first/later batches, remembers coverage and retains decisions`, async ({ page, request }) => {
    await page.setViewportSize(mobile ? { width: 360, height: 740 } : { width: 1366, height: 800 });
    const { room, id } = await seed(request);
    const before = calls.length;
    await page.goto(`/review?scope_type=room&scope_id=${room.id}`);
    await page.getByRole("checkbox", { name: /Include AI suggestions/ }).check();
    holdNext = true;
    await start(page);
    await expect.poll(() => Boolean(release)).toBe(true);
    const cancel = page.getByRole("button", { name: "Cancel after current batch", exact: true });
    await cancel.scrollIntoViewIfNeeded();
    const bounds = await cancel.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(mobile ? 360 : 1366);
    await cancel.click();
    release!();
    await finished(page);
    let run = await summary(request);
    expect([run.batch_state, run.item_count_scanned, run.ai_reviewed_count]).toEqual(["cancelled", 40, 40]);
    await page.reload();
    expect(calls.length).toBe(before + 1);
    holdNext = true;
    await page.getByRole("button", { name: "Resume review", exact: true }).first().click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.getByRole("button", { name: "Cancel after current batch", exact: true }).click();
    release!();
    await expect(page.getByRole("button", { name: "Find suggestions", exact: true })).toBeEnabled();
    run = await summary(request);
    expect([run.batch_state, run.item_count_scanned, run.ai_reviewed_count]).toEqual(["cancelled", 80, 80]);
    await page.reload();
    await page.getByRole("button", { name: "Resume review", exact: true }).first().click();
    await expect(page.getByRole("status")).toContainText("Reviewed 81 items locally");
    await expect(page.getByRole("button", { name: "Find suggestions", exact: true })).toBeEnabled();
    expect(calls.slice(before).map((batch) => batch.length)).toEqual([40, 40, 1]);
    expect(new Set(calls.slice(before).flat()).size).toBe(81);

    await page.getByRole("checkbox", { name: /Include AI suggestions/ }).check();
    await start(page);
    await finished(page);
    run = await summary(request);
    expect([run.ai_reused_count, run.ai_reviewed_count]).toEqual([81, 0]);
    expect(calls.length).toBe(before + 3);
    await expect(page.getByText(/81 unchanged, previously reviewed; 0 reviewed now/)).toBeVisible();
    const lookup = await request.get(`/api/v1/items?q=${encodeURIComponent(`Memory ${id} object 000`)}`);
    const item = (await lookup.json()).items[0];
    expect(item.tags).toEqual([]);
    await page.goto(`/review?scope_type=items&item_ids=${item.id}`);
    await page.getByRole("checkbox", { name: /Include AI suggestions/ }).check();
    const card = page.locator("#review-suggestions li").filter({ hasText: item.name }).first();
    await card.getByRole("button", { name: "Skip", exact: true }).click();
    await start(page, true);
    await finished(page);
    let queue = await (await request.get(`/api/v1/inventory-review/suggestions?status=pending&item_ids=${item.id}`)).json();
    expect(queue.total).toBe(0);
    const dismissed = await (await request.get(`/api/v1/inventory-review/suggestions?status=dismissed&item_ids=${item.id}`)).json();
    expect(dismissed.total).toBe(1);
    await showAgainOptions(page);
    const reconsider = page.getByRole("checkbox", { name: /Reconsider dismissed suggestions/ });
    await expect(reconsider).not.toBeChecked();
    await reconsider.check();
    await start(page, true);
    await finished(page);
    queue = await (await request.get(`/api/v1/inventory-review/suggestions?status=pending&item_ids=${item.id}`)).json();
    expect(queue.total).toBe(1);
    expect(queue.items[0].id).not.toBe(dismissed.items[0].id);
    const approved = page.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().endsWith("/accept"));
    await card.getByRole("button", { name: "Apply changes", exact: true }).click();
    expect((await approved).ok()).toBeTruthy();
    const saved = (await (await request.get(`/api/v1/items/${item.id}`)).json()).item;
    expect(saved.tags.map((tag: { name: string }) => tag.name).sort()).toEqual(["camping", "organised"]);

    await page.goto(`/review?scope_type=items&item_ids=${item.id}`);
    await page.getByRole("checkbox", { name: /Include AI suggestions/ }).check();
    invalidNext = true;
    await start(page, true);
    await finished(page);
    await expect(page.getByText(/AI organisation review failed/)).toBeVisible();
    expect((await summary(request)).ai_reviewed_count).toBe(0);
    await page.getByRole("button", { name: "Resume review", exact: true }).first().click();
    await finished(page);
    expect((await summary(request)).ai_reviewed_count).toBe(1);
    expect((await summary(request)).remaining_item_count).toBe(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`review-memory-${mobile ? "mobile" : "desktop"}.png`) });
  });

  test(`${mobile ? "mobile" : "desktop"} item menu opens scoped local review, preserves return and requires approval`, async ({ page, request }) => {
    await page.setViewportSize(mobile ? { width: 360, height: 740 } : { width: 1366, height: 800 });
    const room = await (await request.post("/api/v1/rooms", { data: { name: `Item review ${crypto.randomUUID()}` } })).json();
    const category = await (await request.post("/api/v1/categories", { data: { name: `Tools ${crypto.randomUUID()}` } })).json();
    const name = `Item review drill ${crypto.randomUUID()}`;
    await request.post("/api/v1/items", { data: { name, room_id: room.id, category_id: category.id } });
    const target = (await (await request.post("/api/v1/items", { data: { name, room_id: room.id } })).json()).item;
    const before = calls.length;
    await page.goto(`/items/${target.id}?tab=history`);
    await page.getByRole("button", { name: "Item options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Review this item", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`scope_type=items&item_ids=${target.id}`));
    await expect(page.getByRole("checkbox", { name: /Include AI suggestions/ })).not.toBeChecked();
    await page.getByRole("button", { name: "Find suggestions", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Reviewed 1 items locally");
    await expect(page.getByRole("button", { name: "Find suggestions", exact: true })).toBeEnabled();
    expect(calls.length).toBe(before);
    expect((await (await request.get(`/api/v1/items/${target.id}`)).json()).item.category).toBeNull();
    const card = page.locator("#review-suggestions li").filter({ hasText: `Assign category “${category.name}”` }).first();
    await card.getByRole("button", { name: "Apply change", exact: true }).click();
    await expect.poll(async () => (await (await request.get(`/api/v1/items/${target.id}`)).json()).item.category?.id).toBe(category.id);
    await page.getByRole("link", { name: "Back to item", exact: true }).click();
    await expect(page).toHaveURL(`/items/${target.id}?tab=history`);
  });
}
