import { expect, test, type Page } from "@playwright/test";

const household = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "Synthetic household",
  default_currency: "USD",
  warranty_reminder_days: 30,
};

interface ToolRequest {
  query: string;
  household_id?: string;
  property_id?: string;
  parent_id?: string;
  local_date: string;
  page_context: { kind: string; id: string }[];
}

type ToolOutcome = { proposal: { id: string; kind: string } } | { answer: string };

/** No Assistant model is configured: typed text can only be searched. */
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
    if (url.pathname === "/api/v1/assistant/runs") {
      if (route.request().method() === "GET") return route.fulfill({ json: [] });
      return route.fulfill({ status: 409, json: { detail: {
        code: "assistant_tools_unavailable", message: "Configure AI before retrying.",
      } } });
    }
    if (url.pathname === "/api/v1/assistant/actions/proposals/pending") {
      return route.fulfill({ json: { items: [], total: 0 } });
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

/** Configures an Assistant model whose tool engine answers every typed request with `respond`. */
async function assistantModel(page: Page, respond: (request: ToolRequest) => ToolOutcome | Promise<ToolOutcome>) {
  await page.route("**/api/v1/ai/status**", (route) => route.fulfill({ json: {
    configured: true, available: true, data_leaves_server: false, privacy_note: "Synthetic AI",
  } }));
  await page.route("**/api/v1/assistant/runs", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const request = route.request().postDataJSON() as ToolRequest;
    const outcome = await respond(request);
    const proposal = "proposal" in outcome ? outcome.proposal : null;
    const answer = "answer" in outcome ? outcome.answer : "";
    return route.fulfill({ json: {
      id: crypto.randomUUID(), parent_id: request.parent_id ?? null,
      household_id: request.household_id ?? household.id, property_id: request.property_id ?? null,
      query: request.query, state: proposal ? "awaiting_approval" : "completed", generation: 1,
      message: proposal ? "The change is ready for your approval." : answer, answer,
      steps: proposal ? [{
        call: { name: "prepare_action", arguments: {} },
        result: { summary: "Proposal prepared.", references: [], proposal },
      }] : [],
      model_calls: proposal ? 2 : 1, max_model_calls: 8, can_retry: false, worker_available: true,
    } });
  });
}

const launcher = (page: Page) => page.getByRole("button", { name: /^Open assistant/ });

async function openAssistant(page: Page) {
  await launcher(page).click();
  return page.getByRole("dialog", { name: "Assistant" });
}

/** Typed requests that reach the assistant or the search, and anything touching action proposals. */
function trackTypedRequests(page: Page) {
  const typed: string[] = [];
  const actions: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === "POST" && ["/api/v1/assistant/runs", "/api/v1/search/query"].includes(pathname)) {
      typed.push(pathname);
    }
    // The shell always reads the pending list for its badge; that read prepares nothing.
    if (pathname.startsWith("/api/v1/assistant/actions/") && !(
      request.method() === "GET" && pathname === "/api/v1/assistant/actions/proposals/pending"
    )) actions.push(`${request.method()} ${pathname}`);
  });
  return { typed, actions };
}

test("without an assistant model a typed action is only searched in local search mode", async ({ page }) => {
  await fixture(page);
  const { typed, actions } = trackTypedRequests(page);
  await page.goto("/items");
  const dialog = await openAssistant(page);
  const note = dialog.getByRole("note", { name: "Local search mode" });
  await expect(note).toHaveText(
    "Local search mode. Typed actions need the AI assistant; use the item's buttons, or set up AI in Settings.",
  );
  await expect(note.getByRole("link", { name: "set up AI in Settings" })).toHaveAttribute("href", "/settings/ai");
  expect(typed).toEqual([]);
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move the drill to the garage");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Synthetic answer from local records.")).toBeVisible();
  await expect(dialog.getByLabel("Action review")).toHaveCount(0);
  await expect(note).toBeVisible();
  expect(typed).toEqual(["/api/v1/assistant/runs", "/api/v1/search/query"]);
  expect(actions).toEqual([]);
});

