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
    if (url.pathname === "/api/v1/assistant/actions/intent") {
      return route.fulfill({ json: { intent: "unavailable", form: null } });
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

test("action follow-up carries the conversation item after reopening the panel", async ({ page }) => {
  await fixture(page);
  const itemId = "00000000-0000-0000-0000-000000000010";
  await page.route("**/api/v1/search/query", (route) => route.fulfill({ json: {
    query: "Where is the drill?", mode: "fallback", ai_used: false, ai_attempted: false,
    direct_match: false, ambiguous: false, needs_clarification: false,
    answer: "The drill is in Storage.", answer_kind: "fallback", interpretation: "",
    filters: {}, items: [], quick_results: [], borrowed: [], borrowed_total: 0, total: 0,
    documents: [], locations: [], references: [], notices: [], facts: {}, tool: "fallback",
    ai_status: { configured: false },
    context: { scope_key: "|", resolved_items: [{ id: itemId, name: "Drill" }], candidate_items: [], loans: [], dialogue_memory: [] },
    scope_label: "All my places", households: [], property: null,
  } }));
  let received: string[] | undefined;
  await page.route("**/api/v1/assistant/actions/interpret", (route) => {
    received = route.request().postDataJSON().conversation_item_ids;
    return route.fulfill({ json: { handled: true, message: "Review the move.", proposal: null } });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Where is the drill?");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("The drill is in Storage.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move it to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review the move.")).toBeVisible();
  expect(received).toEqual([itemId]);
});

test("a reviewed action becomes the target of an action follow-up", async ({ page }) => {
  await fixture(page);
  const itemId = "00000000-0000-0000-0000-000000000010";
  let followupIds: string[] | undefined;
  await page.route("**/api/v1/assistant/actions/interpret", (route) => {
    const body = route.request().postDataJSON() as { query: string; conversation_item_ids: string[] };
    if (body.query === "Move it to Kitchen") {
      followupIds = body.conversation_item_ids;
      return route.fulfill({ json: { handled: true, message: "Move review.", proposal: null } });
    }
    return route.fulfill({ json: {
      handled: true, message: "Edit review.", proposal: {
        id: "00000000-0000-0000-0000-000000000099", kind: "edit_item", state: "ready",
        scope_label: "Synthetic household", targets: [{ id: itemId, name: "Drill" }],
        destination: null, changes: { name: "Cordless drill" }, before: { name: "Drill" },
      },
    } });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await input.fill("Rename Drill to Cordless drill");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByLabel("Action review")).toBeVisible();
  await input.fill("Move it to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Move review.")).toBeVisible();
  expect(followupIds).toEqual([itemId]);
});

test("duplicate action targets can be clarified after reopening the assistant", async ({ page }) => {
  await fixture(page);
  const first = "00000000-0000-0000-0000-000000000010";
  const second = "00000000-0000-0000-0000-000000000011";
  let clarified: { query: string; clarified_item_id?: string } | undefined;
  await page.route("**/api/v1/assistant/actions/interpret", (route) => {
    const body = route.request().postDataJSON() as { query: string; clarified_item_id?: string };
    if (!body.clarified_item_id) {
      return route.fulfill({ json: {
        handled: true, message: "Which item should I change?", proposal: null,
        item_choices: [{ id: first, name: "Drill · Office" }, { id: second, name: "Drill · Garage" }],
      } });
    }
    clarified = body;
    return route.fulfill({ json: {
      handled: true, message: "Review the move before applying it.", item_choices: [],
      proposal: {
        id: "00000000-0000-0000-0000-000000000099", kind: "move_items", state: "ready",
        scope_label: "Synthetic household", targets: [{ id: first, name: "Drill" }],
        destination: { id: "00000000-0000-0000-0000-000000000012", name: "Kitchen" },
        changes: {}, before: {},
      },
    } });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move Drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Which item should I change?")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Drill · Office" }).click();
  await expect(dialog.getByLabel("Action review")).toContainText("Kitchen");
  await expect(dialog.getByLabel("Action review")).toContainText("Selected: Drill · Office");
  await expect(dialog.getByRole("button", { name: "Drill · Office" })).toBeDisabled();
  expect(clarified).toMatchObject({ query: "Move Drill to Kitchen", clarified_item_id: first });
});

test("a location follow-up clarifies an ambiguous action", async ({ page }) => {
  await fixture(page);
  const first = "00000000-0000-0000-0000-000000000010";
  let clarified: { query: string; clarified_item_location?: string } | undefined;
  await page.route("**/api/v1/assistant/actions/interpret", (route) => {
    const body = route.request().postDataJSON() as { query: string; clarified_item_location?: string };
    if (!body.clarified_item_location) {
      return route.fulfill({ json: {
        handled: true, message: "Which item?", proposal: null,
        item_choices: [{ id: first, name: "Drill · Office" }, { id: "00000000-0000-0000-0000-000000000011", name: "Drill · Garage" }],
      } });
    }
    clarified = body;
    return route.fulfill({ json: {
      handled: true, message: "Review the move.", item_choices: [],
      proposal: {
        id: "00000000-0000-0000-0000-000000000099", kind: "move_items", state: "ready",
        scope_label: "Synthetic household", targets: [{ id: first, name: "Drill" }],
        destination: { id: "00000000-0000-0000-0000-000000000012", name: "Kitchen" },
        changes: {}, before: {},
      },
    } });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await input.fill("Move Drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Which item?")).toBeVisible();
  await input.fill("the one in Office");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByLabel("Action review")).toContainText("Selected: Drill · Office");
  expect(clarified).toMatchObject({ query: "Move Drill to Kitchen", clarified_item_location: "Office" });
});

test("Persian borrowing and returns reach the action interpreter", async ({ page }) => {
  await fixture(page);
  const queries: string[] = [];
  await page.route("**/api/v1/assistant/actions/interpret", (route) => {
    queries.push(route.request().postDataJSON().query as string);
    return route.fulfill({ json: { handled: true, message: "Review available.", proposal: null } });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByRole("textbox", { name: "Ask the Housetory assistant" });
  const requests = ["نردبان رو از سارا قرض بگیر", "۱ دریل رو از علی پس بگیر", "۱ نردبان رو به سارا پس بده"];
  for (const [index, query] of requests.entries()) {
    await input.fill(query);
    await dialog.getByRole("button", { name: "Send question" }).click();
    await expect.poll(() => queries.length).toBe(index + 1);
    await expect(dialog.getByText("Review available.")).toHaveCount(index + 1);
  }
  expect(queries).toEqual(requests);
});

test("reviewed assistant move remains pending until explicitly applied", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 844 });
  await fixture(page);
  let applied = 0;
  await page.route("**/api/v1/assistant/actions/interpret", (route) =>
    route.fulfill({ json: {
      handled: true, message: "Review the move before applying it.",
      proposal: {
        id: "00000000-0000-0000-0000-000000000099", kind: "move_items", state: "ready",
        scope_label: "Synthetic household · Home",
        targets: [{ id: "00000000-0000-0000-0000-000000000010", name: "Synthetic drill" }],
        destination: { id: "00000000-0000-0000-0000-000000000011", name: "Kitchen" },
        changes: { room_id: "00000000-0000-0000-0000-000000000011" }, before: {},
      },
    } }),
  );
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) => {
    applied += 1;
    return route.fulfill({ json: {
      proposal_id: "00000000-0000-0000-0000-000000000099",
      request_id: route.request().postDataJSON().request_id, message: "Moved 1 item(s).",
    } });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move Synthetic drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review the move before applying it.")).toBeVisible();
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
  await page.route("**/api/v1/assistant/actions/interpret", (route) =>
    route.fulfill({ json: { handled: true, message: "Review the move before applying it.", proposal } }),
  );
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", async (route) => {
    await wait;
    await route.fulfill({ json: { proposal_id: proposal.id, request_id: route.request().postDataJSON().request_id, message: "Moved 1 item(s)." } });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move Drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
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
  await page.route("**/api/v1/assistant/actions/interpret", (route) =>
    route.fulfill({ json: { handled: true, message: "Review the move before applying it.", proposal } }),
  );
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) =>
    route.fulfill({ json: { proposal_id: proposal.id, request_id: route.request().postDataJSON().request_id, message: "Moved 1 item(s)." } }),
  );
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/search/query", async (route) => {
    await wait;
    await route.fulfill({ json: {
      answer: "There is one drill.", query: "How many drills?", mode: "fallback",
      ai_used: false, ai_attempted: false, direct_match: false, ambiguous: false,
      needs_clarification: false, answer_kind: "fallback", interpretation: "", filters: {},
      items: [], quick_results: [], borrowed: [], borrowed_total: 0, total: 0, documents: [],
      locations: [], references: [], notices: [], facts: {}, tool: "fallback",
      ai_status: { configured: false }, context: { scope_key: "|", resolved_items: [], candidate_items: [], loans: [], dialogue_memory: [] },
      scope_label: "All my places", households: [], property: null,
    } });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await input.fill("Move Drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review the move before applying it.")).toBeVisible();
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
  await page.route("**/api/v1/assistant/actions/interpret", (route) =>
    route.fulfill({ json: { handled: true, message: "Review the item edit before applying it.", proposal } }),
  );
  await page.route("**/api/v1/assistant/actions/proposals/*", (route) => {
    expect(route.request().method()).toBe("PATCH");
    expect(route.request().postDataJSON()).toEqual({ changes: { name: "New drill", brand: "Bosch", quantity: 2, condition: "fair" } });
    return route.fulfill({ json: { ...proposal, changes: { name: "New drill", brand: "Bosch", quantity: 2, condition: "fair" } } });
  });
  let applied = 0;
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) => {
    applied += 1;
    return route.fulfill({ json: { proposal_id: proposal.id, request_id: route.request().postDataJSON().request_id, message: "Updated New drill." } });
  });
  await page.goto("/items");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Assistant" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Rename Drill to Cordless drill");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review the item edit before applying it.")).toBeVisible();
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

