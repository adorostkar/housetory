import http from "node:http";

import { expect, test, type APIRequestContext } from "@playwright/test";

const BRAVE_FIXTURE_PORT = 4789;
const BRAVE_FIXTURE_KEY = "e2e-fixture-key";
let braveServer: http.Server | undefined;
const braveRequests: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];

test.beforeAll(async () => {
  braveServer = http.createServer((request, response) => {
    if (request.url?.startsWith("/res/v1/web/search")) {
      braveRequests.push({
        url: request.url,
        headers: request.headers,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "search",
          query: { original: "manual", more_results_available: false },
          web: {
            type: "search",
            results: [
              {
                title: "DeWalt DCD791B 20V MAX Drill Instruction Manual",
                url: "https://www.dewalt.com/-/media/manuals/DCD791B.pdf",
                description:
                  "Official DCD791B instruction manual covering safety, battery and chuck operation.",
                extra_snippets: [
                  "Disconnect the battery before changing the drill bit or servicing the tool.",
                ],
                profile: { name: "DeWalt", long_name: "DeWalt" },
                language: "en",
              },
              {
                title: "DeWalt DCD790 Drill Manual",
                url: "https://manualslib.example/DCD790",
                description: "A similar drill manual.",
                profile: { name: "ManualsLib", long_name: "ManualsLib" },
              },
            ],
          },
        }),
      );
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise<void>((resolve, reject) => {
    braveServer?.once("error", reject);
    braveServer?.listen(BRAVE_FIXTURE_PORT, "0.0.0.0", resolve);
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => {
    braveServer?.close(() => resolve());
  });
});

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createItem(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/items", {
    data: { name, brand: "DeWalt", model: "DCD791" },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string; name: string } };
}

test("uploads a manual without make/model, answers from its text, and attaches it to another item", async ({
  page,
  request,
}) => {
  const id = suffix();
  const title = `Drill manual ${id}`;
  const first = await createItem(request, `Drill one ${id}`);
  const second = await createItem(request, `Drill two ${id}`);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/items/${first.item.id}`);
  await page.getByRole("button", { name: "Add manual" }).first().click();
  const uploadDialog = page.getByRole("dialog", { name: "Add a manual" });
  await expect(uploadDialog).toBeVisible();
  await expect(uploadDialog.getByLabel("Type")).toHaveCount(0);
  await uploadDialog.locator("#document-file").setInputFiles({
    name: "drill-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "Safety\nDisconnect the battery before changing the drill bit.\n\n" +
        "Maintenance\nApply light machine oil to the chuck monthly.",
    ),
  });
  await uploadDialog.getByLabel("Title").fill(title);
  await uploadDialog.getByRole("button", { name: "Add manual" }).click();
  await expect(uploadDialog).toBeHidden();
  await expect(page.getByText(title).first()).toBeVisible();

  await expect
    .poll(
      async () => {
        const listing = await request.get(`/api/v1/items/${first.item.id}/manuals`);
        const data = (await listing.json()) as {
          manuals: Array<{ title: string; id: string; ocr_status: string }>;
        };
        return data.manuals.find((manual) => manual.title === title)?.ocr_status;
      },
      { timeout: 60_000 },
    )
    .toBe("succeeded");

  await page.reload();
  await expect(page.getByText(title).first()).toBeVisible();
  await page.getByRole("button", { name: "Ask about this item" }).click();
  const askDialog = page.getByRole("dialog", { name: `Ask about ${first.item.name}` });
  await askDialog.getByLabel("Question").fill("How do I change the drill bit?");
  await askDialog.getByRole("button", { name: "Ask attached manuals" }).click();
  await expect(askDialog.getByText("Extracted from manual text")).toBeVisible();
  await expect(askDialog.getByText("Page 1").first()).toBeVisible();
  await expect(
    askDialog.getByText(/Disconnect the battery before changing the drill bit/).first(),
  ).toBeVisible();
  await expect(askDialog.getByText(/Borrower, loan and household data/)).toHaveCount(0);

  await page.goto(`/items/${second.item.id}`);
  await page.getByRole("button", { name: "Link existing" }).click();
  const attachDialog = page.getByRole("dialog", { name: "Link an existing document" });
  const row = attachDialog.locator("li").filter({ hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Link" }).click();
  await expect(attachDialog).toBeHidden();
  await expect(page.getByText(title).first()).toBeVisible();
});

test("discovers through the concrete Brave adapter, reviews the real source and cites the saved manual", async ({
  page,
  request,
}) => {
  const id = suffix();
  const item = await createItem(request, `Brave drill ${id}`);
  await page.setViewportSize({ width: 390, height: 844 });

  const initial = await request.get(`/api/v1/items/${item.item.id}/manuals`);
  const status = (await initial.json()) as {
    search: { provider: string | null; provider_label: string | null };
  };
  test.skip(
    status.search.provider !== "brave",
    "Brave fixture not configured; start the disposable stack with BRAVE_SEARCH_PROVIDER=brave and fixture key/base URL.",
  );

  const profile = await request.put(`/api/v1/items/${item.item.id}/manual-profile`, {
    data: {
      manufacturer: "DeWalt",
      model_identifier: "DCD791",
      variant: "B",
      confirmed: true,
    },
  });
  expect(profile.ok()).toBeTruthy();

  const savedTitle = `Saved manual ${id}`;
  const upload = await request.post("/api/v1/documents", {
    multipart: {
      file: {
        name: "saved-manual.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(
          "Safety\nDisconnect the battery before changing the drill bit.\n\n" +
            "Maintenance\nApply light machine oil to the chuck monthly.",
        ),
      },
      title: savedTitle,
      document_type: "manual",
    },
  });
  expect(upload.ok()).toBeTruthy();
  const savedDocument = (await upload.json()) as {
    id: string;
    title: string;
    ocr_status: string;
  };
  await expect
    .poll(
      async () => {
        const current = await request.get(`/api/v1/documents/${savedDocument.id}`);
        return ((await current.json()) as { ocr_status: string }).ocr_status;
      },
      { timeout: 60_000 },
    )
    .toBe("succeeded");

  await page.route(
    `**/api/v1/items/${item.item.id}/manual-search/*/download`,
    async (route) => {
      const attach = await request.post(
        `/api/v1/items/${item.item.id}/manuals/${savedDocument.id}`,
      );
      expect(attach.ok()).toBeTruthy();
      const document = await (
        await request.get(`/api/v1/documents/${savedDocument.id}`)
      ).json();
      const candidateList = await (
        await request.get(`/api/v1/items/${item.item.id}/manual-search`)
      ).json();
      const candidate = candidateList.candidates.find(
        (entry: { file_url: string }) => entry.file_url.endsWith("DCD791B.pdf"),
      );
      await route.fulfill({
        json: {
          document,
          candidate: { ...candidate, document_id: savedDocument.id, direct_file: true },
          duplicate_documents: [],
        },
      });
    },
  );

  await page.goto(`/items/${item.item.id}`);
  await page.getByRole("button", { name: "Find manual" }).click();
  const dialog = page.getByRole("dialog", { name: `Find a manual for ${item.item.name}` });
  await expect(dialog.getByText("Brave Search API")).toBeVisible();
  await dialog.getByRole("button", { name: "Search for exact model" }).click();
  await expect(
    dialog.getByText("DeWalt DCD791B 20V MAX Drill Instruction Manual"),
  ).toBeVisible();
  await expect(dialog.getByText("Manufacturer", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Review & download" }).click();
  await expect(dialog.getByText(/I reviewed this candidate and verified/)).toBeVisible();
  const confirmDownload = dialog.getByRole("button", { name: /Download & attach/ });
  await expect(confirmDownload).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await confirmDownload.click();
  await expect(page.getByText("Manual saved and attached")).toBeVisible();

  expect(braveRequests.length).toBeGreaterThan(0);
  const requestQuery = new URL(
    `http://fixture${braveRequests[0]?.url ?? "/"}`,
  ).searchParams.get("q");
  expect(braveRequests[0]?.headers["x-subscription-token"]).toBe(BRAVE_FIXTURE_KEY);
  expect(requestQuery).toContain("DeWalt");
  expect(requestQuery).toContain("DCD791");
  expect(requestQuery).toContain("B");
  expect(requestQuery?.toLowerCase()).not.toContain("borrower");
  expect(requestQuery?.toLowerCase()).not.toContain("household");
  expect(requestQuery?.toLowerCase()).not.toContain("loan");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Ask about this item" }).click();
  const askDialog = page.getByRole("dialog", { name: `Ask about ${item.item.name}` });
  await askDialog.getByLabel("Question").fill("How do I change the drill bit?");
  await askDialog.getByRole("button", { name: "Ask attached manuals" }).click();
  await expect(askDialog.getByText("Extracted from manual text")).toBeVisible();
  await expect(askDialog.getByText("Page 1").first()).toBeVisible();
  await expect(
    askDialog.getByText(/Disconnect the battery before changing the drill bit/).first(),
  ).toBeVisible();
});