test("with an assistant model a typed action goes only to the tool engine and opens its review card", async ({ page }) => {
  await fixture(page);
  await assistantModel(page, () => ({ proposal: {
    id: "00000000-0000-0000-0000-000000000099", kind: "move_items", state: "ready",
    scope_label: "Synthetic household",
    targets: [{ id: "00000000-0000-0000-0000-000000000010", name: "Drill" }],
    destination: { id: "00000000-0000-0000-0000-000000000011", name: "Garage" },
    changes: {}, before: {},
  } }));
  const { typed, actions } = trackTypedRequests(page);
  await page.goto("/items");
  const configured = page.waitForResponse((response) => response.url().includes("/api/v1/ai/status?task=assistant"));
  const dialog = await openAssistant(page);
  await configured;
  const note = dialog.getByRole("note", { name: "Local search mode" });
  await expect(dialog.getByRole("textbox", { name: "Ask the Housetory assistant" })).toBeVisible();
  await expect(note).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move the drill to the garage");
  await dialog.getByRole("button", { name: "Send question" }).click();
  const review = dialog.getByLabel("Action review");
  await expect(review.getByText("Drill", { exact: true })).toBeVisible();
  await expect(review.getByText("Garage", { exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Apply" })).toBeEnabled();
  await expect(note).toHaveCount(0);
  expect(typed).toEqual(["/api/v1/assistant/runs"]);
  expect(actions).toEqual([]);
});

test("reviewed assistant move remains pending until explicitly applied", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 844 });
  await fixture(page);
  let applied = 0;
  await assistantModel(page, () => ({ proposal: {
    id: "00000000-0000-0000-0000-000000000099", kind: "move_items", state: "ready",
    scope_label: "Synthetic household · Home",
    targets: [{ id: "00000000-0000-0000-0000-000000000010", name: "Synthetic drill" }],
    destination: { id: "00000000-0000-0000-0000-000000000011", name: "Kitchen" },
    changes: { room_id: "00000000-0000-0000-0000-000000000011" }, before: {},
  } }));
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) => {
    applied += 1;
    return route.fulfill({ json: {
      proposal_id: "00000000-0000-0000-0000-000000000099",
      request_id: route.request().postDataJSON().request_id, message: "Moved 1 item(s).",
    } });
  });
  await page.goto("/items");
  const dialog = await openAssistant(page);
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move Synthetic drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review the destination, then Apply to move these items.")).toBeVisible();
  await expect(dialog.getByText("Scope: Synthetic household · Home")).toBeVisible();
  await expect(dialog.getByText("Synthetic drill", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Kitchen", { exact: true })).toBeVisible();
  expect(applied).toBe(0);
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog.getByText("Moved 1 item(s).")).toBeVisible();
  expect(applied).toBe(1);
});

test("pending apply cannot be discarded by starting a new conversation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 844 });
  await fixture(page);
  const proposal = {
    id: "00000000-0000-0000-0000-000000000099", kind: "move_items", state: "ready",
    scope_label: "Synthetic household",
    targets: [{ id: "00000000-0000-0000-0000-000000000010", name: "Drill" }],
    destination: { id: "00000000-0000-0000-0000-000000000011", name: "Kitchen" },
    changes: {}, before: {},
  };
  await assistantModel(page, () => ({ proposal }));
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", async (route) => {
    await wait;
    await route.fulfill({ json: { proposal_id: proposal.id, request_id: route.request().postDataJSON().request_id, message: "Moved 1 item(s)." } });
  });
  await page.goto("/items");
  const dialog = await openAssistant(page);
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move Drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByRole("button", { name: "New conversation" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog.getByRole("button", { name: "New conversation" })).toBeDisabled();
  release();
  await expect(dialog.getByText("Moved 1 item(s).")).toBeVisible();
});