test("item detail requests reach the reviewed-action interface", async ({ page }) => {
  await fixture(page);
  let query = "";
  await page.route("**/api/v1/assistant/actions/interpret", (route) => {
    query = route.request().postDataJSON().query;
    return route.fulfill({ json: { handled: true, message: "Review the item edit.", proposal: null } });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Set Drill brand to Bosch");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review the item edit.")).toBeVisible();
  expect(query).toBe("Set Drill brand to Bosch");
});

test("privacy information explains reviewed writes", async ({ page }) => {
  await fixture(page);
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Privacy & model" }).click();
  await expect(dialog.getByText("Changes require your review and explicit Apply.")).toBeVisible();
  await expect(dialog.getByText("The assistant never creates, edits or deletes inventory from this conversation.")).toHaveCount(0);
});

test("natural action phrasing reaches the action interpreter", async ({ page }) => {
  await fixture(page);
  let query = "";
  await page.route("**/api/v1/assistant/actions/interpret", (route) => {
    query = route.request().postDataJSON().query;
    return route.fulfill({ json: { handled: true, message: "Review the move.", proposal: null } });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Could you please move Drill into Kitchen?");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review the move.")).toBeVisible();
  expect(query).toBe("Could you please move Drill into Kitchen?");
});

test("a natural offline move request reaches the reviewed-action interface", async ({ page }) => {
  await fixture(page);
  let query = "";
  await page.route("**/api/v1/assistant/actions/interpret", (route) => {
    query = route.request().postDataJSON().query;
    return route.fulfill({ json: { handled: true, message: "Review the move.", proposal: null } });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("I want to move Drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review the move.")).toBeVisible();
  expect(query).toBe("I want to move Drill to Kitchen");
});

test("unsupported deletion offers the existing item controls without pretending success", async ({ page }) => {
  await fixture(page);
  let searchCalls = 0;
  await page.route("**/api/v1/search/query", (route) => {
    searchCalls += 1;
    return route.fulfill({ status: 500, body: "Unexpected search" });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("I want to delete Drill");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("The assistant cannot delete items. Use the existing item controls.")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open items" })).toHaveAttribute("href", "/items");
  expect(searchCalls).toBe(0);
});

test("unsupported Persian deletion offers existing item controls", async ({ page }) => {
  await fixture(page);
  let searchCalls = 0;
  await page.route("**/api/v1/search/query", (route) => {
    searchCalls += 1;
    return route.fulfill({ status: 500, body: "Unexpected search" });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("دریل رو حذف کن");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("The assistant cannot delete items. Use the existing item controls.")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open items" })).toHaveAttribute("href", "/items");
  expect(searchCalls).toBe(0);
});

test("unsupported merge requests offer existing item controls", async ({ page }) => {
  await fixture(page);
  let searchCalls = 0;
  await page.route("**/api/v1/search/query", (route) => {
    searchCalls += 1;
    return route.fulfill({ status: 500, body: "Unexpected search" });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Merge these items");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("The assistant cannot merge inventory items. Use the existing item controls.")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open items" })).toHaveAttribute("href", "/items");
  expect(searchCalls).toBe(0);
});

test("unsupported archive requests offer the existing item controls", async ({ page }) => {
  await fixture(page);
  let searchCalls = 0;
  await page.route("**/api/v1/search/query", (route) => {
    searchCalls += 1;
    return route.fulfill({ status: 500, body: "Unexpected search" });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Archive Drill");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("The assistant cannot archive or restore items. Use the existing item controls.")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open items" })).toHaveAttribute("href", "/items");
  expect(searchCalls).toBe(0);
});

test("unsupported selling offers item controls instead of searching", async ({ page }) => {
  await fixture(page);
  let searchCalls = 0;
  await page.route("**/api/v1/search/query", (route) => {
    searchCalls += 1;
    return route.fulfill({ status: 500, body: "Unexpected search" });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Sell my drill");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("The assistant cannot record item disposition. Use the existing item controls.")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open items" })).toHaveAttribute("href", "/items");
  expect(searchCalls).toBe(0);
});

test("unsupported room creation offers the existing room form", async ({ page }) => {
  await fixture(page);
  let searchCalls = 0;
  await page.route("**/api/v1/search/query", (route) => {
    searchCalls += 1;
    return route.fulfill({ status: 500, body: "Unexpected search" });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Create a new room");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("The assistant cannot create rooms. Use the existing room controls.")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open rooms" })).toHaveAttribute("href", "/rooms");
  expect(searchCalls).toBe(0);
});

test("AI identifies an unsupported action without sending it to search", async ({ page }) => {
  await fixture(page);
  let searchCalls = 0;
  await page.route("**/api/v1/search/query", (route) => {
    searchCalls += 1;
    return route.fulfill({ status: 500, body: "Unexpected search" });
  });
  await page.route("**/api/v1/assistant/actions/intent", (route) =>
    route.fulfill({ json: { intent: "unsupported_action", form: "rooms" } }),
  );
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Set up a nursery for me");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("The assistant cannot perform that action. Use the existing controls.")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open rooms" })).toHaveAttribute("href", "/rooms");
  expect(searchCalls).toBe(0);
});

