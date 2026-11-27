import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Opt in only against a disposable local API; all HTTP responses and counts are real.
const database = process.env.CAPTURE_E2E_DATABASE_URL;
const dataDir = process.env.CAPTURE_E2E_DATA_DIR;
const apiDir = path.resolve("../..", "services/api");
const python = path.join(apiDir, ".venv/bin/python");
const workerEnv = {
  ...process.env, DATABASE_URL: database, DATA_DIR: dataDir,
  ENVIRONMENT: "test", AI_PROVIDER: "disabled", AI_CLOUD_ENABLED: "false", AI_CLOUD_CONSENT: "false",
};
type Review = { id: string; kind: "import" | "document" | "photo"; title: string; status: string; generation: string; notify: boolean };
declare global {
  interface Window {
    captureNotificationEvents: Array<{ id: string; generation: string }>;
  }
}

test.skip(!database || !dataDir, "Requires CAPTURE_E2E_DATABASE_URL and CAPTURE_E2E_DATA_DIR for isolated real-API validation");
test.beforeAll(async ({ request }) => {
  const url = new URL(database!);
  expect(["localhost", "127.0.0.1"]).toContain(url.hostname);
  expect(url.pathname).toMatch(/^\/housetory_dismissal_/);
  expect(new URL(process.env.E2E_BASE_URL!).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  const suffix = `${Date.now()}-${process.pid}`;
  const room = await request.post("/api/v1/rooms", { data: { name: `Dismissal preserved room ${suffix}` } });
  expect(room.status()).toBe(201);
  const item = await request.post("/api/v1/items", {
    data: { name: `Preserved drill ${suffix}`, quantity: 3, room_id: (await room.json()).id },
  });
  expect(item.status()).toBe(201);
});

async function reviews(request: APIRequestContext, dismissed = false): Promise<Review[]> {
  const response = await request.get(`/api/v1/inventory-review/captures?dismissed=${dismissed}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function expectBadge(page: Page, request: APIRequestContext) {
  const reopen = page.viewportSize()!.width < 1024 && new URL(page.url()).hash === "#assistant";
  if (reopen) await page.getByRole("button", { name: "Close assistant", exact: true }).click();
  // A press just before this may not have reached the server yet. The server's count
  // and the button are read again until they agree; they must agree exactly.
  await expect(async () => {
    const pending = await reviews(request);
    const summary = await (await request.get("/api/v1/inventory-review/summary")).json();
    const count = pending.length + summary.pending_count;
    await expect(page.getByRole("button", { name: count ? `Open assistant, ${count} unresolved reviews` : "Open assistant", exact: true }))
      .toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  if (reopen) await page.getByRole("button", { name: /^Open assistant/ }).click();
}

async function createImport(request: APIRequestContext, title: string, failed = false) {
  const response = await request.post("/api/v1/imports", { multipart: failed
    ? { title, file: { name: "large-field.csv", mimeType: "text/csv", buffer: Buffer.from(`Name,Quantity\n${"a".repeat(150_000)},1`) } }
    : { title, assistant_capture: "true", text: `Add one ${title}` },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).id as string;
}

function processCapture(kind: Review["kind"], id: string) {
  const code = kind === "import"
    ? "from housetory_api.services.import_pipeline import process_import_batch as run"
    : kind === "document"
      ? "from housetory_api.services.document_ocr import run_document_ocr as run"
      : "from housetory_api.services.recognition import run_recognition as run";
  execFileSync(python, ["-c", `${code}\nimport sys\nrun(sys.argv[1])`, id], {
    cwd: apiDir, env: workerEnv, timeout: 30_000, stdio: "pipe",
  });
}

/** Longer than the half minute between two idle reads of the list of waiting captures. */
const IDLE_READ_MS = 40_000;

/** The captures that wait for review, and the dismissed ones, are listed on the Review page. */
const waitingCaptures = (page: Page) => page.getByRole("region", { name: "Pending captures" });

/** Review is one of the More choices in the list of rooms. */
async function openReviewFromRooms(page: Page) {
  const rooms = page.getByRole("navigation", { name: "Rooms" });
  await rooms.getByRole("button", { name: "More", exact: true }).click();
  await rooms.getByTestId("rail-more").getByRole("link", { name: "Review", exact: true }).click();
  await expect(page).toHaveURL(/\/review$/);
}

/** Back to the item list. The More choices are closed first: they cover the rooms. */
async function openItemsFromRooms(page: Page) {
  const rooms = page.getByRole("navigation", { name: "Rooms" });
  await rooms.getByRole("button", { name: "Close", exact: true }).click();
  await rooms.getByRole("link", { name: "All items", exact: true }).click();
  await expect(page).toHaveURL(/\/items$/);
}

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"} real review dismissal, Undo, retained edits and reload update the badge`, async ({ page, request }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 640 } : { width: 1440, height: 900 });
    const title = `Dismiss cable ${mobile ? "mobile" : "desktop"}`;
    const id = await createImport(request, title);
    processCapture("import", id);
    const source = await (await request.get(`/api/v1/imports/${id}/source`)).body();
    const inventory = await (await request.get("/api/v1/items")).json();
    expect(inventory.items.length).toBeGreaterThan(0);
    // The waiting capture is listed on the Review page. "Review" opens it in the assistant.
    await page.goto("/review");
    await expectBadge(page, request);
    const queue = waitingCaptures(page);
    const panel = page.getByRole("dialog", { name: "Assistant" });
    const openReview = queue.getByRole("button", { name: `Review ${title}`, exact: true });
    const dismiss = queue.getByRole("button", { name: `Dismiss review ${title}`, exact: true });
    await openReview.click();
    const review = panel.getByRole("region", { name: "Assistant item review" });
    // The name is corrected in the row itself.
    const name = review.getByRole("textbox", { name: /^Name of / });
    await expect(name).toHaveCount(1);
    await name.fill(`Edited ${title}`);
    await panel.getByRole("button", { name: "Close assistant", exact: true }).click();
    await dismiss.click();
    await expect(openReview).toHaveCount(0);
    await expect(review).not.toBeVisible();
    expect((await reviews(request)).some((entry) => entry.id === id)).toBe(false);
    await expectBadge(page, request);
    if (mobile) {
      await queue.locator("summary").filter({ hasText: "Dismissed reviews" }).click();
      await queue.getByRole("button", { name: `Undo dismissal ${title}`, exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Undo", exact: true }).click();
    }
    await openReview.click();
    await expect(name).toHaveValue(`Edited ${title}`);
    await panel.getByRole("button", { name: "Close assistant", exact: true }).click();
    await dismiss.click();
    await expect(openReview).toHaveCount(0);
    await page.reload();
    await expectBadge(page, request);
    // The dismissed capture is not offered in the assistant after a reload.
    await page.getByRole("button", { name: /^Open assistant/ }).click();
    await expect(panel.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
    await expect(panel.getByText(title)).toHaveCount(0);
    await panel.getByRole("button", { name: "Close assistant", exact: true }).click();
    // It is among the dismissed ones, and not among the waiting ones.
    await queue.locator("summary").filter({ hasText: "Dismissed reviews" }).click();
    await expect(openReview).toHaveCount(0);
    await queue.getByRole("button", { name: `Undo dismissal ${title}`, exact: true }).click();
    await expectBadge(page, request);
    await expect(openReview).toBeVisible();
    expect(await (await request.get(`/api/v1/imports/${id}/source`)).body()).toEqual(source);
    expect(await (await request.get("/api/v1/items")).json()).toEqual(inventory);
    await dismiss.click();
  });
}

test("real Review page dismisses failed imports/photos and cancelled documents; Undo and retry persist", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  const failedId = await createImport(request, "Dismiss failed CSV", true);
  processCapture("import", failedId);
  const image = execFileSync(python, ["-c", "import io,sys; from PIL import Image; b=io.BytesIO(); Image.new('RGB',(100,100),'white').save(b,format='PNG'); sys.stdout.buffer.write(b.getvalue())"]);
  const photo = await request.post("/api/v1/ai/recognitions", { multipart: {
    assistant_capture: "true", file: { name: "Dismiss failed photo.png", mimeType: "image/png", buffer: image },
  } });
  expect(photo.status()).toBe(201);
  const photoId = (await photo.json()).id;
  processCapture("photo", photoId);
  const document = await request.post("/api/v1/documents", { multipart: {
    title: "Dismiss cancelled invoice", document_type: "invoice", assistant_capture: "true",
    file: { name: "invoice.txt", mimeType: "text/plain", buffer: Buffer.from("Invoice\nCable 1 x 20.00 USD\nTotal 20.00 USD") },
  } });
  expect(document.status()).toBe(201);
  const documentId = (await document.json()).id;
  expect((await request.post(`/api/v1/documents/${documentId}/processing/cancel`)).ok()).toBeTruthy();
  const pending = await reviews(request);
  expect(pending.find((entry) => entry.id === failedId)?.status).toBe("failed");
  expect(pending.find((entry) => entry.id === photoId)?.status).toBe("failed");
  expect(pending.find((entry) => entry.id === documentId)?.status).toBe("cancelled");
  const oldGeneration = pending.find((entry) => entry.id === documentId)!.generation;
  const source = await (await request.get(`/api/v1/documents/${documentId}/original`)).body();
  const inventory = await (await request.get("/api/v1/items")).json();
  await page.goto("/review");
  const queue = page.getByRole("region", { name: "Pending captures" });
  for (const title of ["Dismiss failed CSV", "Dismiss failed photo.png", "Dismiss cancelled invoice"]) {
    await queue.getByRole("button", { name: `Dismiss review ${title}`, exact: true }).click();
    await expect(queue.getByRole("button", { name: `Review ${title}`, exact: true })).toHaveCount(0);
    await expectBadge(page, request);
  }
  await page.reload();
  await expectBadge(page, request);
  await queue.locator("summary").filter({ hasText: "Dismissed reviews" }).click();
  await queue.getByRole("button", { name: "Undo dismissal Dismiss cancelled invoice", exact: true }).click();
  await expectBadge(page, request);
  // Even a new notification session must respect server-persisted suppression.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(queue.getByRole("button", { name: "Review Dismiss cancelled invoice", exact: true })).toBeVisible();
  await expect(page.getByText("Dismiss cancelled invoice needs attention", { exact: true })).toHaveCount(0);
  await queue.getByRole("button", { name: "Dismiss review Dismiss cancelled invoice", exact: true }).click();
  await queue.locator("summary").filter({ hasText: "Dismissed reviews" }).click();
  await queue.getByRole("button", { name: "Retry Dismiss cancelled invoice", exact: true }).click();
  await expect(queue.getByRole("button", { name: "Review Dismiss cancelled invoice", exact: true })).toBeVisible();
  const next = (await reviews(request)).find((entry) => entry.id === documentId)!;
  expect(next.generation).not.toBe(oldGeneration);
  expect(next.notify).toBe(true);
  processCapture("document", documentId);
  const ready = (await reviews(request)).find((entry) => entry.id === documentId)!;
  expect(["ready", "needs_attention"]).toContain(ready.status);
  const notification = ready.status === "ready" ? "Dismiss cancelled invoice ready for review" : "Dismiss cancelled invoice needs attention";
  await expect(page.getByText(notification, { exact: true })).toHaveCount(1);
  await expectBadge(page, request);
  await queue.getByRole("button", { name: "Dismiss review Dismiss cancelled invoice", exact: true }).click();
  await expect(page.getByText(notification, { exact: true })).toHaveCount(0);
  await page.reload();
  await expectBadge(page, request);
  expect(await (await request.get(`/api/v1/documents/${documentId}/original`)).body()).toEqual(source);
  expect(await (await request.get("/api/v1/items")).json()).toEqual(inventory);
  expect((await request.get(`/api/v1/imports/${failedId}/source`)).ok()).toBeTruthy();
  expect((await request.get(`/api/v1/ai/recognitions/${photoId}/original`)).ok()).toBeTruthy();
});

test("real worker finishing after UI dismissal cannot resurrect a processing review", async ({ page, request }) => {
  const id = await createImport(request, "Dismiss processing cable");
  const inventory = await (await request.get("/api/v1/items")).json();
  const gates = fs.mkdtempSync(path.join(os.tmpdir(), "housetory-dismissal-gates-"));
  const started = path.join(gates, "started");
  const release = path.join(gates, "release");
  const code = `
import sys,time
from pathlib import Path
from housetory_api.services import import_pipeline
read = import_pipeline.read_source_bundle
def gated(*args):
    Path(sys.argv[2]).touch()
    deadline = time.monotonic() + 30
    while not Path(sys.argv[3]).exists():
        if time.monotonic() > deadline: raise TimeoutError("Test gate timed out")
        time.sleep(0.05)
    return read(*args)
import_pipeline.read_source_bundle = gated
import_pipeline.process_import_batch(sys.argv[1])
`;
  const worker = spawn(python, ["-c", code, id, started, release], { cwd: apiDir, env: workerEnv, stdio: "pipe" });
  let error = "";
  worker.stderr.on("data", (value) => { error += value.toString(); });
  const finished = new Promise<number | null>((resolve, reject) => {
    worker.on("error", reject);
    worker.on("exit", resolve);
  });
  try {
    await expect.poll(() => fs.existsSync(started)).toBe(true);
    expect((await reviews(request)).find((entry) => entry.id === id)?.status).toBe("processing");
    await page.goto("/review");
    const queue = waitingCaptures(page);
    const panel = page.getByRole("dialog", { name: "Assistant" });
    await queue.getByRole("button", { name: "Dismiss review Dismiss processing cable", exact: true }).click();
    fs.writeFileSync(release, "");
    expect(await finished, error).toBe(0);
    const batch = await (await request.get(`/api/v1/imports/${id}`)).json();
    expect(batch.status).toBe("review");
    expect(batch.entries.length).toBeGreaterThan(0);
    expect(batch.metadata.review_dismissed).toBeTruthy();
    expect((await reviews(request)).some((entry) => entry.id === id)).toBe(false);
    await page.reload();
    await expectBadge(page, request);
    // The list is loaded: it shows the dismissed captures, and this one is not waiting.
    await expect(queue.locator("summary").filter({ hasText: "Dismissed reviews" })).toBeVisible();
    await expect(queue.getByRole("button", { name: "Review Dismiss processing cable", exact: true })).toHaveCount(0);
    // The assistant does not offer it either.
    await page.getByRole("button", { name: /^Open assistant/ }).click();
    await expect(panel.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
    await expect(panel.getByText("Dismiss processing cable")).toHaveCount(0);
    await expect(page.getByText("Dismiss processing cable ready for review", { exact: true })).toHaveCount(0);
    expect(await (await request.get("/api/v1/items")).json()).toEqual(inventory);
  } finally {
    fs.writeFileSync(release, "");
    await finished;
    fs.rmSync(gates, { recursive: true });
  }
});

  test("existing reviews restore silently on load/reload/reopening; active completion, Undo and retry never replay", async ({ page, context, request }) => {
    // Two of the steps below wait for an idle read of the list.
    test.setTimeout(180_000);
    await context.addInitScript(() => {
      window.captureNotificationEvents = [];
      window.addEventListener("housetory:assistant-task-completed", (event) => {
        if (event instanceof CustomEvent && typeof event.detail?.id === "string") {
          window.captureNotificationEvents.push({ id: event.detail.id, generation: event.detail.generation });
        }
      });
    });
    const existingTitle = "Replay existing cable";
    const existing = await createImport(request, existingTitle);
    processCapture("import", existing);
    await page.goto("/review");
    await expect(page.getByRole("button", { name: `Review ${existingTitle}`, exact: true })).toBeVisible();
    await expectBadge(page, request);
    await expect(page.getByText(`${existingTitle} ready for review`, { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.captureNotificationEvents)).toEqual([]);
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await expect(page.getByRole("button", { name: `Review ${existingTitle}`, exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.captureNotificationEvents)).toEqual([]);
    await page.close();
    const app = await context.newPage();
    await app.goto("/");
    await expectBadge(app, request);
    await openReviewFromRooms(app);
    await expect(app.getByRole("button", { name: `Review ${existingTitle}`, exact: true })).toBeVisible();
    expect(await app.evaluate(() => window.captureNotificationEvents)).toEqual([]);
    const liveTitle = "Replay live failed CSV";
    const live = await createImport(request, liveTitle, true);
    const queue = app.getByRole("region", { name: "Pending captures" });
    // It was created outside this page. While nothing is being processed, the page reads
    // the list of waiting captures again every half minute.
    await expect(queue.getByRole("button", { name: `Review ${liveTitle}`, exact: true }))
      .toBeVisible({ timeout: IDLE_READ_MS });
    const oldAttempt = (await reviews(request)).find((entry) => entry.id === live)!.generation;
    processCapture("import", live);
    const notice = `${liveTitle} needs attention`;
    await expect(app.getByText(notice, { exact: true })).toHaveCount(1);
    await expect.poll(() => app.evaluate((id) => window.captureNotificationEvents.filter((entry) => entry.id === id).length, live)).toBe(1);
    await openItemsFromRooms(app);
    await openReviewFromRooms(app);
    await expectBadge(app, request);
    expect(await app.evaluate((id) => window.captureNotificationEvents.filter((entry) => entry.id === id).length, live)).toBe(1);
    await queue.getByRole("button", { name: `Dismiss review ${liveTitle}`, exact: true }).click();
    await expect(app.getByText(notice, { exact: true })).toHaveCount(0);
    await queue.locator("summary").filter({ hasText: "Dismissed reviews" }).click();
    await queue.getByRole("button", { name: `Undo dismissal ${liveTitle}`, exact: true }).click();
    await expect(queue.getByRole("button", { name: `Review ${liveTitle}`, exact: true })).toBeVisible();
    expect((await reviews(request)).find((entry) => entry.id === live)!.notify).toBe(false);
    expect(await app.evaluate((id) => window.captureNotificationEvents.filter((entry) => entry.id === id).length, live)).toBe(1);
    await app.evaluate(() => sessionStorage.clear());
    await app.reload();
    await expect(queue.getByRole("button", { name: `Review ${liveTitle}`, exact: true })).toBeVisible();
    await expectBadge(app, request);
    expect(await app.evaluate(() => window.captureNotificationEvents)).toEqual([]);
    await expect(app.getByText(notice, { exact: true })).toHaveCount(0);
    await queue.getByRole("button", { name: `Dismiss review ${liveTitle}`, exact: true }).click();
    await queue.locator("summary").filter({ hasText: "Dismissed reviews" }).click();
    await queue.getByRole("button", { name: `Retry ${liveTitle}`, exact: true }).click();
    await expect(queue.getByRole("button", { name: `Review ${liveTitle}`, exact: true })).toBeVisible();
    const newAttempt = (await reviews(request)).find((entry) => entry.id === live)!.generation;
    expect(newAttempt).not.toBe(oldAttempt);
    processCapture("import", live);
    await expect(app.getByText(notice, { exact: true })).toHaveCount(1);
    expect(await app.evaluate((id) => window.captureNotificationEvents.filter((entry) => entry.id === id), live)).toEqual([{ id: live, generation: newAttempt }]);
    // Work completed while the app was closed is restored, never replayed as a toast.
    const parkedTitle = "Replay parked cable";
    const parked = await createImport(request, parkedTitle);
    await expect(queue.getByRole("button", { name: `Review ${parkedTitle}`, exact: true }))
      .toBeVisible({ timeout: IDLE_READ_MS });
    await app.close();
    processCapture("import", parked);
    const reopened = await context.newPage();
    await reopened.goto("/review");
    await expect(reopened.getByRole("button", { name: `Review ${parkedTitle}`, exact: true })).toBeVisible();
    await expectBadge(reopened, request);
    expect(await reopened.evaluate(() => window.captureNotificationEvents)).toEqual([]);
    await expect(reopened.getByText(`${parkedTitle} ready for review`, { exact: true })).toHaveCount(0);
    await reopened.close();
  });