test("a later answer retains an action result that arrived while it was pending", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 844 });
  await fixture(page);
  const proposal = {
    id: "00000000-0000-0000-0000-000000000099", kind: "move_items", state: "ready",
    scope_label: "Synthetic household",
    targets: [{ id: "00000000-0000-0000-0000-000000000010", name: "Drill" }],
    destination: { id: "00000000-0000-0000-0000-000000000011", name: "Kitchen" },
    changes: {}, before: {},
  };
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => { release = resolve; });
  await assistantModel(page, async ({ query }) => {
    if (query !== "How many drills?") return { proposal };
    await wait;
    return { answer: "There is one drill." };
  });
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) =>
    route.fulfill({ json: { proposal_id: proposal.id, request_id: route.request().postDataJSON().request_id, message: "Moved 1 item(s)." } }),
  );
  await page.goto("/items");
  const dialog = await openAssistant(page);
  const input = dialog.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await input.fill("Move Drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review the destination, then Apply to move these items.")).toBeVisible();
  await input.fill("How many drills?");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog.getByText("Moved 1 item(s).")).toBeVisible();
  release();
  await expect(dialog.getByText("There is one drill.")).toBeVisible();
  await expect(dialog.getByText("Moved 1 item(s).")).toBeVisible();
});

test("item rename is reviewed and editable before applying", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const proposal = {
    id: "00000000-0000-0000-0000-000000000099", kind: "edit_item", state: "ready",
    scope_label: "Synthetic household",
    targets: [{ id: "00000000-0000-0000-0000-000000000010", name: "Drill" }],
    destination: null, changes: { name: "Cordless drill" },
    before: { name: "Drill", description: null, brand: null, model: null, serial_number: null, quantity: 1, condition: "good" },
  };
  await assistantModel(page, () => ({ proposal }));
  await page.route("**/api/v1/assistant/actions/proposals/*", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    expect(route.request().postDataJSON()).toEqual({ changes: { name: "New drill", brand: "Bosch", quantity: 2, condition: "fair" } });
    return route.fulfill({ json: { ...proposal, changes: { name: "New drill", brand: "Bosch", quantity: 2, condition: "fair" } } });
  });
  let applied = 0;
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) => {
    applied += 1;
    return route.fulfill({ json: { proposal_id: proposal.id, request_id: route.request().postDataJSON().request_id, message: "Updated New drill." } });
  });
  await page.goto("/items");
  const dialog = await openAssistant(page);
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Rename Drill to Cordless drill");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review the change below, then Apply to save it.")).toBeVisible();
  await expect(dialog.getByText("Cordless drill", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open full item editor" }))
    .toHaveAttribute("href", "/items/00000000-0000-0000-0000-000000000010/edit");
  await dialog.getByRole("button", { name: "Edit change" }).click();
  await dialog.getByRole("textbox", { name: "New name" }).fill("New drill");
  await dialog.getByRole("textbox", { name: "Brand" }).fill("Bosch");
  await dialog.getByRole("spinbutton", { name: "Quantity" }).fill("2");
  await dialog.getByLabel("Condition").selectOption("fair");
  await dialog.getByRole("button", { name: "Save change" }).click();
  await expect(dialog.getByText("New drill", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Bosch", { exact: true })).toBeVisible();
  await expect(dialog.getByText("fair", { exact: true })).toBeVisible();
  expect(applied).toBe(0);
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog.getByText("Updated New drill.")).toBeVisible();
  expect(applied).toBe(1);
});

test("privacy information explains reviewed writes", async ({ page }) => {
  await fixture(page);
  await page.goto("/items");
  const dialog = await openAssistant(page);
  await dialog.getByRole("button", { name: "Privacy & model" }).click();
  await expect(dialog.getByText("Changes require your review and explicit Apply.")).toBeVisible();
  await expect(dialog.getByText("The assistant never creates, edits or deletes inventory from this conversation.")).toHaveCount(0);
});

test("lending review shows and edits borrower, quantity and dates before apply", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const proposal = {
    id: "00000000-0000-0000-0000-000000000099", kind: "lend", state: "ready",
    scope_label: "Synthetic household",
    targets: [{ id: "00000000-0000-0000-0000-000000000010", name: "Drill" }],
    destination: null, changes: {
      item_id: "00000000-0000-0000-0000-000000000010", borrower_name: "Sam",
      quantity: 1, lent_on: "2025-01-03", due_on: null, notes: null, include_contents: false,
    }, before: { available_quantity: 3 },
  };
  await assistantModel(page, (request) => {
    expect(request.local_date).toMatch(/^\d{4}-\d\d-\d\d$/);
    return { proposal };
  });
  await page.route("**/api/v1/assistant/actions/proposals/*", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    expect(route.request().postDataJSON()).toEqual({
      borrower_name: "Alex", quantity: 2, lent_on: "2025-01-04", due_on: "2025-01-10",
    });
    return route.fulfill({ json: { ...proposal, changes: {
      ...proposal.changes, borrower_name: "Alex", quantity: 2, lent_on: "2025-01-04", due_on: "2025-01-10",
    } } });
  });
  let applied = 0;
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) => {
    applied += 1;
    return route.fulfill({ json: { proposal_id: proposal.id, request_id: route.request().postDataJSON().request_id, message: "Recorded loan of Drill to Alex." } });
  });
  await page.goto("/items");
  const dialog = await openAssistant(page);
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Lend Drill to Sam");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review the lending details, then Apply to record them.")).toBeVisible();
  await expect(dialog.getByText("Sam", { exact: true })).toBeVisible();
  await expect(dialog.getByText("2025-01-03", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Edit loan" }).click();
  await dialog.getByLabel("Borrower").fill("Alex");
  await dialog.getByLabel("Quantity").fill("2");
  await dialog.getByLabel("Lent on").fill("2025-01-04");
  await dialog.getByLabel("Due on").fill("2025-01-10");
  await dialog.getByRole("button", { name: "Save loan" }).click();
  await expect(dialog.getByText("Alex", { exact: true })).toBeVisible();
  expect(applied).toBe(0);
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog.getByText("Recorded loan of Drill to Alex.")).toBeVisible();
  expect(applied).toBe(1);
});