test("AI-routed questions use normal search while ambiguous actions ask once", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/v1/assistant/actions/intent", (route) => {
    const { query } = route.request().postDataJSON();
    return route.fulfill({ json: {
      intent: query === "Where is my drill?" ? "question" : "ambiguous",
      form: null,
    } });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await input.fill("Where is my drill?");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Synthetic answer from local records.")).toBeVisible();
  await expect(dialog.getByText("Read-only answer. No changes were made.")).toBeVisible();
  await input.fill("Do something with my drill");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("What would you like to change?")).toBeVisible();
});

test("unreachable intent provider preserves read-only search and reports the limitation", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/v1/assistant/actions/intent", (route) =>
    route.fulfill({ status: 503, json: { detail: { code: "intent_unavailable", message: "Intent provider unavailable." } } }),
  );
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Where is my drill?");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Synthetic answer from local records.")).toBeVisible();
  await expect(dialog.getByText("Read-only answer. No changes were made.")).toBeVisible();
  await expect(page.getByText("AI intent interpretation is unavailable; using local routing.")).toBeVisible();
});

test("AI identifies an action-word lookup as a question", async ({ page }) => {
  await fixture(page);
  let actionCalls = 0;
  await page.route("**/api/v1/assistant/actions/intent", (route) =>
    route.fulfill({ json: { intent: "question", form: null } }),
  );
  await page.route("**/api/v1/assistant/actions/interpret", (route) => {
    actionCalls += 1;
    return route.fulfill({ status: 500, body: "Unexpected action" });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move history for Drill");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Synthetic answer from local records.")).toBeVisible();
  expect(actionCalls).toBe(0);
});

