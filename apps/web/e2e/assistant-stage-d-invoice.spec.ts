import { expect, test } from "@playwright/test";

test.skip(
  process.env.STAGE_D_ISOLATED !== "1",
  "Requires an explicitly designated disposable deployment; this test creates records.",
);

for (const flow of ["Add", "assistant"] as const) {
  test(`${flow} saves a reviewed invoice through the existing document path`, async ({ page }) => {
    const credentials = {
      email: "stagec-browser@example.com",
      password: "isolated-stagec-test-password",
    };
    const setup = await page.request.post("/api/v1/auth/setup", {
      data: { ...credentials, name: "Synthetic reviewer", household_name: "Stage D invoices" },
    });
    if (!setup.ok()) {
      const login = await page.request.post("/api/v1/auth/login", { data: credentials });
      expect(login.ok(), await login.text()).toBeTruthy();
    }

    const suffix = Date.now().toString();
    const roomResponse = await page.request.post("/api/v1/rooms", {
      data: { name: `Invoice room ${flow} ${suffix}` },
    });
    expect(roomResponse.ok(), await roomResponse.text()).toBeTruthy();
    const room = await roomResponse.json();
    const itemName = `Reviewed ${flow} drill ${suffix}`;
    const merchant = `Reviewed ${flow} shop`;
    const original = `CORNER HARDWARE ${flow} ${suffix}\nDate: 02/14/2026\nDrill Bit Set 1 x 24.50 24.50\nTotal $24.50\n`;
    const file = {
      name: `stage-d-${flow}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(original),
    };

    await page.setViewportSize(flow === "Add" ? { width: 1440, height: 900 } : { width: 390, height: 844 });
    await page.goto(flow === "Add" ? "/items" : "/assistant");
    const uploadResponse = page.waitForResponse(
      response => response.url().endsWith("/api/v1/documents") && response.request().method() === "POST",
    );
    if (flow === "Add") {
      await page.getByRole("button", { name: "Add items", exact: true }).first().click();
      await page.getByTestId("smart-add-library").setInputFiles(file);
      await page.getByRole("button", { name: "Review document" }).click();
    } else {
      await page.getByRole("button", { name: "Add document" }).click();
      const upload = page.getByRole("dialog", { name: "Add a document" });
      await upload.locator('input[type="file"]').setInputFiles(file);
      await upload.getByLabel("Type", { exact: true }).selectOption("invoice");
      await upload.getByRole("button", { name: "Add document", exact: true }).click();
    }
    const response = await uploadResponse;
    expect(response.ok(), await response.text()).toBeTruthy();
    const document = await response.json();
    await expect(page.getByRole("region", { name: "Document processing" })).toBeVisible();
    await expect.poll(async () => (
      await (await page.request.get(`/api/v1/documents/${document.id}`)).json()
    ).ocr_status, { timeout: 45_000 }).toBe("succeeded");
    const processing = await (
      await page.request.get(`/api/v1/documents/${document.id}/processing`)
    ).json();
    expect(processing.timings.local_queue_ms).toEqual(expect.any(Number));
    expect(processing.timings.local_queue_ms).toBeGreaterThanOrEqual(0);
    const openReview = page.getByRole("button", { name: /Review extraction|Use local\/manual review now/ }).first();
    if (await openReview.isVisible()) await openReview.click();
    await expect(page.getByLabel(/^Merchant/)).toBeVisible();
    await page.getByLabel(/^Merchant/).fill(merchant);
    await page.getByRole("button", { name: "Create new item" }).first().click();
    await page.getByLabel("New item name").first().fill(itemName);
    await page.getByLabel("Destination room").first().selectOption(room.id);
    const before = await (await page.request.get("/api/v1/items")).json();
    expect(before.items.some((item: { name: string }) => item.name === itemName)).toBe(false);
    await page.getByRole("button", { name: "Apply reviewed changes" }).click();
    await expect(page.getByText("A shared purchase was recorded.", { exact: false })).toBeVisible();

    const saved = await (await page.request.get(`/api/v1/documents/${document.id}`)).json();
    const linked = saved.items.find((item: { name: string }) => item.name === itemName);
    expect(linked).toBeTruthy();
    const item = (await (await page.request.get(`/api/v1/items/${linked.id}`)).json()).item;
    expect(item.purchase.vendor).toBe(merchant);
    expect(item.purchase.price_cents).toBe(2450);
    expect(item.purchase.receipt_document_id).toBe(document.id);
    const downloaded = await page.request.get(saved.original_url);
    expect(downloaded.ok()).toBe(true);
    expect(await downloaded.text()).toBe(original);
  });
}