test("borrowing review shows and edits the item and owner before apply", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const proposal = {
    id: "00000000-0000-0000-0000-000000000099", kind: "borrow", state: "ready",
    scope_label: "Synthetic household", targets: [], destination: null,
    changes: { item_name: "Ladder", owner_name: "Sam", quantity: 2, borrowed_on: "2025-01-03", due_on: null },
    before: {},
  };
  await assistantModel(page, () => ({ proposal }));
  await page.route("**/api/v1/assistant/actions/proposals/*", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    expect(route.request().postDataJSON()).toEqual({
      item_name: "Step ladder", owner_name: "Alex", quantity: 1, borrowed_on: "2025-01-04", due_on: null,
    });
    return route.fulfill({ json: { ...proposal, changes: {
      item_name: "Step ladder", owner_name: "Alex", quantity: 1, borrowed_on: "2025-01-04", due_on: null,
    } } });
  });
  let applied = 0;
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) => {
    applied += 1;
    return route.fulfill({ json: { proposal_id: proposal.id, request_id: route.request().postDataJSON().request_id, message: "Recorded borrowing Step ladder from Alex." } });
  });
  await page.goto("/items");
  const dialog = await openAssistant(page);
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Borrow 2 Ladder from Sam");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review the lending details, then Apply to record them.")).toBeVisible();
  await expect(dialog.getByText("Ladder", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Sam", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Edit borrowing" }).click();
  await dialog.getByLabel("Item name").fill("Step ladder");
  await dialog.getByLabel("Owner").fill("Alex");
  await dialog.getByLabel("Quantity").fill("1");
  await dialog.getByLabel("Borrowed on").fill("2025-01-04");
  await dialog.getByRole("button", { name: "Save borrowing" }).click();
  await expect(dialog.getByText("Step ladder", { exact: true })).toBeVisible();
  expect(applied).toBe(0);
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog.getByText("Recorded borrowing Step ladder from Alex.")).toBeVisible();
  expect(applied).toBe(1);
});

