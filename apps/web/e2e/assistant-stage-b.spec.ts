import { expect, test, type Page } from "@playwright/test";

const household = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "Synthetic household",
  default_currency: "USD",
  warranty_reminder_days: 30,
};

async function fixture(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/auth/session") {
      return route.fulfill({ json: {
        authenticated: true, setup_required: false,
        user: { id: "00000000-0000-0000-0000-000000000002", name: "Reviewer", email: "reviewer@example.invalid", created_at: "2026-01-01T00:00:00Z" },
        household, households: [{ ...household, role: "owner", is_current: true, property_count: 0 }], role: "owner",
      } });
    }
    if (url.pathname === "/api/v1/search/scopes") {
      return route.fulfill({ json: { items: [{ id: household.id, name: household.name, properties: [] }] } });
    }
    if (url.pathname === "/api/v1/ai/status") {
      return route.fulfill({ json: { configured: false, available: false, data_leaves_server: false, privacy_note: "AI off" } });
    }
    if (url.pathname === "/api/v1/search/query") {
      const { query } = route.request().postDataJSON();
      return route.fulfill({ json: {
        query, mode: "fallback", ai_used: false, ai_attempted: false,
        direct_match: false, ambiguous: false, needs_clarification: false,
        answer: "Synthetic answer from local records.", answer_kind: "fallback",
        interpretation: "", filters: {}, items: [], quick_results: [], borrowed: [],
        borrowed_total: 0, total: 0, documents: [], locations: [], references: [],
        notices: [], facts: {}, tool: "fallback", ai_status: { configured: false },
        context: { scope_key: "|", resolved_items: [], candidate_items: [], loans: [], dialogue_memory: [] },
        scope_label: "All my places", households: [], property: null,
      } });
    }
    if (["/api/v1/items", "/api/v1/properties", "/api/v1/rooms", "/api/v1/storage-locations", "/api/v1/categories", "/api/v1/tags"].includes(url.pathname)) {
      return route.fulfill({ json: { items: [], total: 0, limit: 24, offset: 0 } });
    }
    return route.fulfill({ status: 404, json: { detail: { message: "No synthetic fixture" } } });
  });
  return errors;
}

for (const width of [390, 1440]) {
  test(`assistant continuity and focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors = await fixture(page);
    await page.goto("/items?sort=name_asc");
    const trigger = width < 1024
      ? page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Assistant" })
      : page.getByRole("button", { name: "Open assistant panel" });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName ?? ""))).toBe(false);
    const input = dialog.getByRole("textbox", { name: "Ask the Housetory assistant" });
    if (width === 390) {
      await page.setViewportSize({ width, height: 520 });
      const bounds = await input.boundingBox();
      expect(bounds).not.toBeNull();
      if (!bounds) throw new Error("Assistant composer is not visible");
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(520);
      await page.setViewportSize({ width, height: 844 });
    }
    await input.fill("Where is my drill?");
    await dialog.getByRole("button", { name: "Send question" }).click();
    await expect(dialog.getByText("Synthetic answer from local records.")).toBeVisible();
    await input.fill("A draft for later");
    await dialog.getByRole("button", { name: "Close assistant" }).click();
    await expect(trigger).toBeFocused();
    expect(new URL(page.url()).searchParams.get("sort")).toBe("name_asc");
    await trigger.click();
    await expect(input).toHaveValue("A draft for later");
    await expect(dialog.getByText("Synthetic answer from local records.")).toBeVisible();
    await dialog.getByRole("link", { name: "Open full page" }).click();
    await expect(page).toHaveURL(/\/assistant/);
    await expect(page.getByRole("textbox", { name: "Ask the Housetory assistant" })).toHaveValue("A draft for later");
    await expect(page.getByText("Synthetic answer from local records.")).toBeVisible();
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Items", exact: true }).click();
    await expect(page).toHaveURL(/\/items/);
    await trigger.click();
    await expect(dialog.getByRole("textbox", { name: "Ask the Housetory assistant" })).toHaveValue("A draft for later");
    await expect(dialog.getByText("Synthetic answer from local records.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });

  test(`selected items become explicit assistant context at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors = await fixture(page);
    const items = ["Synthetic drill", "Synthetic ladder"].map((name, index) => ({
      id: `00000000-0000-0000-0000-00000000001${index}`,
      name, description: null, brand: null, model: null, quantity: 1,
      on_loan_quantity: 0, condition: "good", is_archived: false, room: null,
      location: null, location_path: [], category: null, tags: [], primary_photo: null,
      purchase: null, purchase_info_status: "unrecorded", purchase_info_missing_fields: [],
      warranty: null, current_value_cents: null, current_value_currency: "USD",
      current_value_basis: null, current_value_total_cents: null,
      current_value_estimated_at: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    }));
    await page.route("**/api/v1/items?**", (route) =>
      route.fulfill({ json: { items, total: items.length, limit: 24, offset: 0 } }),
    );
    await page.goto("/items");
    await page.getByRole("checkbox", { name: "Select Synthetic drill" }).check();
    await page.getByRole("checkbox", { name: "Select Synthetic ladder" }).check();
    const trigger = width < 1024
      ? page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Assistant" })
      : page.getByRole("button", { name: "Open assistant panel" });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Current assistant context")).toContainText("Selection: 2 items");
    await dialog.getByText("View", { exact: true }).click();
    await expect(dialog.getByText("Synthetic drill", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Synthetic ladder", { exact: true })).toBeVisible();
    await dialog.getByText("View", { exact: true }).click();
    const request = page.waitForRequest((candidate) =>
      candidate.url().endsWith("/api/v1/search/query") && candidate.method() === "POST",
    );
    await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Where are these?");
    await dialog.getByRole("button", { name: "Send question" }).click();
    expect((await request).postDataJSON().page_context).toEqual(items.map(({ id }) => ({ kind: "item", id })));
    await expect(dialog.getByText("Synthetic answer from local records.")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({
      path: `../../docs/assistant-stage-b-${width === 390 ? "mobile" : "desktop"}.png`,
    });
    await dialog.getByRole("link", { name: "Open full page" }).click();
    await expect(page.getByLabel("Current assistant context")).toContainText("Selection: 2 items");
    await page.getByRole("button", { name: "Clear assistant context" }).click();
    await expect(page.getByLabel("Current assistant context")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
