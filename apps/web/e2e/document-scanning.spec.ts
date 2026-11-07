import { expect, test, type Page } from "@playwright/test";

async function createItem(request: import("@playwright/test").APIRequestContext) {
  const response = await request.post("/api/v1/items", {
    data: { name: "Document scanner test item" },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string } };
}

async function pageImage(
  page: Page,
  label: string,
  width: number,
  height: number,
): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    ({ label: text, width: widthValue, height: heightValue }) => {
      const canvas = document.createElement("canvas");
      canvas.width = widthValue;
      canvas.height = heightValue;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable.");
      context.fillStyle = "#f7f1e7";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = "#5f665c";
      context.lineWidth = 8;
      context.strokeRect(18, 18, canvas.width - 36, canvas.height - 36);
      context.fillStyle = "#2c312b";
      context.font = "36px sans-serif";
      context.fillText(text, 52, 90);
      context.font = "24px sans-serif";
      context.fillText("Housetory scan test fixture", 52, 140);
      context.fillText("TOTAL 42.00", 52, canvas.height - 80);
      return canvas.toDataURL("image/png");
    },
    { label, width, height },
  );
  return Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
}

test("scans, edits, reorders and saves a multi-page document from item context", async ({
  page,
  request,
}) => {
  const beforeItems = await (await request.get("/api/v1/items")).json();
  const item = await createItem(request);
  await page.goto(`/items/${item.item.id}`);
  await expect(page.getByRole("heading", { name: "Document scanner test item" })).toBeVisible();
  await page.getByRole("button", { name: "Scan pages" }).click();
  await expect(page.getByRole("heading", { name: "Scan document" })).toBeVisible();

  await page.locator("#scan-page-library").setInputFiles([
    {
      name: "page-one.png",
      mimeType: "image/png",
      buffer: await pageImage(page, "PAGE ONE", 700, 1000),
    },
    {
      name: "page-two.png",
      mimeType: "image/png",
      buffer: await pageImage(page, "PAGE TWO", 1000, 700),
    },
  ]);
  await expect(page.getByRole("button", { name: /Edit page/ })).toHaveCount(2);
  await expect(page.getByAltText("Original page 1")).toBeVisible();
  await expect(page.getByText("1 item selected")).toBeVisible();

  await page.getByRole("button", { name: "Rotate page right" }).click();
  await page.getByRole("button", { name: "Adjust Top left corner" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.getByRole("button", { name: "Move page 2 earlier" }).click();
  await page.getByLabel(/^Title/).fill("Scanned receipt");
  await page.getByLabel("Type").selectOption("receipt");
  const save = page.getByRole("button", { name: "Save scanned document" });
  await expect(save).toBeEnabled();
  await save.click();

  await expect(page.getByRole("link", { name: "Scanned receipt" }).first()).toBeVisible();
  const itemAfter = await (await request.get(`/api/v1/items/${item.item.id}`)).json();
  const document = itemAfter.item.documents[0];
  expect(document.page_count).toBe(2);
  expect(document.pages[0].original_filename).toBe("page-two.png");
  expect(document.pages[1].original_filename).toBe("page-one.png");
  expect(document.ocr_status).toMatch(/queued|processing|succeeded/);

  const pdf = await request.get(document.url);
  expect(pdf.ok()).toBeTruthy();
  expect(await pdf.body()).toBeTruthy();
  const originalPage = await request.get(document.pages[0].original_url);
  expect(originalPage.ok()).toBeTruthy();
  expect(originalPage.headers()["cache-control"]).toBe("private, no-store");

  const itemList = await (await request.get("/api/v1/items")).json();
  expect(itemList.total).toBe(beforeItems.total + 1);

  await page.goto(`/documents/${document.id}`);
  await expect(page.getByRole("heading", { name: "Scanned receipt" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Scanned pages" })).toBeVisible();
  await expect(page.getByText("2 pages").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Original" }).first()).toBeVisible();
});

test("mobile scan editor supports page editing and cancel without saving", async ({
  page,
  request,
}) => {
  const before = await (await request.get("/api/v1/documents")).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/documents");
  await page.getByRole("button", { name: "Scan pages" }).click();
  await expect(page.getByRole("heading", { name: "Scan document" })).toBeVisible();
  await page.locator("#scan-page-library").setInputFiles({
    name: "mobile-page.png",
    mimeType: "image/png",
    buffer: await pageImage(page, "MOBILE PAGE", 700, 1000),
  });
  await expect(page.getByAltText("Original page 1")).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose pages" })).toBeVisible();
  await page.getByRole("button", { name: "Adjust Top left corner" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.getByLabel(/^Title/).fill("Discarded mobile scan");
  await expect(page.getByRole("button", { name: "Save scanned document" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel scan" }).click();
  await expect(page.getByRole("heading", { name: "Scan document" })).not.toBeVisible();
  const after = await (await request.get("/api/v1/documents")).json();
  expect(after.total).toBe(before.total);
});