test("return review edits quantity and date before apply", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const proposal = {
    id: "00000000-0000-0000-0000-000000000099", kind: "return_loan", state: "ready",
    scope_label: "Synthetic household",
    targets: [{ id: "00000000-0000-0000-0000-000000000010", name: "Drill · Sam" }],
    destination: null, changes: { quantity: 2, returned_on: "2025-01-04" },
    before: { outstanding_quantity: 3 },
  };
  await assistantModel(page, () => ({ proposal }));
  await page.route("**/api/v1/assistant/actions/proposals/*", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    expect(route.request().postDataJSON()).toEqual({ quantity: 1, returned_on: "2025-01-05" });
    return route.fulfill({ json: { ...proposal, changes: { quantity: 1, returned_on: "2025-01-05" } } });
  });
  let applied = 0;
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) => {
    applied += 1;
    return route.fulfill({ json: { proposal_id: proposal.id, request_id: route.request().postDataJSON().request_id, message: "Recorded return of Drill." } });
  });
  await page.goto("/items");
  const dialog = await openAssistant(page);
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Return 2 Drill from Sam");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review this return, then Apply to record it.")).toBeVisible();
  await expect(dialog.getByText("Drill · Sam", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Edit return" }).click();
  await dialog.getByLabel("Return quantity").fill("1");
  await dialog.getByLabel("Returned on").fill("2025-01-05");
  await dialog.getByRole("button", { name: "Save return" }).click();
  await expect(dialog.getByText("2025-01-05", { exact: true })).toBeVisible();
  expect(applied).toBe(0);
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog.getByText("Recorded return of Drill.")).toBeVisible();
  expect(applied).toBe(1);
});

test("cancelling an assistant proposal never applies it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  let applied = 0;
  await assistantModel(page, () => ({ proposal: {
    id: "00000000-0000-0000-0000-000000000099", kind: "move_items", state: "ready",
    scope_label: "Synthetic household · Home",
    targets: [{ id: "00000000-0000-0000-0000-000000000010", name: "Synthetic drill" }],
    destination: { id: "00000000-0000-0000-0000-000000000011", name: "Kitchen" },
    changes: {}, before: {},
  } }));
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) => {
    applied += 1;
    return route.fulfill({ status: 500 });
  });
  await page.route("**/api/v1/assistant/actions/proposals/*/cancel", (route) =>
    route.fulfill({ json: { id: "00000000-0000-0000-0000-000000000099", state: "cancelled" } }),
  );
  await page.goto("/items");
  const dialog = await openAssistant(page);
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move Synthetic drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await dialog.getByRole("button", { name: "Cancel proposal" }).click();
  await expect(dialog.getByText("Proposal cancelled. Nothing was changed.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Apply" })).toHaveCount(0);
  expect(applied).toBe(0);
});

test("assistant move review edits the destination without changing its target", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const proposal = {
    id: "00000000-0000-0000-0000-000000000099", kind: "move_items", state: "ready",
    scope_label: "Synthetic household · Home",
    targets: [{ id: "00000000-0000-0000-0000-000000000010", name: "Synthetic drill" }],
    destination: { id: "00000000-0000-0000-0000-000000000011", name: "Kitchen" },
    changes: { room_id: "00000000-0000-0000-0000-000000000011" }, before: {},
  };
  await assistantModel(page, () => ({ proposal }));
  await page.route("**/api/v1/assistant/actions/proposals/*/destinations", (route) =>
    route.fulfill({ json: { items: [
      { room_id: proposal.destination.id, storage_location_id: null, name: "Kitchen" },
      { room_id: "00000000-0000-0000-0000-000000000012", storage_location_id: null, name: "Garage" },
    ] } }),
  );
  await page.route("**/api/v1/assistant/actions/proposals/*", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    expect(route.request().postDataJSON().room_id).toBe("00000000-0000-0000-0000-000000000012");
    return route.fulfill({ json: { ...proposal, destination: {
      id: "00000000-0000-0000-0000-000000000012", name: "Garage",
    } } });
  });
  await page.goto("/items");
  const dialog = await openAssistant(page);
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move Synthetic drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await dialog.getByRole("button", { name: "Edit destination" }).click();
  await dialog.getByLabel("Destination").selectOption("00000000-0000-0000-0000-000000000012");
  await dialog.getByRole("button", { name: "Save destination" }).click();
  await expect(dialog.getByText("Scope: Synthetic household · Home")).toBeVisible();
  await expect(dialog.getByText("Garage", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Synthetic drill", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Move Synthetic drill to Kitchen", { exact: true })).toBeVisible();
});