test("AI-routed supported action opens review before any apply", async ({ page }) => {
  await fixture(page);
  let applies = 0;
  const interpreted: string[] = [];
  await page.route("**/api/v1/assistant/actions/intent", (route) =>
    route.fulfill({ json: { intent: "supported_action", form: null } }),
  );
  await page.route("**/api/v1/assistant/actions/interpret", (route) => {
    interpreted.push(route.request().postDataJSON().query);
    return route.fulfill({ json: {
      handled: true,
      message: "Review the move before applying it.",
      proposal: {
        id: "proposal-1", kind: "move_items", state: "ready", scope_label: "Home",
        targets: [{ id: "item-1", name: "Drill" }],
        destination: { id: "room-1", name: "Kitchen" },
        changes: {}, before: {},
      },
    } });
  });
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) => {
    applies += 1;
    return route.fulfill({ json: { message: "Moved 1 item(s)." } });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Transfer Drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  const review = dialog.getByLabel("Action review");
  await expect(review.getByText("Drill", { exact: true })).toBeVisible();
  await expect(review.getByText("Kitchen", { exact: true })).toBeVisible();
  expect(interpreted).toEqual(["Transfer Drill to Kitchen"]);
  expect(applies).toBe(0);
  await review.getByRole("button", { name: "Apply" }).click();
  await expect(review.getByRole("status")).toContainText("Moved");
  expect(applies).toBe(1);
});

