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
    const destinations = ["Places", "Documents", "Purchases", "Insurance", "Stocktake", "Review", "Settings"];
    if (mobile) {
      // More rolls its choices up over the rooms in the rail.
      const rail = page.getByTestId("room-rail");
      await rail.getByRole("button", { name: "More", exact: true }).click();
      const menu = rail.getByTestId("rail-more");
      await expect(menu.getByRole("link")).toHaveCount(destinations.length);
      for (const [index, name] of destinations.entries()) {
        await expect(menu.getByRole("link").nth(index)).toHaveAttribute("title", name);
      }
      if (shots) await page.screenshot({ path: `${shots}/mobile-more.png` });
      await menu.getByRole("link", { name: "Places" }).click();
    } else {
      const nav = page.locator("aside").getByRole("navigation", { name: "Rooms" });
      await expect(nav.getByRole("link", { name: "Rooms", exact: true })).toHaveCount(0);
      await expect(nav.getByRole("link", { name: "Containers", exact: true })).toHaveCount(0);
      await nav.getByRole("button", { name: "More", exact: true }).click();
      await expect(nav.getByTestId("rail-more").getByRole("link")).toHaveText(destinations);
      await nav.getByTestId("rail-more").getByRole("link", { name: "Places", exact: true }).click();
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
      // A container belongs to Places: More is marked, and Places is the current choice in it.
      const nav = page.locator("aside").getByRole("navigation", { name: "Rooms" });
      await expect(nav.getByRole("button", { name: "More", exact: true })).toHaveClass(/nav-link-active/);
      await nav.getByRole("button", { name: "More", exact: true }).click();
      await expect(nav.getByTestId("rail-more").getByRole("link", { name: "Places", exact: true }))
        .toHaveAttribute("aria-current", "page");
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
    // The name can be corrected from the row: tapping it opens it in the bottom bar.
    const row = review.getByRole("region", { name: "Assistant item review" }).getByRole("article", { name: itemName });
    await expect(row.getByRole("button", { name: `Edit name of ${itemName}` })).toHaveText(itemName);
    // Nothing is selected or added until the person does it.
    await expect(row.getByRole("checkbox", { name: `Select ${itemName}` })).not.toBeChecked();
    await expect(review).toBeInViewport();
    // Earlier conversation history, when present, restores above this new capture.
    await expect(review.locator("xpath=following::*[@aria-label='Assistant tool task']")).toHaveCount(0);
    const batchId = await review.getAttribute("data-capture-id");
    // The review is already on screen, so no separate "ready" toast appears.
    await page.waitForTimeout(2500);
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: /ready for review/i })).toHaveCount(0);
    const listed = async () => (await (await request.get(`/api/v1/items?q=${encodeURIComponent(itemName)}`)).json()).total;
    expect(await listed()).toBe(0);
    // The count of open reviews is checked every 30 seconds while nothing is running.
    await expect.poll(badge, { timeout: 40_000 }).toBe(before + 1);
    if (shots) await page.screenshot({ path: `${shots}/${size}-add-items-inline-review.png` });

    // Unfinished work survives closing the panel and is reachable from the Review queue.
    await panel.getByRole("button", { name: "Close assistant", exact: true }).click();
    await page.goto("/review");
    const title = (await (await request.get(`/api/v1/imports/${batchId}`)).json()).title;
    await page.getByRole("region", { name: "Pending captures" })
      .getByRole("button", { name: `Review ${title}`, exact: true }).first().click();
    const reopened = panel.locator(`[data-capture-id="${batchId}"]`);
    const reopenedRow = reopened.getByRole("article", { name: itemName });
    await expect(reopenedRow.getByRole("button", { name: `Edit name of ${itemName}` })).toHaveText(itemName);
    // Each row has its own explicit Add item button.
    await reopenedRow.getByRole("button", { name: "Add item", exact: true }).click();
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

    // The app opens in the item list; the totals wait in one line at the top of Purchases.
    await page.goto("/");
    await expect(page).toHaveURL(/\/items$/);
    await expect(page.getByRole("heading", { name: "All items", level: 1 })).toBeVisible();
    await expect(page.getByLabel("Sort items")).toHaveValue("recent");
    await page.goto("/purchases");
    await expect(page.getByTestId("purchase-totals").getByRole("button", { name: /^Totals/ }))
      .toHaveAttribute("aria-expanded", "false");
    if (shots) await page.screenshot({ path: `${shots}/${size}-totals.png` });
    await page.keyboard.press("Escape");
    await page.goto("/settings/services");
    await expect(page.getByRole("heading", { name: "Online lookups" })).toBeVisible();
    await expect(page.getByLabel(/Brave Search API key/)).toBeHidden();
    await page.getByRole("heading", { name: "Brave Search connection" }).click();
    await expect(page.getByLabel(/Brave Search API key/)).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/${size}-settings.png`, fullPage: true });

    // Review workspace: re-review options are available but not in the way.
    await page.goto("/review");
    await expect(page.getByRole("button", { name: "Find suggestions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review again", exact: true })).toBeHidden();
    await page.getByText("Review again options", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Review again", exact: true })).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/${size}-review.png`, fullPage: true });

    // Without AI, a typed review request is only searched: reviews start from the Review page.
    await page.goto("/items");
    await page.locator('button[title="Open assistant"]').first().click();
    const offlinePanel = page.getByTestId("assistant-panel");
    await expect(offlinePanel.getByRole("note", { name: "Local search mode" })).toContainText(
      "Typed actions need the AI assistant; use the item's buttons, or set up AI in Settings.",
    );
    const startedReviews: string[] = [];
    page.on("request", (sent) => {
      if (sent.method() === "POST" && new URL(sent.url()).pathname === "/api/v1/inventory-review/runs") {
        startedReviews.push(sent.url());
      }
    });
    const searched = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/search/query" && response.request().method() === "POST");
    await offlinePanel.getByRole("textbox", { name: "Ask the Housetory assistant" })
      .fill("Review my items and suggest categories.");
    await offlinePanel.getByRole("button", { name: "Send question", exact: true }).click();
    expect((await searched).ok()).toBeTruthy();
    await expect(offlinePanel.getByRole("button", { name: "Copy answer" }).last()).toBeVisible();
    await expect(offlinePanel.getByRole("region", { name: "Inventory review", exact: true })).toHaveCount(0);
    await expect(offlinePanel.getByLabel("Action review")).toHaveCount(0);
    expect(startedReviews).toEqual([]);
    if (shots) await page.screenshot({ path: `${shots}/${size}-local-search-mode.png` });
    await offlinePanel.getByRole("button", { name: "Close assistant", exact: true }).click();

    await page.goto("/imports");
    await expect(page.getByRole("textbox", { name: /Notes/ })).not.toHaveAttribute("placeholder", /\\n/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

for (const mobile of [false, true]) {
  const size = mobile ? "mobile" : "desktop";
  test(`${size}: every prepared action stays counted and reopens without its conversation`, async ({ page, request }) => {
    const database = process.env.SIMPLIFY_E2E_DATABASE;
    test.skip(!database, "Needs the disposable database name to age a proposal");
    expect(database).toMatch(/^housetory_[a-z0-9_]+$/);
    await page.setViewportSize(mobile ? { width: 375, height: 812 } : { width: 1440, height: 1000 });
    const suffix = crypto.randomUUID().slice(0, 6);
    const household = (await (await request.get("/api/v1/auth/session")).json()).household.id;
    const pendingTotal = async () => (await (await request.get(
      `/api/v1/assistant/actions/proposals/pending?household_id=${household}&limit=1`,
    )).json()).total as number;
    // Clear leftovers so the counts below are exact.
    for (;;) {
      const { items } = await (await request.get(
        `/api/v1/assistant/actions/proposals/pending?household_id=${household}&limit=100`,
      )).json();
      if (!items.length) break;
      for (const entry of items) await request.post(`/api/v1/assistant/actions/proposals/${entry.id}/cancel`);
    }
    const create = async (name: string) =>
      (await (await request.post("/api/v1/items", { data: { name, quantity: 1 } })).json()).item;
    const prepare = async (item: { id: string }, name: string) => {
      const response = await request.post("/api/v1/assistant/actions/proposals", {
        data: { kind: "edit_item", item_id: item.id, changes: { name } },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      return (await response.json()).id as string;
    };
    const lamp = await create(`Old lamp ${suffix}`);
    const drill = await create(`Bulk drill ${suffix}`);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/review");
    const badge = async () => Number(/(\d+) unresolved/.exec(
      await page.locator('button[title="Open assistant"]').first().getAttribute("aria-label") ?? "",
    )?.[1] ?? 0);
    await page.waitForLoadState("networkidle");
    const before = await badge();

    // One action prepared a month ago with no assistant conversation at all, then 22 newer ones.
    const oldId = await prepare(lamp, `Reading lamp ${suffix}`);
    const { execFileSync } = await import("node:child_process");
    execFileSync("psql", ["-h", "127.0.0.1", "-d", database!, "-v", "ON_ERROR_STOP=1", "-c",
      `UPDATE assistant_action_proposals SET created_at = now() - interval '30 days' WHERE id = '${oldId}'`]);
    for (let index = 0; index < 22; index += 1) await prepare(drill, `Bulk drill ${suffix} v${index}`);
    expect(await pendingTotal()).toBe(23);

    const queue = page.getByRole("region", { name: "Prepared actions" });
    // The open page finds actions prepared elsewhere on its next check, every 30 seconds.
    await expect(queue.getByRole("heading")).toHaveText("Prepared actions · 23", { timeout: 40_000 });
    await expect.poll(badge).toBe(before + 23);
    await expect(queue.getByText("1–20 of 23")).toBeVisible();
    const oldTitle = `Review Edit: Old lamp ${suffix}`;
    await expect(queue.getByRole("button", { name: oldTitle, exact: true })).toHaveCount(0);
    await queue.getByRole("button", { name: "Next actions" }).click();
    await expect(queue.getByText("21–23 of 23")).toBeVisible();
    // Smooth scrolling settles shortly after paging; the list must end up in view.
    await page.waitForTimeout(800);
    await expect(queue.getByRole("heading")).toBeInViewport();
    if (shots) await page.screenshot({ path: `${shots}/${size}-prepared-actions-page-2.png` });

    // Reopen the month-old action: it is not in any restored conversation.
    expect((await (await request.get("/api/v1/assistant/runs")).json())
      .some((run: { steps: unknown[] }) => JSON.stringify(run.steps).includes(oldId))).toBe(false);
    await queue.getByRole("button", { name: oldTitle, exact: true }).click();
    const panel = page.getByTestId("assistant-panel");
    const card = panel.locator(`[data-capture-id="${oldId}"]`);
    await expect(card).toBeInViewport();
    await expect(card).toContainText(`Reading lamp ${suffix}`);
    const nameOf = async (id: string) => (await (await request.get(`/api/v1/items/${id}`)).json()).item.name;
    expect(await nameOf(lamp.id)).toBe(`Old lamp ${suffix}`);
    if (shots) await page.screenshot({ path: `${shots}/${size}-reopened-old-action.png` });
    await card.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(() => nameOf(lamp.id)).toBe(`Reading lamp ${suffix}`);
    await expect.poll(badge).toBe(before + 22);
    await panel.getByRole("button", { name: "Close assistant", exact: true }).click();
    await expect(queue.getByRole("heading")).toHaveText("Prepared actions · 22");
    await expect(queue.getByText("21–22 of 22")).toBeVisible();

    // Apply one drill rename; the others are now stale but stay counted until handled.
    const applyFirst = async () => {
      await queue.getByRole("button", { name: /^Review Edit: Bulk drill/ }).first().click();
      const open = panel.getByLabel("Action review").last();
      await expect(open).toBeInViewport();
      return open;
    };
    let open = await applyFirst();
    await open.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(() => nameOf(drill.id)).toMatch(/ v\d+$/);
    const renamed = await nameOf(drill.id);
    await panel.getByRole("button", { name: "Close assistant", exact: true }).click();
    await expect(queue.getByRole("heading")).toHaveText("Prepared actions · 21");
    open = await applyFirst();
    await open.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(open.getByRole("alert")).toContainText("Refresh the proposal");
    expect(await nameOf(drill.id)).toBe(renamed);
    expect(await pendingTotal()).toBe(21);
    await open.getByRole("button", { name: "Refresh proposal" }).click();
    await expect(open.getByRole("alert")).toHaveCount(0);
    expect(await pendingTotal()).toBe(21);
    await open.getByRole("button", { name: "Cancel proposal", exact: true }).click();
    await expect.poll(pendingTotal).toBe(20);
    await panel.getByRole("button", { name: "Close assistant", exact: true }).click();

    // Cancel from the list, then reload: the count is the server's, not a page length.
    await queue.getByRole("button", { name: /^Cancel Edit: Bulk drill/ }).first().click();
    await expect(queue.getByRole("heading")).toHaveText("Prepared actions · 19");
    await page.reload();
    await expect(queue.getByRole("heading")).toHaveText("Prepared actions · 19");
    await expect.poll(badge).toBe(before + 19);
    await expect(queue.getByRole("button", { name: "Next actions" })).toHaveCount(0);
    expect(await nameOf(drill.id)).toBe(renamed);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