test("a stale move must be refreshed and reviewed before applying", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const proposal = {
    id: "00000000-0000-0000-0000-000000000099", kind: "move_items", state: "ready",
    scope_label: "Synthetic household · Home",
    targets: [{ id: "00000000-0000-0000-0000-000000000010", name: "Synthetic drill" }],
    destination: { id: "00000000-0000-0000-0000-000000000011", name: "Kitchen" },
    changes: {}, before: {},
  };
  await assistantModel(page, () => ({ proposal }));
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) =>
    route.fulfill({ status: 409, json: { detail: {
      code: "proposal_stale", message: "The selected items changed. Refresh the proposal.",
    } } }),
  );
  await page.route("**/api/v1/assistant/actions/proposals/*/refresh", (route) =>
    route.fulfill({ json: { ...proposal, id: "00000000-0000-0000-0000-000000000098",
      targets: [{ ...proposal.targets[0], name: "Updated drill" }] } }),
  );
  await page.goto("/items");
  const dialog = await openAssistant(page);
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move Synthetic drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog.getByText("The selected items changed. Refresh the proposal.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Apply" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Refresh proposal" }).click();
  await expect(dialog.getByText("Updated drill", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Move Synthetic drill to Kitchen", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Apply" })).toBeEnabled();
});

test("pending proposal retains its original scope across a scope switch", async ({ page }) => {
  await fixture(page);
  const secondHousehold = "00000000-0000-0000-0000-000000000003";
  await page.route("**/api/v1/search/scopes**", (route) =>
    route.fulfill({ json: { items: [
      { id: household.id, name: "Home A", properties: [] },
      { id: secondHousehold, name: "Home B", properties: [] },
    ] } }),
  );
  const proposalId = "00000000-0000-0000-0000-000000000099";
  let appliedUrl = "";
  await assistantModel(page, (request) => {
    expect(request.household_id).toBe(household.id);
    return { proposal: {
      id: proposalId, kind: "move_items", state: "ready", scope_label: "Home A",
      targets: [{ id: "00000000-0000-0000-0000-000000000010", name: "Drill" }],
      destination: { id: "00000000-0000-0000-0000-000000000011", name: "Kitchen" },
      changes: {}, before: {},
    } };
  });
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) => {
    appliedUrl = route.request().url();
    return route.fulfill({ json: {
      proposal_id: proposalId, request_id: route.request().postDataJSON().request_id, message: "Moved 1 item(s).",
    } });
  });
  await page.goto("/items?sort=name_asc");
  const dialog = await openAssistant(page);
  const scope = dialog.getByLabel("Search scope");
  await scope.selectOption(`household:${household.id}`);
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move Drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByLabel("Action review")).toContainText("Scope: Home A");
  await scope.selectOption(`household:${secondHousehold}`);
  await expect(dialog.getByLabel("Action review")).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("?sort=name_asc");
  await scope.selectOption(`household:${household.id}`);
  await expect(dialog.getByLabel("Action review")).toContainText("Scope: Home A");
  await expect(dialog.getByText("Move Drill to Kitchen", { exact: true })).toBeVisible();
  await dialog.getByLabel("Action review").getByRole("button", { name: "Apply" }).click();
  await expect(dialog.getByLabel("Action review").getByRole("status")).toContainText("Moved");
  expect(appliedUrl).toContain(`/proposals/${proposalId}/apply`);
});

