import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";

test.skip(!process.env.TOOLS_E2E_ISOLATED, "Requires a disposable API/database and a real worker");

let server: Server;
let providerId = "";
let itemId = "";
let itemName = "";
let loanId = "";
let reviewItemIds: string[] = [];
let holdNext = false;
let release: (() => void) | undefined;
const contexts: { request: string; parents: unknown[] }[] = [];

test.beforeAll(async ({ request }) => {
  expect(new URL(process.env.E2E_BASE_URL!).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/tags") {
      res.end(JSON.stringify({ models: [{ name: "tool-browser-test" }] }));
      return;
    }
    if (req.url !== "/api/chat") { res.writeHead(404).end("{}"); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const prompt = body.messages.at(-1).content as string;
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((resolve) => { release = resolve; });
      release = undefined;
    }
    let output: unknown;
    if (prompt.includes('"step_schema"')) {
      const input = JSON.parse(prompt);
      contexts.push({ request: input.request, parents: input.context_newest_first });
      const observed = input.observations.length;
      const tool = (name: string, args: object) => ({ kind: "tool", call: { name, arguments: args } });
      if (input.request.includes("categorise")) {
        output = observed === 0
          ? tool("start_inventory_review", { scope_type: "items", item_ids: reviewItemIds })
          : { kind: "answer", message: "", prepared_note: "The review is partial and paused with zero items scanned." };
      } else if (input.request === "Who borrowed it?" || input.request === "How long have they had it?") {
        output = observed === 0 ? tool("get_item_history", { item_id: itemId })
          : { kind: "answer", message: input.request === "Who borrowed it?"
            ? "**Mohsen** borrowed one drill." : "Mohsen has had it for **3 days**." };
      } else if (input.request === "How long have they had it? Prepare a return for today.") {
        output = observed === 0 ? tool("get_item_history", { item_id: itemId })
          : observed === 1 ? tool("prepare_action", { action: {
            kind: "return_loan", loan_id: loanId, quantity: 1,
            returned_on: new Date().toISOString().slice(0, 10),
          } })
          : { kind: "answer",
            message: `Mohsen has had it for **3 days** (loan_id: ${loanId}).\n\nI can't notify Mohsen from here.`,
            prepared_note: "A very long duplicated return proposal with internal schema fields." };
      } else if (input.request.includes("Rename")) {
        output = observed === 0 ? tool("get_item_details", { item_id: itemId })
          : observed === 1 ? tool("prepare_action", { action: {
            kind: "edit_item", item_id: itemId, changes: { name: `Renamed ${itemName}` },
          } })
          : { kind: "answer", message: "The rename is ready for your approval." };
      } else {
        output = observed === 0 ? tool("search_items", { q: itemName })
          : observed === 1 ? tool("get_item_details", { item_id: itemId })
          : { kind: "answer", message: `The **verified drill** is in Browser Storage.\n\n- Quantity: 2.\n\nitem_id: ${itemId}\nGET /api/v1/items/${itemId}` };
      }
    } else {
      const items = JSON.parse(prompt.split("Items: ")[1].split("\nReturn ")[0]);
      output = { suggestions: items.map((item: { index: number }) => ({
        index: item.index, tags: [{ name: "tools" }], confidence: "high",
        reason: "Synthetic provider organization proposal",
      })) };
    }
    res.end(JSON.stringify({ message: { role: "assistant", content: JSON.stringify(output) } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing provider port");
  const provider = await request.post("/api/v1/ai/providers", { data: {
    provider: "ollama", display_name: "Synthetic tool browser provider",
    base_url: `http://127.0.0.1:${address.port}`, default_model: "tool-browser-test", enabled: true,
  } });
  expect(provider.ok(), await provider.text()).toBeTruthy();
  providerId = (await provider.json()).id;
  const task = await request.put("/api/v1/ai/tasks/assistant", { data: {
    provider_id: providerId, model: "tool-browser-test", enabled: true,
  } });
  expect(task.ok(), await task.text()).toBeTruthy();
});

test.afterEach(() => { holdNext = false; release?.(); });
test.afterAll(async ({ request }) => {
  release?.();
  if (providerId) await request.delete(`/api/v1/ai/providers/${providerId}`);
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function ask(page: Page, text: string, header = false) {
  const input = header
    ? page.getByRole("combobox", { name: "Search or ask about your inventory" })
    : page.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await input.fill(text);
  if (header) await input.press("Enter");
  else {
    const send = page.getByRole("button", { name: "Send question", exact: true });
    await expect(send).toBeEnabled();
    await send.click();
  }
}

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"} shared tools, editable approval and background review survive reload`, async ({ page, request }) => {
    await page.setViewportSize(mobile ? { width: 375, height: 812 } : { width: 1440, height: 1000 });
    const roomResponse = await request.post("/api/v1/rooms", { data: { name: "Browser Storage" } });
    const room = await roomResponse.json();
    itemName = `Tool browser drill ${crypto.randomUUID().slice(0, 7)}`;
    const itemResponse = await request.post("/api/v1/items", { data: {
      name: itemName, quantity: 2, room_id: room.id,
    } });
    expect(itemResponse.ok()).toBeTruthy();
    itemId = (await itemResponse.json()).item.id;
    const loan = await request.post("/api/v1/loans", { data: {
      item_id: itemId, borrower_name: "Mohsen", quantity: 1,
      lent_on: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10),
      request_id: crypto.randomUUID(),
    } });
    expect(loan.ok(), await loan.text()).toBeTruthy();
    loanId = (await loan.json()).id;
    const earlierItem = await request.post("/api/v1/items", { data: {
      name: `Earlier reviewed ${itemName}`, room_id: room.id,
    } });
    const earlierItemId = (await earlierItem.json()).item.id;
    reviewItemIds = [itemId, earlierItemId];
    const earlierRunResponse = await request.post("/api/v1/inventory-review/runs", { data: {
      scope_type: "items", item_ids: [earlierItemId], include_ai: true, request_id: crypto.randomUUID(),
    } });
    expect(earlierRunResponse.ok(), await earlierRunResponse.text()).toBeTruthy();
    const earlierRun = await earlierRunResponse.json();
    const earlierBatch = await request.post(`/api/v1/inventory-review/runs/${earlierRun.id}/continue`, {
      data: { version: earlierRun.batch_version },
    });
    expect(earlierBatch.ok(), await earlierBatch.text()).toBeTruthy();
    const legacy: string[] = [];
    page.on("request", (req) => {
      if (/\/assistant\/actions\/intent|\/assistant\/actions\/interpret|\/search\/query/.test(req.url())) legacy.push(req.url());
    });
    await page.goto("/items");
    const question = `Where is my ${itemName}?`;
    await ask(page, question, true);
    await expect(page.getByText(question, { exact: true })).toBeVisible();
    const answer = page.getByLabel("Assistant tool task").last();
    await expect(answer.locator("strong", { hasText: "verified drill" })).toBeVisible();
    await expect(answer.getByTestId("answer-text")).toContainText("Quantity: 2");
    await expect(answer.getByTestId("answer-text")).not.toContainText(itemId);
    await expect(answer.getByTestId("answer-text")).not.toContainText("/api/");
    await expect(page.getByRole("heading", { name: "Assistant", exact: true })).toHaveCount(1);
    await expect(page.getByText("Pending captures", { exact: true })).toBeHidden();
    const scopeBox = await page.getByRole("combobox", { name: "Search scope", exact: true }).boundingBox();
    const newChatBox = await page.getByRole("button", { name: "New conversation", exact: true }).boundingBox();
    expect(scopeBox!.x + scopeBox!.width).toBeLessThanOrEqual(newChatBox!.x);
    await ask(page, "Who borrowed it?");
    await expect(page.getByLabel("Assistant tool task").last().getByTestId("answer-text"))
      .toHaveText("Mohsen borrowed one drill.");
    await ask(page, "How long have they had it? Prepare a return for today.");
    const returnAction = page.getByLabel("Action review").filter({ hasText: itemName }).last();
    await expect(returnAction.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
    const mixedAnswer = page.getByLabel("Assistant answer").last();
    await expect(mixedAnswer.getByTestId("answer-text"))
      .toHaveText("Mohsen has had it for 3 days.I can't notify Mohsen from here.");
    await expect(mixedAnswer.locator("strong")).toHaveText("3 days");
    await expect(mixedAnswer).toBeInViewport();
    expect((await mixedAnswer.boundingBox())!.y).toBeLessThan((await returnAction.boundingBox())!.y);
    await expect(page.getByLabel("Follow-up questions")).toHaveCount(0);
    await expect(returnAction.getByRole("link", { name: `${itemName} · Mohsen`, exact: true }))
      .toHaveAttribute("href", new RegExp(`/loans/${loanId}(\\?|$)`));
    expect((await (await request.get(`/api/v1/loans/${loanId}`)).json()).returned_quantity).toBe(0);
    expect(contexts.filter((entry) => entry.request.startsWith("How long have they had it?")).at(-1)?.parents.length).toBeGreaterThan(0);
    await expect(page.getByText("A very long duplicated return proposal with internal schema fields.", { exact: false }).last()).toBeHidden();
    await page.screenshot({ path: test.info().outputPath(`return-proposal-${mobile ? "mobile" : "desktop"}.png`) });
    await page.reload();
    await expect(page.getByLabel("Assistant answer").last().locator("strong")).toHaveText("3 days");
    await returnAction.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(async () => (await (await request.get(`/api/v1/loans/${loanId}`)).json()).returned_quantity).toBe(1);
    await ask(page, "Rename it please");
    const action = page.getByLabel("Action review").filter({ hasText: itemName }).last();
    await expect(action.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
    expect((await (await request.get(`/api/v1/items/${itemId}`)).json()).item.name).toBe(itemName);
    expect(contexts.filter((entry) => entry.request === "Rename it please").at(-1)?.parents.length).toBeGreaterThan(0);
    await action.getByRole("button", { name: "Edit change", exact: true }).click();
    await action.getByLabel("New name", { exact: true }).fill(`Approved ${itemName}`);
    await action.getByRole("button", { name: "Save change", exact: true }).click();
    await action.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(async () => (await (await request.get(`/api/v1/items/${itemId}`)).json()).item.name).toBe(`Approved ${itemName}`);
    await page.reload();
    await expect(page.getByText("Already applied.").last()).toBeVisible();

    await ask(page, "Do a review and categorise the items.");
    const workspace = page.getByRole("region", { name: "Inventory review", exact: true }).last();
    await expect(workspace.getByRole("status")).toContainText("Reviewed 2 of 2 items locally");
    await expect(workspace.getByRole("status")).toContainText("Review complete");
    await expect(page.getByText("The review is partial and paused with zero items scanned.", { exact: true }).last()).toBeHidden();
    await expect(workspace.getByRole("combobox", { name: "Review scope type" })).toBeHidden();
    await expect(page.getByLabel("Assistant tool task").last()).toHaveAttribute("data-state", "awaiting_approval");
    await workspace.getByRole("checkbox", { name: /Include AI suggestions/ }).check();
    holdNext = true;
    await workspace.getByRole("button", { name: "Review with AI", exact: true }).click();
    await page.getByRole("button", { name: "Run review with AI", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Include AI suggestions?" })).toBeHidden();
    await expect.poll(() => Boolean(release)).toBe(true);
    await workspace.getByRole("button", { name: "Cancel review", exact: true }).click();
    await expect(workspace.getByRole("status")).toContainText("Review stopped");
    release!();
    holdNext = true;
    await workspace.getByRole("button", { name: "Resume review", exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.getByRole("button", { name: "Close assistant", exact: true }).click();
    await page.goto("/items#assistant");
    await page.reload();
    release!();
    expect((await (await request.get(`/api/v1/items/${itemId}`)).json()).item.tags).toEqual([]);
    const suggestion = page.locator("li").filter({
      hasText: "Synthetic provider organization proposal",
    }).filter({ hasText: `Approved ${itemName}` }).last();
    await expect(suggestion).toBeVisible();
    await expect(workspace.getByRole("status")).toContainText("1 new suggestion · 1 already pending");
    await expect(suggestion.getByText("New this review", { exact: true })).toBeVisible();
    await expect(page.locator("li").filter({ hasText: `Earlier reviewed ${itemName}` })
      .getByText("Already pending", { exact: true })).toBeVisible();
    await suggestion.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`review-proposals-${mobile ? "mobile" : "desktop"}.png`) });
    await suggestion.getByRole("button", { name: "Accept organisation", exact: true }).click();
    await expect.poll(async () => (await (await request.get(`/api/v1/items/${itemId}`)).json()).item.tags.map((tag: { name: string }) => tag.name)).toEqual(["tools"]);
    expect(legacy).toEqual([]);
    if (mobile) {
      const box = await page.getByRole("button", { name: "Send question", exact: true }).boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath(`tool-assistant-${mobile ? "mobile" : "desktop"}.png`) });
  });
}

test("active cancellation, late response fencing and explicit retry through the real worker", async ({ page, request }) => {
  holdNext = true;
  await page.goto("/items");
  await ask(page, "Where is my slow drill?", true);
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole("button", { name: "Stop assistant", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Retry assistant", exact: true }).last()).toBeVisible();
  release!();
  await page.reload();
  await page.getByRole("button", { name: "Retry assistant", exact: true }).last().click();
  await expect(page.getByLabel("Assistant tool task").last()).toHaveAttribute("data-state", "completed");
  const runs = await (await request.get("/api/v1/assistant/runs")).json();
  const latest = runs.at(-1);
  expect(latest.query).toBe("Where is my slow drill?");
  expect(latest.state).toBe("completed");
  expect(latest.generation).toBeGreaterThan(1);
});

test("the Review queue opens exact older captures inline and preserves a parked composer", async ({ page, request }) => {
  const disabled = await request.put("/api/v1/ai/tasks/imports", { data: {
    provider_id: null, model: null, enabled: false,
  } });
  expect(disabled.ok(), await disabled.text()).toBeTruthy();
  const captures: { id: string; title: string }[] = [];
  for (const label of ["Alpha", "Beta"]) {
    const title = `Inline ${label} ${crypto.randomUUID().slice(0, 6)}`;
    const created = await request.post("/api/v1/imports", { multipart: {
      title, file: { name: `${label}.csv`, mimeType: "text/csv",
        buffer: Buffer.from(`name,quantity\n${title} widget,1\n`) },
    } });
    expect(created.ok(), await created.text()).toBeTruthy();
    const capture = await created.json();
    captures.push({ id: capture.id, title });
    await expect.poll(async () => (await (await request.get(`/api/v1/imports/${capture.id}`)).json()).status)
      .toBe("review");
    expect((await (await request.get(`/api/v1/imports/${capture.id}`)).json()).entries.length).toBeGreaterThan(0);
  }
  await page.goto("/review");
  const panel = page.getByRole("dialog", { name: "Assistant", exact: true });
  for (const [index, capture] of [captures[0], captures[1], captures[0]].entries()) {
    await page.getByRole("button", { name: `Review ${capture.title}`, exact: true }).click();
    const inline = panel.locator(`[data-capture-id="${capture.id}"]`);
    await expect(inline.getByRole("region", { name: "Assistant item review", exact: true })).toBeVisible();
    await expect(inline).toBeInViewport();
    await expect(panel.getByRole("region", { name: "Pending captures", exact: true })).toHaveCount(0);
    const composer = panel.getByRole("textbox", { name: "Ask the Housetory assistant" });
    if (index === 0) {
      await composer.fill("Keep this unsent draft");
      await panel.locator('input[type="file"]').setInputFiles({
        name: "parked.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 synthetic unsent"),
      });
    }
    await expect(composer).toHaveValue("Keep this unsent draft");
    await expect(panel.getByText("parked.pdf", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Close assistant", exact: true }).click();
  }
});
