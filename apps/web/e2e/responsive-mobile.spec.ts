import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

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
    expect(box?.width ?? 0).toBeLessThanOrEqual(320 - 24);
    expect(box?.height ?? 0).toBeLessThanOrEqual(568 - 24);
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