test("assistant retains a selected household scope when reopened over scoped page filters", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 844 });
  await fixture(page);
  const secondHousehold = "00000000-0000-0000-0000-000000000003";
  await page.route("**/api/v1/search/scopes**", (route) =>
    route.fulfill({ json: { items: [
      { id: household.id, name: "Home A", properties: [] },
      { id: secondHousehold, name: "Home B", properties: [] },
    ] } }),
  );
  // The page behind the assistant is the item list. Its own choices are in the address.
  // (The old search page is gone, and a household in the address is only a link that
  // switches household and is then removed.)
  await page.goto("/items?sort=name_asc");
  const pageFilters = "?sort=name_asc";
  expect(new URL(page.url()).search).toBe(pageFilters);
  const trigger = launcher(page);
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Assistant" });
  const scope = dialog.getByLabel("Search scope");
  await expect(scope.getByRole("option", { name: "Home B — all properties" })).toHaveCount(1);
  expect(new URL(page.url()).search).toBe(pageFilters);
  const pageStoredScope = await page.evaluate(() => localStorage.getItem("housetory-search-scope"));
  await scope.selectOption(`household:${secondHousehold}`);
  expect(await page.evaluate(() => localStorage.getItem("housetory-search-scope"))).toBe(pageStoredScope);
  const input = dialog.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await input.fill("Where is my drill?");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Synthetic answer from local records.")).toBeVisible();
  await input.fill("Draft for home B");
  await dialog.getByRole("button", { name: "Close assistant" }).click();
  expect(new URL(page.url()).search).toBe(pageFilters);
  await trigger.click();
  await expect(scope).toHaveValue(`household:${secondHousehold}`);
  await expect(input).toHaveValue("Draft for home B");
  await expect(dialog.getByText("Synthetic answer from local records.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close assistant" }).click();
  // Another page, from the sidebar.
  await page.getByRole("navigation", { name: "Rooms" }).getByRole("link", { name: /^On loan/ }).click();
  await expect(page).toHaveURL(/\/loans/);
  await trigger.click();
  await expect(scope).toHaveValue(`household:${secondHousehold}`);
  await expect(input).toHaveValue("Draft for home B");
  // There is no separate assistant page any more. The same panel grows to full height
  // and keeps the scope and the draft.
  await dialog.getByRole("button", { name: "Make the assistant full height" }).click();
  await expect(dialog.getByRole("button", { name: "Make the assistant smaller" })).toBeVisible();
  await expect(page).toHaveURL(/\/loans#assistant$/);
  await expect(scope).toHaveValue(`household:${secondHousehold}`);
  await expect(input).toHaveValue("Draft for home B");
});

