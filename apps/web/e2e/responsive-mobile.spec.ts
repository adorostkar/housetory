import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";
import type { DocumentSummary, DocumentSummaryList, ItemSummary, Overview } from "../src/lib/types";

async function seedDenseFixtures(request: APIRequestContext) {
  const sessionResponse = await request.get("/api/v1/auth/session");
  expect(sessionResponse.ok()).toBeTruthy();
  const session = (await sessionResponse.json()) as {
    household?: { id: string } | null;
    households?: Array<{ id: string }>;
  };
  const householdId = session.household?.id ?? session.households?.[0]?.id;
  if (householdId) {
    const selected = await request.post(`/api/v1/households/${householdId}/select`);
    expect(selected.ok()).toBeTruthy();
  }
  const householdHeaders = householdId ? { "X-Household-Id": householdId } : {};
  const propertiesResponse = await request.get("/api/v1/properties");
  expect(propertiesResponse.ok()).toBeTruthy();
  const properties = (await propertiesResponse.json()) as {
    items: Array<{ id: string }>;
  };
  const propertyId = properties.items[0]?.id;
  const suffix = randomUUID().slice(0, 8);
  const room = await request.post("/api/v1/rooms", {
    headers: householdHeaders,
    data: {
      name: `Responsive audit room ${suffix} with a long descriptive name`,
      ...(propertyId ? { property_id: propertyId } : {}),
    },
  });
  expect(room.ok(), await room.text()).toBeTruthy();
  const roomId = ((await room.json()) as { id: string }).id;
  const container = await request.post("/api/v1/containers", {
    headers: householdHeaders,
    data: {
      room_id: roomId,
      container_type: "box",
      name: `Responsive audit container ${suffix} with a long descriptive label`,
    },
  });
  expect(container.ok()).toBeTruthy();
  const item = await request.post("/api/v1/items", {
    headers: householdHeaders,
    data: {
      name: `A deliberately long responsive fixture ${suffix} item name for wrapping checks`,
      description:
        "Long description with SUPERLONGUNBREAKABLETOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789 to test wrapping without hiding data.",
      brand: "LongBrandNameThatShouldWrap",
      model: "MODEL-WITH-A-VERY-LONG-IDENTIFIER-1234567890",
      serial_number: "SERIAL-RESPONSIVE-0000000000000000001",
      quantity: 2,
      room_id: roomId,
      storage_location_id: ((await container.json()) as { id: string }).id,
      purchase: {
        merchant: `A very long merchant name ${suffix} used for responsive purchase wrapping`,
        purchase_date: "2026-02-01",
        price_cents: 10000,
        currency: "USD",
      },
      current_value_cents: 4000,
      current_value_currency: "USD",
    },
  });
  expect(item.ok()).toBeTruthy();
  const itemId = ((await item.json()) as { item: { id: string } }).item.id;
  const document = await request.post("/api/v1/documents", {
    headers: householdHeaders,
    multipart: {
      file: {
        name: "responsive-receipt.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Responsive audit supporting document."),
      },
      title: `Long responsive audit receipt ${suffix} title for document rows`,
      document_type: "receipt",
      item_ids: itemId,
    },
  });
  expect(document.ok()).toBeTruthy();
  const loan = await request.post("/api/v1/loans", {
    headers: householdHeaders,
    data: {
      item_id: itemId,
      borrower_name: `Responsive Audit Borrower ${suffix}`,
      quantity: 1,
      lent_on: "2026-02-10",
      request_id: randomUUID(),
    },
  });
  expect(loan.ok()).toBeTruthy();
  return { itemId, roomId };
}