test("unsupported account changes offer account settings instead of inventory actions", async ({ page }) => {
  await fixture(page);
  let actionCalls = 0;
  await page.route("**/api/v1/assistant/actions/interpret", (route) => {
    actionCalls += 1;
    return route.fulfill({ status: 500, body: "Unexpected action" });
  });
  await page.goto("/items");
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Change my password");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("The assistant cannot change account settings. Use the existing account settings.")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open account settings" })).toHaveAttribute("href", "/settings/account");
  expect(actionCalls).toBe(0);
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
  await page.route("**/api/v1/assistant/actions/interpret", (route) => {
    expect(route.request().postDataJSON().local_date).toMatch(/^\d{4}-\d\d-\d\d$/);
    return route.fulfill({ json: { handled: true, message: "Review the loan before applying it.", proposal } });
  });
  await page.route("**/api/v1/assistant/actions/proposals/*", (route) => {
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
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Assistant" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Lend Drill to Sam");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review the loan before applying it.")).toBeVisible();
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
  await page.route("**/api/v1/assistant/actions/interpret", (route) =>
    route.fulfill({ json: { handled: true, message: "Review the borrowing before applying it.", proposal } }),
  );
  await page.route("**/api/v1/assistant/actions/proposals/*", (route) => {
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
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Assistant" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Borrow 2 Ladder from Sam");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review the borrowing before applying it.")).toBeVisible();
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
  await page.route("**/api/v1/assistant/actions/interpret", (route) =>
    route.fulfill({ json: { handled: true, message: "Review the return before applying it.", proposal } }),
  );
  await page.route("**/api/v1/assistant/actions/proposals/*", (route) => {
    expect(route.request().postDataJSON()).toEqual({ quantity: 1, returned_on: "2025-01-05" });
    return route.fulfill({ json: { ...proposal, changes: { quantity: 1, returned_on: "2025-01-05" } } });
  });
  let applied = 0;
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) => {
    applied += 1;
    return route.fulfill({ json: { proposal_id: proposal.id, request_id: route.request().postDataJSON().request_id, message: "Recorded return of Drill." } });
  });
  await page.goto("/items");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Assistant" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Return 2 Drill from Sam");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Review the return before applying it.")).toBeVisible();
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
  await page.route("**/api/v1/assistant/actions/interpret", (route) =>
    route.fulfill({ json: {
      handled: true, message: "Review the move before applying it.",
      proposal: {
        id: "00000000-0000-0000-0000-000000000099", kind: "move_items", state: "ready",
        scope_label: "Synthetic household · Home",
        targets: [{ id: "00000000-0000-0000-0000-000000000010", name: "Synthetic drill" }],
        destination: { id: "00000000-0000-0000-0000-000000000011", name: "Kitchen" },
        changes: {}, before: {},
      },
    } }),
  );
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) => {
    applied += 1;
    return route.fulfill({ status: 500 });
  });
  await page.route("**/api/v1/assistant/actions/proposals/*/cancel", (route) =>
    route.fulfill({ json: { id: "00000000-0000-0000-0000-000000000099", state: "cancelled" } }),
  );
  await page.goto("/items");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Assistant" }).click();
  const dialog = page.getByRole("dialog");
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
  await page.route("**/api/v1/assistant/actions/interpret", (route) =>
    route.fulfill({ json: { handled: true, message: "Review the move before applying it.", proposal } }),
  );
  await page.route("**/api/v1/assistant/actions/proposals/*/destinations", (route) =>
    route.fulfill({ json: { items: [
      { room_id: proposal.destination.id, storage_location_id: null, name: "Kitchen" },
      { room_id: "00000000-0000-0000-0000-000000000012", storage_location_id: null, name: "Garage" },
    ] } }),
  );
  await page.route("**/api/v1/assistant/actions/proposals/*", (route) => {
    expect(route.request().method()).toBe("PATCH");
    expect(route.request().postDataJSON().room_id).toBe("00000000-0000-0000-0000-000000000012");
    return route.fulfill({ json: { ...proposal, destination: {
      id: "00000000-0000-0000-0000-000000000012", name: "Garage",
    } } });
  });
  await page.goto("/items");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Assistant" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move Synthetic drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await dialog.getByRole("button", { name: "Edit destination" }).click();
  await dialog.getByLabel("Destination").selectOption("00000000-0000-0000-0000-000000000012");
  await dialog.getByRole("button", { name: "Save destination" }).click();
  await expect(dialog.getByText("Scope: Synthetic household · Home")).toBeVisible();
  await expect(dialog.getByText("Garage", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Synthetic drill", { exact: true })).toBeVisible();
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
  await page.route("**/api/v1/assistant/actions/interpret", (route) =>
    route.fulfill({ json: { handled: true, message: "Review the move before applying it.", proposal } }),
  );
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
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Assistant" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move Synthetic drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog.getByText("The selected items changed. Refresh the proposal.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Apply" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Refresh proposal" }).click();
  await expect(dialog.getByText("Updated drill", { exact: true })).toBeVisible();
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
  await page.route("**/api/v1/assistant/actions/interpret", (route) =>
    route.fulfill({ json: {
      handled: true, message: "Review move.", proposal: {
        id: proposalId, kind: "move_items", state: "ready", scope_label: "Home A",
        targets: [{ id: "00000000-0000-0000-0000-000000000010", name: "Drill" }],
        destination: { id: "00000000-0000-0000-0000-000000000011", name: "Kitchen" },
        changes: {}, before: {},
      },
    } }),
  );
  await page.route("**/api/v1/assistant/actions/proposals/*/apply", (route) => {
    appliedUrl = route.request().url();
    return route.fulfill({ json: {
      proposal_id: proposalId, request_id: route.request().postDataJSON().request_id, message: "Moved 1 item(s).",
    } });
  });
  await page.goto(`/search?household_id=${household.id}`);
  await page.getByRole("button", { name: "Open assistant panel" }).click();
  const dialog = page.getByRole("dialog");
  const scope = dialog.getByLabel("Search scope");
  await scope.selectOption(`household:${household.id}`);
  await dialog.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill("Move Drill to Kitchen");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByLabel("Action review")).toContainText("Scope: Home A");
  await scope.selectOption(`household:${secondHousehold}`);
  await expect(dialog.getByLabel("Action review")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("household_id")).toBe(household.id);
  await scope.selectOption(`household:${household.id}`);
  await expect(dialog.getByLabel("Action review")).toContainText("Scope: Home A");
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
  await page.goto(`/search?household_id=${household.id}`);
  expect(new URL(page.url()).searchParams.get("household_id")).toBe(household.id);
  const trigger = page.getByRole("button", { name: "Open assistant panel" });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  const scope = dialog.getByLabel("Search scope");
  await expect(scope.getByRole("option", { name: "Home B — all properties" })).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get("household_id")).toBe(household.id);
  const pageStoredScope = await page.evaluate(() => localStorage.getItem("housetory-search-scope"));
  await scope.selectOption(`household:${secondHousehold}`);
  expect(await page.evaluate(() => localStorage.getItem("housetory-search-scope"))).toBe(pageStoredScope);
  const input = dialog.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await input.fill("Where is my drill?");
  await dialog.getByRole("button", { name: "Send question" }).click();
  await expect(dialog.getByText("Synthetic answer from local records.")).toBeVisible();
  await input.fill("Draft for home B");
  await dialog.getByRole("button", { name: "Close assistant" }).click();
  expect(new URL(page.url()).searchParams.get("household_id")).toBe(household.id);
  await trigger.click();
  await expect(scope).toHaveValue(`household:${secondHousehold}`);
  await expect(input).toHaveValue("Draft for home B");
  await expect(dialog.getByText("Synthetic answer from local records.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close assistant" }).click();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Items", exact: true }).click();
  await expect(page).toHaveURL(/\/items/);
  await trigger.click();
  await expect(scope).toHaveValue(`household:${secondHousehold}`);
  await expect(input).toHaveValue("Draft for home B");
  await dialog.getByRole("link", { name: "Open full page" }).click();
  await expect(page).toHaveURL(/\/assistant/);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Search scope")).toHaveValue(`household:${secondHousehold}`);
  await expect(page.getByRole("textbox", { name: "Ask the Housetory assistant" })).toHaveValue("Draft for home B");
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
  await page.goto(`/search?household_id=${household.id}&property_id=${propertyA}`);
  const trigger = page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Assistant" });
  await trigger.click();
  const dialog = page.getByRole("dialog");
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
  expect(new URL(page.url()).searchParams.get("household_id")).toBe(household.id);
  expect(new URL(page.url()).searchParams.get("property_id")).toBe(propertyA);
  await trigger.click();
  await expect(scope).toHaveValue(`household:${secondHousehold}|property:${propertyB}`);
  await expect(input).toHaveValue("Unsent property B draft");
  await expect(dialog.getByRole("button", { name: "Send question" })).toBeDisabled();
  await dialog.getByRole("link", { name: "Open full page" }).click();
  await expect(page).toHaveURL(/\/assistant/);
  await expect(dialog).toHaveCount(0);
  const fullScope = page.getByLabel("Search scope");
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