test("property scope and in-flight response survive reopening and full-page handoff", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const secondHousehold = "00000000-0000-0000-0000-000000000003";
  const propertyA = "00000000-0000-0000-0000-000000000004";
  const propertyB = "00000000-0000-0000-0000-000000000005";
  await page.route("**/api/v1/search/scopes**", (route) =>
    route.fulfill({ json: { items: [
      { id: household.id, name: "Home A", properties: [{ id: propertyA, name: "Property A" }] },
      { id: secondHousehold, name: "Home B", properties: [{ id: propertyB, name: "Property B" }] },
    ] } }),
  );
  let release!: () => void;
  const responseGate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/search/query", async (route) => {
    await responseGate;
    await route.fulfill({ json: {
      query: "Where is it?", mode: "fallback", ai_used: false, ai_attempted: false,
      direct_match: false, ambiguous: false, needs_clarification: false,
      answer: "Answer from property B", answer_kind: "fallback", interpretation: "",
      filters: {}, items: [], quick_results: [], borrowed: [], borrowed_total: 0,
      total: 0, documents: [], locations: [], references: [], notices: [], facts: {},
      tool: "fallback", ai_status: { configured: false },
      context: { scope_key: `${secondHousehold}|${propertyB}`, resolved_items: [], candidate_items: [], loans: [], dialogue_memory: [] },
      scope_label: "Home B · Property B", households: [], property: null,
    } });
  });
  // The item list is shown for one property. That choice is the page's own.
  await page.route("**/api/v1/properties**", (route) =>
    route.fulfill({ json: { items: [{ id: propertyA, name: "Property A", is_default: true }], total: 1 } }),
  );
  await page.goto(`/items?property_id=${propertyA}`);
  const trigger = launcher(page);
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Assistant" });
  const scope = dialog.getByLabel("Search scope");
  await expect(scope.getByRole("option", { name: "Home B · Property B" })).toHaveCount(1);
  await scope.selectOption(`household:${secondHousehold}|property:${propertyB}`);
  const input = dialog.getByRole("textbox", { name: "Ask the Housetory assistant" });
  const request = page.waitForRequest((candidate) =>
    candidate.url().endsWith("/api/v1/search/query") && candidate.method() === "POST",
  );
  await input.fill("Where is it?");
  await dialog.getByRole("button", { name: "Send question" }).click();
  expect((await request).postDataJSON()).toMatchObject({ household_id: secondHousehold, property_id: propertyB });
  await input.fill("Unsent property B draft");
  await dialog.getByRole("button", { name: "Close assistant" }).click();
  expect(new URL(page.url()).searchParams.get("property_id")).toBe(propertyA);
  await trigger.click();
  await expect(scope).toHaveValue(`household:${secondHousehold}|property:${propertyB}`);
  await expect(input).toHaveValue("Unsent property B draft");
  await expect(dialog.getByRole("button", { name: "Send question" })).toBeDisabled();
  // The panel grows to full height in place: there is no separate assistant page.
  await dialog.getByRole("button", { name: "Make the assistant full height" }).click();
  await expect(dialog.getByRole("button", { name: "Make the assistant smaller" })).toBeVisible();
  const fullScope = scope;
  await expect(fullScope).toHaveValue(`household:${secondHousehold}|property:${propertyB}`);
  await fullScope.selectOption(`household:${household.id}|property:${propertyA}`);
  const response = page.waitForResponse((candidate) =>
    candidate.url().endsWith("/api/v1/search/query") && candidate.request().method() === "POST",
  );
  release();
  await (await response).finished();
  await expect(page.getByText("Answer from property B")).toHaveCount(0);
  await fullScope.selectOption(`household:${secondHousehold}|property:${propertyB}`);
  await expect(page.getByText("Answer from property B")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask the Housetory assistant" })).toHaveValue("Unsent property B draft");
  await fullScope.selectOption(`household:${household.id}|property:${propertyA}`);
  await expect(page.getByText("Answer from property B")).toHaveCount(0);
});

for (const width of [390, 1440]) {
  test(`assistant continuity and focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors = await fixture(page);
    await page.goto("/items?sort=name_asc");
    const trigger = launcher(page);
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Assistant" });
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
    // Full height is the same panel made taller. Nothing in it is lost.
    await dialog.getByRole("button", { name: "Make the assistant full height" }).click();
    await expect(dialog.getByRole("button", { name: "Make the assistant smaller" })).toBeVisible();
    await expect(input).toHaveValue("A draft for later");
    await expect(dialog.getByText("Synthetic answer from local records.")).toBeVisible();
    await dialog.getByRole("button", { name: "Close assistant" }).click();
    // Another page, from the rail of rooms, and back into the assistant.
    await page.getByRole("navigation", { name: "Rooms" }).getByRole("link", { name: /^On loan/ }).click();
    await expect(page).toHaveURL(/\/loans/);
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
    await page.getByRole("button", { name: "Select items" }).click();
    await page.getByRole("checkbox", { name: "Select Synthetic drill" }).check();
    await page.getByRole("checkbox", { name: "Select Synthetic ladder" }).check();
    const dialog = await openAssistant(page);
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
    await dialog.getByRole("button", { name: "Make the assistant full height" }).click();
    await expect(dialog.getByLabel("Current assistant context")).toContainText("Selection: 2 items");
    await dialog.getByRole("button", { name: "Clear assistant context" }).click();
    await expect(dialog.getByLabel("Current assistant context")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