function seedAiTaskRows(householdId: string) {
  const sql = `
    INSERT INTO ai_providers
      (household_id, provider, display_name, base_url, default_model, enabled, cloud_consent)
    VALUES
      ('${householdId}', 'openrouter',
       'OpenRouter production account with a long descriptive display name',
       'https://openrouter.ai/api/v1',
       'openrouter/anthropic/claude-3.5-sonnet-2026-long-identifier-abcdefghijklmnopqrstuvwxyz',
       true, true),
      ('${householdId}', 'openai',
       'OpenAI production account with a long descriptive display name',
       'https://api.openai.com/v1',
       'gpt-4.1-vision-2026-very-long-model-identifier-abcdefghijklmnopqrstuvwxyz',
       true, true)
    ON CONFLICT (household_id, provider) DO UPDATE SET
      display_name = excluded.display_name,
      base_url = excluded.base_url,
      default_model = excluded.default_model,
      enabled = true,
      cloud_consent = true;

    INSERT INTO ai_task_settings (household_id, task, provider_id, model, enabled)
    SELECT
      '${householdId}',
      v.task,
      CASE WHEN v.provider = 'openai' THEN p_openai.id ELSE p_openrouter.id END,
      v.model,
      true
    FROM (VALUES
      ('assistant', 'openrouter', 'openrouter/anthropic/claude-3.5-sonnet-2026-long-identifier-abcdefghijklmnopqrstuvwxyz'),
      ('imports', 'openai', 'gpt-4.1-mini-2026-long-identifier-abcdefghijklmnopqrstuvwxyz'),
      ('documents', 'openai', 'gpt-4.1-2026-long-identifier-abcdefghijklmnopqrstuvwxyz'),
      ('search', 'openrouter', 'openrouter/google/gemini-2.5-flash-long-identifier-abcdefghijklmnopqrstuvwxyz'),
      ('vision', 'openai', 'gpt-4.1-vision-2026-very-long-model-identifier-abcdefghijklmnopqrstuvwxyz'),
      ('transcription', 'openai', 'gpt-4o-transcribe-long-identifier-abcdefghijklmnopqrstuvwxyz')
    ) AS v(task, provider, model)
    CROSS JOIN (
      SELECT id FROM ai_providers
      WHERE household_id = '${householdId}' AND provider = 'openrouter'
    ) p_openrouter
    CROSS JOIN (
      SELECT id FROM ai_providers
      WHERE household_id = '${householdId}' AND provider = 'openai'
    ) p_openai
    ON CONFLICT (household_id, task) DO UPDATE SET
      provider_id = excluded.provider_id,
      model = excluded.model,
      enabled = true;
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

async function pageMetrics(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const visible = (element: HTMLElement) => {
      if (!element.getClientRects().length) return false;
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none";
    };
    const textEntries = Array.from(
      document.querySelectorAll<HTMLElement>(
        "input,textarea,select,[contenteditable=true]",
      ),
    )
      .filter(visible)
      .filter((element) => {
        if (element.tagName === "TEXTAREA" || element.tagName === "SELECT") return true;
        if (element.tagName !== "INPUT") return false;
        return ![
          "button",
          "checkbox",
          "color",
          "file",
          "hidden",
          "image",
          "radio",
          "range",
          "reset",
          "submit",
        ].includes((element as HTMLInputElement).type.toLowerCase());
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          type: (element as HTMLInputElement).type || "",
          id: element.id,
          label: element.getAttribute("aria-label") || element.id || "",
          font: Number.parseFloat(getComputedStyle(element).fontSize),
          width: rect.width,
          height: rect.height,
        };
      });
    const nav = document.querySelector<HTMLElement>('[data-testid="mobile-bottom-nav"]');
    const navVisible =
      nav !== null &&
      nav.getClientRects().length > 0 &&
      getComputedStyle(nav).display !== "none" &&
      getComputedStyle(nav).visibility !== "hidden";
    return {
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      textEntries,
      nav:
        navVisible && nav
          ? Array.from(nav.querySelectorAll<HTMLElement>("a,button")).map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                text: (element.textContent || "").trim(),
                left: rect.left,
                right: rect.right,
                width: rect.width,
                height: rect.height,
                font: Number.parseFloat(getComputedStyle(element).fontSize),
              };
            })
          : [],
    };
  });
}

test.describe("mobile responsive", () => {
  test.use({ viewport: { width: 320, height: 568 }, hasTouch: true, deviceScaleFactor: 3 });

  test("appearance cycles in the header and replaces the Settings control", async ({ page }) => {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("/items");
      await page.evaluate(() => localStorage.setItem("housetory-theme", "light"));
      await page.reload();
      const button = page.getByRole("button", { name: /^Appearance:/ });
      await expect(button).toHaveAccessibleName("Appearance: Light. Switch to dark mode");
      await button.click();
      await expect(button).toHaveAccessibleName("Appearance: Dark. Switch to system mode");
      await expect(page.locator("html")).toHaveClass(/dark/);
      await button.focus();
      await page.keyboard.press("Enter");
      await expect(button).toHaveAccessibleName("Appearance: System. Switch to light mode");
      await expect(button.locator("svg")).toHaveClass(/lucide-monitor/);
      await expect(page.locator("html")).not.toHaveClass(/dark/);
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveClass(/dark/);
      await expect(button).toHaveAccessibleName("Appearance: System. Switch to light mode");
      await page.reload();
      await expect(button).toHaveAccessibleName("Appearance: System. Switch to light mode");
      await expect(page.locator("html")).toHaveClass(/dark/);
      await button.click();
      await expect(button).toHaveAccessibleName("Appearance: Light. Switch to dark mode");
      await expect(page.locator("html")).not.toHaveClass(/dark/);
      await page.goto("/settings");
      await expect(page.getByRole("heading", { name: "Storage", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toHaveCount(0);
      await expect(page.getByRole("group", { name: "Theme", exact: true })).toHaveCount(0);
    }
  });

  test("Add sheet waits for explicit text focus and retains desktop autofocus", async ({ page }) => {
    for (const width of [390, 768, 1023, 1024, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/items");
      const mobile = width < 1024;
      const trigger = mobile
        ? page.getByTestId("mobile-bottom-nav").getByRole("button", { name: "Add items", exact: true })
        : page.getByRole("main").getByRole("button", { name: "Add items", exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Add items", exact: true });
      const heading = dialog.getByRole("heading", { name: "Add items", exact: true });
      const input = dialog.getByRole("textbox", { name: "Describe items or paste a product link" });
      if (mobile) {
        await expect(heading).toBeFocused();
        await expect(input).not.toBeFocused();
        await page.keyboard.press("Tab");
        await expect(dialog.getByRole("button", { name: /^Place:/ })).toBeFocused();
        await input.tap();
      }
      await expect(input).toBeFocused();
      await input.pressSequentially("Two chairs");
      await expect(input).toHaveValue("Two chairs");
      await expect(dialog.getByRole("button", { name: "Review items", exact: true })).toBeEnabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(mobile ? heading : input).toBeFocused();
      await dialog.getByRole("button", { name: "Close", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      if (width === 390) {
        await trigger.click();
        await dialog.getByRole("link", { name: "or fill in the form yourself" }).click();
        await expect(page).toHaveURL(/\/items\/new(?:\?|$)/);
        await expect(page.getByRole("textbox", { name: "Item name", exact: true })).toBeFocused();
      }
    }
  });

  test("document card surfaces open details without hijacking secondary actions", async ({ page }) => {
    const id = "00000000-0000-0000-0000-000000000003";
    const receipt: DocumentSummary = {
      id, title: "Surface receipt", document_type: "receipt",
      original_filename: "receipt.pdf", content_type: "application/pdf",
      original_content_type: "application/pdf", byte_size: 100, original_byte_size: 100,
      document_date: null, merchant: "Surface fixture merchant", notes: null,
      ocr_status: "not_requested", ocr_error: null, ocr_confidence: null, ocr_processed_at: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
      items: [{ id: "00000000-0000-0000-0000-000000000001", name: "Linked fixture item" }],
      item_count: 1, page_count: 0,
      url: `/api/v1/documents/${id}/file`, original_url: `/api/v1/documents/${id}/original`,
    };
    await page.route("**/api/v1/documents?**", route =>
      route.fulfill({ json: { items: [receipt], total: 1, limit: 24, offset: 0 } }),
    );
    await page.route(`**/api/v1/documents/${id}**`, route => {
      expect(route.request().method()).toBe("GET");
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/file")) {
        return route.fulfill({
          contentType: "application/pdf",
          headers: { "Content-Disposition": 'attachment; filename="receipt.pdf"' },
          body: "%PDF-1.4\n%%EOF",
        });
      }
      if (path.endsWith("/related-items")) {
        return route.fulfill({ json: { items: [], suggested_item_ids: [] } });
      }
      if (path.endsWith("/extraction")) {
        return route.fulfill({ status: 409, json: { error: { code: "not_ready", message: "Not extracted" } } });
      }
      return route.fulfill({ json: { ...receipt, pages: [], extracted_text: null, extracted_metadata: {} } });
    });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const surface of ["metadata", "icon", "padding"]) {
        await page.goto("/documents");
        const card = page.getByRole("article").filter({ has: page.getByText(receipt.title, { exact: true }) });
        await expect(card).toBeVisible();
        const target = surface === "metadata"
          ? card.getByText(/Surface fixture merchant/)
          : surface === "icon" ? card.locator("svg").first() : card;
        const box = await target.boundingBox();
        if (!box) throw new Error(`Missing card ${surface} hit region`);
        await page.mouse.click(
          box.x + (surface === "padding" ? box.width - 6 : box.width / 2),
          box.y + box.height / 2,
        );
        await expect(page, `${surface} surface at ${width}px`).toHaveURL(new RegExp(`/documents/${id}$`));
      }
      await page.goto("/documents");
      const title = page.getByRole("link", { name: receipt.title, exact: true });
      await title.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/documents/${id}$`));
      await page.goto("/documents");
      if (width === 1440) {
        const newTab = page.context().waitForEvent("page", { timeout: 10_000 });
        await page.getByRole("link", { name: receipt.title, exact: true }).click({ button: "middle" });
        const tab = await newTab;
        await expect(tab).toHaveURL(new RegExp(`/documents/${id}$`));
        await tab.close();
        await expect(page).toHaveURL(/\/documents$/);
      }
      await page.getByRole("link", { name: "Linked fixture item", exact: true }).click();
      await expect(page).toHaveURL(/\/items\/00000000-0000-0000-0000-000000000001$/);
      await page.goto("/documents");
      const download = page.waitForEvent("download");
      await page.getByRole("link", { name: "Download Surface receipt", exact: true }).click();
      await download;
      await expect(page).toHaveURL(/\/documents$/);
      await page.getByRole("button", { name: "Delete Surface receipt" }).click();
      await expect(page.getByRole("dialog", { name: "Delete this document?" })).toBeVisible();
      await expect(page).toHaveURL(/\/documents$/);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  });

  test("automatic scan previews remain adjustable and cancellable without real uploads", async ({ page }) => {
    const timestamp = "2026-01-01T00:00:00Z";
    const scannedPage = {
      id: "fixture-page", page_number: 1, width: 600, height: 900,
      original_filename: "fixture.png", original_content_type: "image/png",
      original_byte_size: 100, cleaned_content_type: "image/jpeg", cleaned_byte_size: 80,
      original_url: "/api/v1/documents/scans/fixture-scan/pages/fixture-page/original",
      cleaned_url: "/api/v1/documents/scans/fixture-scan/pages/fixture-page/file",
      adjustments: {
        rotation: 0, corners: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }],
        color_mode: "document", contrast: 1,
      },
      detection_status: "detected", updated_at: timestamp,
    };
    const patches: Array<{ rotation: number }> = [];
    let cancellations = 0;
    await page.route("**/api/v1/documents/scans**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "DELETE" && path.endsWith("/fixture-scan")) {
        cancellations += 1;
        return route.fulfill({ status: 204 });
      }
      if (request.method() === "POST" && path.endsWith("/scans")) {
        return route.fulfill({ json: { id: "fixture-scan", status: "draft", pages: [], created_at: timestamp, updated_at: timestamp } });
      }
      if (request.method() === "POST" && path.endsWith("/pages")) {
        return route.fulfill({ json: scannedPage });
      }
      if (request.method() === "PATCH") {
        const adjustments = request.postDataJSON();
        patches.push(adjustments);
        return route.fulfill({ json: { ...scannedPage, adjustments, detection_status: "manual", updated_at: "2026-01-01T00:01:00Z" } });
      }
      expect(request.method()).toBe("GET");
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#ddd"/><rect x="60" y="90" width="480" height="720" fill="white"/><text x="100" y="170" font-size="32">Synthetic receipt</text></svg>',
      });
    });
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/documents");
      await page.getByRole("button", { name: "Scan pages", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Scan document", exact: true });
      await dialog.locator('input[capture="environment"]').setInputFiles({
        name: "fixture.png", mimeType: "image/png", buffer: Buffer.from("synthetic image fixture"),
      });
      await expect(dialog.getByText(/Page edges detected and straightened/)).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Save scanned document" })).toBeVisible();
      const corner = dialog.getByRole("button", { name: "Adjust Top left corner" });
      await corner.scrollIntoViewIfNeeded();
      const box = await corner.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      await corner.focus();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => patches.length).toBeGreaterThan(0);
      patches.length = 0;
      await dialog.getByRole("button", { name: "Rotate page right" }).click();
      await expect.poll(() => patches.at(-1)?.rotation).toBe(90);
      const overflow = await dialog.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return {
          extra: element.scrollWidth - element.clientWidth,
          offenders: Array.from(element.querySelectorAll("*")).filter(child =>
            child.getBoundingClientRect().right > bounds.right + 1,
          ).map(child => ({ tag: child.tagName, className: child.getAttribute("class") })).slice(0, 5),
        };
      });
      expect(overflow.extra, JSON.stringify(overflow.offenders)).toBeLessThanOrEqual(1);
      await dialog.getByRole("button", { name: "Cancel scan", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      patches.length = 0;
    }
    expect(cancellations).toBe(3);
  });

  test("existing scan cleanup preserves its route and refreshes the same-page preview", async ({ page }) => {
    const id = "00000000-0000-0000-0000-000000000003";
    const timestamp = "2026-01-01T00:00:00Z";
    const changedAt = "2026-01-01T00:01:00Z";
    const canonicalPage = {
      id: "canonical-page", page_number: 1, width: 600, height: 900,
      original_filename: "original.png", original_content_type: "image/png",
      original_byte_size: 100, cleaned_content_type: "image/jpeg", cleaned_byte_size: 80,
      original_url: "/api/v1/documents/scans/canonical-scan/pages/canonical-page/original",
      cleaned_url: "/api/v1/documents/scans/canonical-scan/pages/canonical-page/file",
      adjustments: { rotation: 0, corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], color_mode: "color", contrast: 1 },
      detection_status: "manual_required", updated_at: timestamp,
    };
    const initialDocument = {
      id, title: "Existing fixture scan", document_type: "receipt",
      original_filename: "original.png", content_type: "application/pdf", original_content_type: "image/png",
      byte_size: 100, original_byte_size: 100, document_date: null,
      merchant: "Preserved fixture merchant", notes: "Preserved fixture notes",
      ocr_status: "queued", ocr_error: null, ocr_confidence: null, ocr_processed_at: null,
      created_at: timestamp, updated_at: timestamp, items: [], item_count: 0, page_count: 1,
      url: `/api/v1/documents/${id}/file`, original_url: `/api/v1/documents/${id}/original`,
      pages: [canonicalPage], extracted_text: null, extracted_metadata: {},
    };
    const draftPage = {
      ...canonicalPage, id: "draft-page", detection_status: "detected",
      original_url: "/api/v1/documents/scans/cleanup-draft/pages/draft-page/original",
      cleaned_url: "/api/v1/documents/scans/cleanup-draft/pages/draft-page/file",
    };
    let currentDocument = initialDocument;
    let commits = 0;
    let cancellations = 0;
    await page.route("**/api/v1/documents/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path.endsWith("/scans")) {
        expect(request.postDataJSON()).toEqual({ target_document_id: id });
        return route.fulfill({ json: { id: "cleanup-draft", status: "draft", target_document_id: id, pages: [draftPage], created_at: timestamp, updated_at: timestamp } });
      }
      if (request.method() === "POST" && path.endsWith("/cleanup-draft/commit")) {
        expect(Object.keys(request.postDataJSON())).toEqual(["request_id"]);
        commits += 1;
        currentDocument = { ...initialDocument, updated_at: changedAt, pages: [{ ...canonicalPage, updated_at: changedAt }] };
        return route.fulfill({ json: currentDocument });
      }
      if (request.method() === "DELETE" && path.endsWith("/cleanup-draft")) {
        cancellations += 1;
        return route.fulfill({ status: 204 });
      }
      expect(request.method()).toBe("GET");
      if (path === `/api/v1/documents/${id}`) return route.fulfill({ json: currentDocument });
      if (path.endsWith("/related-items")) return route.fulfill({ json: { items: [], suggested_item_ids: [] } });
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="white"/><text x="60" y="100" font-size="32">Existing synthetic scan</text></svg>',
      });
    });
    for (const width of [390, 1440]) {
      currentDocument = initialDocument;
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/documents/${id}`);
      const preview = page.getByAltText("Existing fixture scan · page 1", { exact: true });
      await expect(preview).toBeVisible();
      const oldSource = await preview.getAttribute("src");
      await page.getByRole("button", { name: "Clean up scan", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Clean up document", exact: true });
      await expect(dialog.getByAltText("Original page 1")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Take photo" })).toHaveCount(0);
      await expect(dialog.getByLabel("Title", { exact: true })).toHaveCount(0);
      await dialog.getByRole("button", { name: "Save cleaned document" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/documents/${id}$`));
      await expect(preview).not.toHaveAttribute("src", oldSource ?? "");
      await expect(page.getByText("Preserved fixture notes", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Clean up scan", exact: true }).click();
      await expect(dialog.getByAltText("Original page 1")).toBeVisible();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(preview).toHaveAttribute("src", /00%3A01%3A00Z$/);
    }
    expect(commits).toBe(2);
    expect(cancellations).toBe(2);
  });

  test("Home and document cards stay bounded with long item names", async ({ page }) => {
    const item: ItemSummary = {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Long equipment name SERIAL_ABCDEFGHIJKLMNOPQRSTUVWXYZ_012345678901234567890123456789",
      description: null, brand: null, model: null, quantity: 1, on_loan_quantity: 0,
      condition: "good", is_archived: false, room: null, location: null,
      location_path: [], category: null, tags: [], primary_photo: null,
      purchase: null, purchase_info_status: "unrecorded", purchase_info_missing_fields: [],
      warranty: null, current_value_cents: null, current_value_currency: "USD",
      current_value_basis: null, current_value_total_cents: null,
      current_value_estimated_at: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    };
    await page.addInitScript(() => localStorage.setItem("housetory.items.view", "list"));
    await page.route("**/api/v1/overview?**", async route => {
      const response = await route.fetch();
      const data: Overview = await response.json();
      await route.fulfill({
        response,
        json: { ...data, item_count: 1, total_quantity: 1, recent_items: [item] },
      });
    });
    const receipt: DocumentSummary = {
      id: "00000000-0000-0000-0000-000000000003",
      title: "Long-name receipt", document_type: "receipt",
      original_filename: "receipt.txt", content_type: "text/plain",
      original_content_type: "text/plain", byte_size: 100, original_byte_size: 100,
      document_date: null, merchant: null, notes: null,
      ocr_status: "not_requested", ocr_error: null, ocr_confidence: null, ocr_processed_at: null,
      created_at: item.created_at, updated_at: item.updated_at,
      items: [{ id: item.id, name: item.name }], item_count: 1, page_count: 0,
      url: "/api/v1/documents/00000000-0000-0000-0000-000000000003/file",
      original_url: "/api/v1/documents/00000000-0000-0000-0000-000000000003/original",
    };
    await page.route("**/api/v1/documents?**", async route => {
      const response = await route.fetch();
      const data: DocumentSummaryList = await response.json();
      await route.fulfill({ response, json: { ...data, total: 1, items: [receipt] } });
    });
    for (const width of [360, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/");
      await expect(page.getByText(item.name, { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      await page.goto("/documents");
      await expect(page.getByRole("link", { name: item.name, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    }
  });

  test("pages and text controls stay within phone, landscape and tablet viewports", async ({
    page,
    request,
  }) => {
    await fs.mkdir("../../docs/walkthrough/responsive-mobile", { recursive: true });
    const { itemId } = await seedDenseFixtures(request);
    const sizes = [
      { width: 320, height: 568 },
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
      { width: 844, height: 390 },
      { width: 768, height: 1024 },
      { width: 869, height: 700 },
      { width: 1024, height: 768 },
    ];
    const paths = [
      "/",
      "/items",
      "/settings",
      "/review",
      "/search",
      `/items/${itemId}/edit`,
      "/settings/ai",
      "/loans",
      "/rooms",
      "/containers",
      "/documents",
      "/purchases",
      "/assistant",
    ];
    await page.goto("/");
    const viewportContent = await page
      .locator('meta[name="viewport"]')
      .getAttribute("content");
    expect(viewportContent).not.toMatch(/maximum-scale|user-scalable\s*=\s*no/i);
    const failures: unknown[] = [];
    for (const size of sizes) {
      await page.setViewportSize(size);
      for (const path of paths) {
        await page.goto(path);
        await page.waitForTimeout(100);
        const metrics = await pageMetrics(page);
        const overflow =
          metrics.scrollWidth > metrics.viewport + 1 ||
          metrics.bodyScrollWidth > metrics.viewport + 1;
        const small = metrics.textEntries.filter((entry) => entry.font < 16);
        if (overflow || small.length > 0) {
          failures.push({
            size,
            path,
            overflow,
            scrollWidth: metrics.scrollWidth,
            viewport: metrics.viewport,
            small,
          });
        }
        if (size.width <= 430) {
          if (metrics.nav.length !== 5) {
            failures.push({ size, path, navCount: metrics.nav.length });
          }
          for (let index = 0; index < metrics.nav.length; index += 1) {
            const current = metrics.nav[index];
            const next = metrics.nav[index + 1];
            if (current.width < 44 || current.height < 44) {
              failures.push({ size, path, navTarget: current });
            }
            if (current.font < 11) {
              failures.push({ size, path, navFont: current });
            }
            if (next && current.right > next.left + 0.5) {
              failures.push({ size, path, navOverlap: [current, next] });
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    const enlargedFont = await page
      .getByLabel("Household name")
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(enlargedFont).toBeGreaterThanOrEqual(20);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await page.waitForTimeout(350);
    await page.screenshot({
      path: "../../docs/walkthrough/responsive-mobile/after-320-settings.png",
      fullPage: false,
    });
    await page.goto(`/items/${itemId}/edit`);
    await expect(page.getByLabel("Item name")).toBeVisible();
    await page.waitForTimeout(350);
    await page.screenshot({
      path: "../../docs/walkthrough/responsive-mobile/after-320-item-edit.png",
      fullPage: false,
    });
  });

  test("More exposes every secondary destination with usable targets", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/");
    await page.getByRole("button", { name: "More destinations" }).click();
    const menu = page.getByTestId("mobile-more-menu");
    await expect(menu).toBeVisible();
    await page.waitForTimeout(350);
    await page.screenshot({
      path: "../../docs/walkthrough/responsive-mobile/after-320-more-menu.png",
      fullPage: false,
    });
    const menuItems = menu.getByRole("menuitem");
    await expect(menuItems).toHaveCount(8);
    for (const item of await menuItems.all()) {
      const box = await item.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
    }
    await menu.getByRole("menuitem", { name: "Containers" }).click();
    await expect(page).toHaveURL(/\/containers$/);
    await expect(page.getByRole("button", { name: "More destinations" })).toHaveAttribute(
      "data-active",
      "true",
    );

    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto("/settings/ai");
    await page.getByRole("button", { name: "More destinations" }).click();
    const landscapeMenu = page.getByTestId("mobile-more-menu");
    await expect(landscapeMenu).toBeVisible();
    await page.waitForTimeout(350);
    const menuMetrics = await landscapeMenu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    });
    expect(menuMetrics.top).toBeGreaterThanOrEqual(0);
    expect(menuMetrics.bottom).toBeLessThanOrEqual(390);
    expect(menuMetrics.scrollHeight).toBeGreaterThan(menuMetrics.clientHeight);
    await landscapeMenu.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(landscapeMenu.getByRole("menuitem", { name: "Settings" })).toBeVisible();
    await page.waitForTimeout(150);
    await page.screenshot({
      path: "../../docs/walkthrough/responsive-mobile/after-844-landscape-more.png",
      fullPage: false,
    });
  });

  test("software-keyboard viewport shrink hides the bar without losing focus or text", async ({
    page,
    request,
  }) => {
    const { itemId } = await seedDenseFixtures(request);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/items/${itemId}/edit`);
    const input = page.getByLabel("Item name");
    await input.focus();
    await expect(page.getByTestId("mobile-bottom-nav")).toBeVisible();
    await input.fill("Keyboard stable value");
    await page.setViewportSize({ width: 390, height: 500 });
    await page.waitForTimeout(200);
    await expect(page.getByTestId("mobile-bottom-nav")).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Keyboard stable value");
    await page.keyboard.type(" typed");
    await expect(input).toHaveValue("Keyboard stable value typed");
    await page.screenshot({
      path: "../../docs/walkthrough/responsive-mobile/after-390-keyboard-hidden.png",
      fullPage: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    await expect(page.getByTestId("mobile-bottom-nav")).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Keyboard stable value typed");
    await page.screenshot({
      path: "../../docs/walkthrough/responsive-mobile/after-390-keyboard-restored.png",
      fullPage: false,
    });

    await page.locator("main h1").click();
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(200);
    await input.focus();
    await expect(page.getByTestId("mobile-bottom-nav")).toBeVisible();
  });

  test("schedule and add-item dialogs fit and scroll without covering controls", async ({
    page,
    request,
  }) => {
    for (const size of [
      { width: 390, height: 844 },
      { width: 320, height: 568 },
    ]) {
      await page.setViewportSize(size);
      await page.goto("/review");
      await page
        .getByRole("button", { name: /Set up schedule|Edit schedule/ })
        .click();
      const dialog = page.getByRole("dialog", { name: "Scheduled inventory review" });
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(350);
      const metrics = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          inputs: Array.from(element.querySelectorAll("input,textarea,select"))
            .filter((entry) => {
              const element = entry as HTMLElement;
              if (!element.getClientRects().length) return false;
              if (element.tagName === "TEXTAREA" || element.tagName === "SELECT") return true;
              if (element.tagName !== "INPUT") return false;
              return !["checkbox", "radio", "file", "hidden", "button", "submit"].includes(
                (element as HTMLInputElement).type.toLowerCase(),
              );
            })
            .map((entry) => Number.parseFloat(getComputedStyle(entry).fontSize)),
        };
      });
      expect(metrics.width).toBeLessThanOrEqual(size.width - 24);
      expect(metrics.height).toBeLessThanOrEqual(size.height - 24);
      expect(metrics.left).toBeGreaterThanOrEqual(0);
      expect(metrics.right).toBeLessThanOrEqual(size.width);
      expect(metrics.top).toBeGreaterThanOrEqual(0);
      expect(metrics.bottom).toBeLessThanOrEqual(size.height);
      expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
      expect(metrics.inputs.every((font) => font >= 16)).toBe(true);
      if (size.width === 390) {
        await page.screenshot({
          path: "../../docs/walkthrough/responsive-mobile/after-390-schedule-dialog.png",
          fullPage: false,
        });
      }
      await dialog.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(dialog.getByRole("button", { name: "Save schedule" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    }

    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/items");
    await page.getByRole("button", { name: "Add items" }).click();
    const addDialog = page.getByRole("dialog", { name: "Add items" });
    await expect(addDialog).toBeVisible();
    const box = await addDialog.boundingBox();
    expect(box).not.toBeNull();
    // Below lg the Add items surface is a bottom sheet: full width, anchored
    // to the bottom edge and never taller than the viewport.
    expect(box?.width ?? 0).toBeLessThanOrEqual(320);
    expect(box?.height ?? 0).toBeLessThanOrEqual(568 - 16);
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBeGreaterThanOrEqual(567);
    await expect(
      addDialog.getByRole("button", { name: "Review items" }),
    ).toBeInViewport();
    await page.keyboard.press("Escape");

    const { itemId } = await seedDenseFixtures(request);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/items/${itemId}`);
    const measureDialog = async (dialog: import("@playwright/test").Locator) => {
      const metrics = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          inputs: Array.from(element.querySelectorAll("input,textarea,select"))
            .filter((entry) => {
              const element = entry as HTMLElement;
              if (!element.getClientRects().length) return false;
              if (element.tagName === "TEXTAREA" || element.tagName === "SELECT") return true;
              if (element.tagName !== "INPUT") return false;
              return !["checkbox", "radio", "file", "hidden", "button", "submit"].includes(
                (element as HTMLInputElement).type.toLowerCase(),
              );
            })
            .map((entry) => Number.parseFloat(getComputedStyle(entry).fontSize)),
        };
      });
      expect(metrics.width).toBeLessThanOrEqual(390 - 24);
      expect(metrics.height).toBeLessThanOrEqual(844 - 24);
      expect(metrics.left).toBeGreaterThanOrEqual(0);
      expect(metrics.right).toBeLessThanOrEqual(390);
      expect(metrics.top).toBeGreaterThanOrEqual(0);
      expect(metrics.bottom).toBeLessThanOrEqual(844);
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
      expect(metrics.inputs.every((font) => font >= 16)).toBe(true);
    };
    await page.getByRole("button", { name: "Lend" }).first().click();
    const lendDialog = page.getByRole("dialog", { name: /Lend / });
    await expect(lendDialog).toBeVisible();
    await page.waitForTimeout(300);
    await measureDialog(lendDialog);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Record return" }).first().click();
    const returnDialog = page.getByRole("dialog", { name: /Return from/ });
    await expect(returnDialog).toBeVisible();
    await page.waitForTimeout(300);
    await measureDialog(returnDialog);
    await page.keyboard.press("Escape");
  });
});

  test("AI task rows fit every intermediate width with real provider/task data", async ({
    page,
  }) => {
    const sessionResponse = await page.request.get("/api/v1/auth/session");
    expect(sessionResponse.ok()).toBeTruthy();
    const session = (await sessionResponse.json()) as {
      household?: { id: string } | null;
      households?: Array<{ id: string }>;
    };
    const originalHouseholdId = session.household?.id ?? session.households?.[0]?.id;
    expect(originalHouseholdId).toBeTruthy();
    const createdHousehold = await page.request.post("/api/v1/households", {
      data: { name: `Responsive AI layout ${randomUUID()}` },
    });
    expect(createdHousehold.ok()).toBeTruthy();
    const testHouseholdId = ((await createdHousehold.json()) as {
      household: { id: string };
    }).household.id;
    seedAiTaskRows(testHouseholdId);

    const sizes = [320, 640, 700, 767, 768, 800, 820, 843, 844, 869, 1024, 1280, 1440];
    const failures: unknown[] = [];
    try {
    for (const width of sizes) {
      await page.setViewportSize({ width, height: width <= 430 ? 844 : 1024 });
      await page.goto("/settings/ai");
      await expect(page.getByRole("heading", { name: "AI providers", level: 1 })).toBeVisible();
      await expect(page.getByTestId("ai-task-row")).toHaveCount(6);
      await page.waitForTimeout(120);
      const metrics = await page.evaluate(() => {
        const viewport = window.innerWidth;
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="ai-task-row"]'),
        ).map((row) => {
          const rowRect = row.getBoundingClientRect();
          const actions = row.querySelector<HTMLElement>(
            '[data-testid="ai-task-actions"]',
          );
          const actionsRect = actions?.getBoundingClientRect();
          const buttons = Array.from(
            row.querySelectorAll<HTMLElement>('[data-testid="ai-task-actions"] button'),
          ).map((button) => {
            const rect = button.getBoundingClientRect();
            return {
              text: (button.textContent || "").trim(),
              left: rect.left,
              right: rect.right,
              width: rect.width,
              height: rect.height,
            };
          });
          const provider = row.querySelector<HTMLElement>(
            '[data-testid="ai-task-provider"]',
          );
          const model = row.querySelector<HTMLElement>('[data-testid="ai-task-model"]');
          return {
            left: rowRect.left,
            right: rowRect.right,
            width: rowRect.width,
            scrollWidth: row.scrollWidth,
            clientWidth: row.clientWidth,
            actionsRight: actionsRect?.right ?? null,
            actionsWidth: actionsRect?.width ?? null,
            providerWidth: provider?.getBoundingClientRect().width ?? 0,
            modelWidth: model?.getBoundingClientRect().width ?? 0,
            buttons,
          };
        });
        return {
          viewport,
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          rows,
        };
      });
      if (width === 768) {
        await page
          .getByRole("heading", { name: "Default text model", level: 2 })
          .scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        await page.screenshot({
          path: "../../docs/walkthrough/responsive-mobile/after-768-ai-settings.png",
          fullPage: false,
        });
      }
      if (
        metrics.scrollWidth > metrics.viewport + 1 ||
        metrics.bodyScrollWidth > metrics.viewport + 1
      ) {
        failures.push({ width, documentOverflow: metrics });
      }
      for (const row of metrics.rows) {
        if (
          row.right > metrics.viewport + 0.5 ||
          row.left < -0.5 ||
          row.scrollWidth > row.clientWidth + 1 ||
          row.actionsRight === null ||
          row.actionsRight > row.right + 0.5 ||
          row.providerWidth <= 0 ||
          row.modelWidth <= 0
        ) {
          failures.push({ width, row });
        }
        for (const button of row.buttons) {
          if (
            button.right > row.right + 0.5 ||
            button.right > metrics.viewport + 0.5 ||
            button.left < -0.5 ||
            button.height < 32
          ) {
            failures.push({ width, button });
          }
        }
      }
    }
    expect(failures).toEqual([]);
    } finally {
      if (originalHouseholdId) {
        await page.request.post(
          `/api/v1/households/${originalHouseholdId}/select`,
        );
      }
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
          `DELETE FROM households WHERE id = '${testHouseholdId}';`,
        ],
        { stdio: "pipe" },
      );
    }
  });

test.describe("desktop regression", () => {
  test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

  test("desktop keeps compact controls and no mobile bottom bar", async ({ page, request }) => {
    const { itemId } = await seedDenseFixtures(request);
    for (const path of ["/", "/items", "/settings", `/items/${itemId}/edit`]) {
      await page.goto(path);
      const metrics = await pageMetrics(page);
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewport + 1);
      expect(metrics.nav).toEqual([]);
      for (const entry of metrics.textEntries) {
        expect(entry.font).toBeGreaterThanOrEqual(12);
      }
    }
    await page.goto(`/items/${itemId}/edit`);
    await expect(page.getByLabel("Item name")).toHaveCSS("font-size", "15.2px");
    await page.screenshot({
      path: "../../docs/walkthrough/responsive-mobile/after-1440-desktop.png",
      fullPage: false,
    });
  });
});
