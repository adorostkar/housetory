import { expect, test } from "@playwright/test";

// Runs without any AI provider: these journeys are the offline core.
test.skip(!process.env.TOOLS_E2E_ISOLATED, "Requires a disposable API/database and a real worker");

const shots = process.env.SIMPLIFY_SHOTS_DIR;

for (const mobile of [false, true]) {
  const size = mobile ? "mobile" : "desktop";
  test(`${size}: Places, one capture review and trimmed screens work offline`, async ({ page, request }) => {
    await page.setViewportSize(mobile ? { width: 375, height: 812 } : { width: 1440, height: 1000 });
    const suffix = crypto.randomUUID().slice(0, 6);
    const room = await (await request.post("/api/v1/rooms", { data: { name: `Simplify room ${suffix}` } })).json();
    const box = await (await request.post("/api/v1/containers", {
      data: { room_id: room.id, container_type: "box", name: `Simplify box ${suffix}` },
    })).json();
    // Start from an empty queue so the single capture below is unambiguous.
    expect(new URL(process.env.E2E_BASE_URL!).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
    for (const stale of await (await request.get("/api/v1/inventory-review/captures")).json()) {
      await request.post(`/api/v1/inventory-review/captures/${stale.kind}/${stale.id}/dismiss`, {
        data: { generation: stale.generation },
      });
    }
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    // Places: rooms first, containers one tab away, both under one navigation entry.
    await page.goto("/");
    if (mobile) {
      await page.getByRole("button", { name: "More destinations" }).click();
      const menu = page.getByTestId("mobile-more-menu");
      await expect(menu.getByRole("menuitem")).toHaveText(["Places", "Documents", "Financials", "Review", "Settings"]);
      if (shots) await page.screenshot({ path: `${shots}/mobile-more.png` });
      await menu.getByRole("menuitem", { name: "Places" }).click();
    } else {
      const aside = page.locator("aside");
      await expect(aside.getByRole("link", { name: "Rooms", exact: true })).toHaveCount(0);
      await expect(aside.getByRole("link", { name: "Containers", exact: true })).toHaveCount(0);
      await aside.getByRole("link", { name: "Places", exact: true }).click();
    }
    await expect(page).toHaveURL(/\/rooms$/);
    const tabs = page.getByRole("navigation", { name: "Places" });
    await expect(page.getByRole("heading", { name: "Rooms", level: 1 })).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/${size}-places-rooms.png` });
    await tabs.getByRole("link", { name: "Containers", exact: true }).click();
    await expect(page).toHaveURL(/\/containers$/);
    await expect(page.getByRole("heading", { name: "Containers", level: 1 })).toBeVisible();
    const search = page.getByRole("textbox", { name: "Search containers" });
    expect((await search.boundingBox())!.width).toBeGreaterThanOrEqual(200);
    await search.fill(`Simplify box ${suffix}`);
    await expect(page.locator(`a[href="/labels?ids=${box.id}"]`)).toBeVisible();
    await expect(page.getByRole("link", { name: "Label", exact: true })).toHaveCount(1);
    await expect(page.locator("main").getByText(box.identifier, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "QR", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Move", exact: true })).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/${size}-places-containers.png` });
    await page.goto(`/containers/${box.id}`);
    await expect(page.getByRole("heading", { name: box.identifier, level: 1 })).toBeVisible();
    if (!mobile) {
      await expect(page.locator("aside").getByRole("link", { name: "Places", exact: true }))
        .toHaveClass(/nav-link-active/);
    }

    // Old photo-capture URLs open Add items with their place context.
    await page.goto(`/scan?room_id=${room.id}&location_id=${box.id}`);
    let dialog = page.getByRole("dialog", { name: "Add items" });
    await expect(dialog.getByRole("button", { name: new RegExp(`Place: ${room.name} · ${box.identifier}`) })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto("/recognize");
    await expect(page.getByRole("dialog", { name: "Add items" })).toBeVisible();
    await page.keyboard.press("Escape");

    // Add items: typed capture is reviewed inline in the assistant panel, with explicit approval.
    const itemName = `Simplify lantern ${suffix}`;
    await page.goto(`/rooms/${room.id}`);
    const badge = async () => Number(/(\d+) unresolved/.exec(
      await page.locator('button[title="Open assistant"]').first().getAttribute("aria-label") ?? "",
    )?.[1] ?? 0);
    await page.waitForLoadState("networkidle");
    const before = await badge();
    await page.locator("main").getByRole("button", { name: "Add items" }).first().click();
    dialog = page.getByRole("dialog", { name: "Add items" });
    await dialog.getByRole("textbox", { name: "Describe items or paste a product link" }).fill(`- ${itemName}`);
    await dialog.getByRole("button", { name: "Review items" }).click();
    await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}#assistant$`));
    await expect(dialog).toHaveCount(0);
    const panel = page.getByTestId("assistant-panel");
    const review = panel.getByLabel("Assistant capture status").last();
    await expect(review.getByRole("region", { name: "Assistant item review" })).toContainText(itemName);
    await expect(review).toBeInViewport();
    // Earlier conversation history, when present, restores above this new capture.
    await expect(review.locator("xpath=following::*[@aria-label='Assistant tool task']")).toHaveCount(0);
    const batchId = await review.getAttribute("data-capture-id");
    // The review is already on screen, so no separate "ready" toast appears.
    await page.waitForTimeout(2500);
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: /ready for review/i })).toHaveCount(0);
    const listed = async () => (await (await request.get(`/api/v1/items?q=${encodeURIComponent(itemName)}`)).json()).total;
    expect(await listed()).toBe(0);
    await expect.poll(badge).toBe(before + 1);
    if (shots) await page.screenshot({ path: `${shots}/${size}-add-items-inline-review.png` });

    // Unfinished work survives closing the panel and is reachable from the Review queue.
    await panel.getByRole("button", { name: "Close assistant", exact: true }).click();
    await page.goto("/review");
    const title = (await (await request.get(`/api/v1/imports/${batchId}`)).json()).title;
    await page.getByRole("region", { name: "Pending captures" })
      .getByRole("button", { name: `Review ${title}`, exact: true }).first().click();
    const reopened = panel.locator(`[data-capture-id="${batchId}"]`);
    await expect(reopened).toContainText(itemName);
    await reopened.getByRole("button", { name: /^Approve/ }).last().click();
    await expect.poll(listed).toBe(1);
    await expect.poll(badge).toBe(before);
    const saved = (await (await request.get(`/api/v1/items?q=${encodeURIComponent(itemName)}`)).json()).items[0];
    expect(saved.room.id).toBe(room.id);
    await panel.getByRole("button", { name: "Close assistant", exact: true }).click();

    // Header search: local matches, one assistant row, Enter filters without AI.
    await page.goto("/");
    const header = page.getByRole("combobox", { name: "Search or ask about your inventory" });
    await header.fill(itemName);
    const results = page.getByRole("listbox", { name: "Quick search results" });
    await expect(results.getByText(itemName).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Ask Housetory" })).toHaveCount(0);
    await expect(results.getByText(/^Ask the assistant:/)).toHaveCount(1);
    await results.getByText(itemName).first().click();
    await expect(page).toHaveURL(new RegExp(`/items/${saved.id}`));
    await expect(page.getByRole("heading", { name: itemName, level: 1 })).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/${size}-item.png`, fullPage: true });

    // Overview keeps occasional tasks in one menu; Settings keeps setup detail collapsed.
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Create insurance list" })).toHaveCount(0);
    await page.getByRole("button", { name: "Home actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Create insurance list" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Export evidence" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "New room" })).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/${size}-overview.png` });
    await page.keyboard.press("Escape");
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Online search" })).toBeVisible();
    await expect(page.getByLabel(/Brave Search API key/)).toBeHidden();
    await page.getByText("Online search settings", { exact: true }).click();
    await expect(page.getByLabel(/Brave Search API key/)).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/${size}-settings.png`, fullPage: true });

    // Review workspace: re-review options are available but not in the way.
    await page.goto("/review");
    await expect(page.getByRole("button", { name: "Find suggestions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review again", exact: true })).toBeHidden();
    await page.getByText("Review again options", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Review again", exact: true })).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/${size}-review.png`, fullPage: true });

    await page.goto("/imports");
    await expect(page.getByRole("textbox", { name: /Notes/ })).not.toHaveAttribute("placeholder", /\\n/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
