import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

interface SessionState {
  household: { id: string };
}

async function currentHeaders(request: APIRequestContext) {
  const response = await request.get("/api/v1/auth/session");
  const session = (await response.json()) as SessionState;
  return { "X-Household-Id": session.household.id };
}

async function createRoom(request: APIRequestContext, name: string) {
  const headers = await currentHeaders(request);
  const propertiesResponse = await request.get("/api/v1/properties", {
    headers,
  });
  const properties = (await propertiesResponse.json()) as {
    items: Array<{ id: string }>;
  };
  const response = await request.post("/api/v1/rooms", {
    headers,
    data: { name, property_id: properties.items[0]?.id },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string };
}

async function createItem(
  request: APIRequestContext,
  name: string,
  roomId: string,
) {
  const response = await request.post("/api/v1/items", {
    headers: await currentHeaders(request),
    data: { name, room_id: roomId, quantity: 1 },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: { id: string } };
}

test("example questions and an immediate submit keep their words", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // What the assistant is asked, whichever of its two ways of answering is used.
  const asked: string[] = [];
  page.on("request", (sent) => {
    const path = new URL(sent.url()).pathname;
    if (sent.method() === "POST" && /\/api\/v1\/(search\/query|assistant\/runs)$/.test(path)) {
      asked.push((sent.postDataJSON() as { query: string }).query);
    }
  });
  // The Search page is gone. Its example questions are in the empty assistant.
  await page.goto("/search");
  await expect(page).toHaveURL(/\/items$/);
  await page.locator('button[title="Open assistant"]').first().click();
  const panel = page.getByTestId("assistant-panel");
  const example = "Which items have no purchase information?";
  await panel.getByLabel("Suggested questions").getByRole("button", { name: example }).click();
  await expect(panel.getByRole("log", { name: "Conversation" }).getByText(example, { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Copy answer" })).toHaveCount(1);
  expect(asked.length).toBeGreaterThan(0);
  expect(new Set(asked)).toEqual(new Set([example]));
  let url = new URL(page.url());
  expect(url.searchParams.get("q")).toBeNull();
  expect(url.searchParams.get("ask")).toBeNull();
  await page.screenshot({
    path: "../../docs/walkthrough/release-stabilisation/01-search-example-light.png",
    fullPage: false,
  });

  // Enter pressed at once, before any match has loaded, must not lose the words.
  asked.length = 0;
  await page.goto("/search");
  const input = page.getByRole("combobox", {
    name: "Search or ask about your inventory",
  });
  await input.fill("PS5");
  await input.press("Enter");
  await expect(page).toHaveURL(/#assistant$/);
  await expect(panel.getByRole("log", { name: "Conversation" }).getByText("PS5", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Copy answer" })).toHaveCount(1);
  expect(new Set(asked)).toEqual(new Set(["PS5"]));
  url = new URL(page.url());
  expect(url.searchParams.get("ask")).toBeNull();
});

/** Light or dark is chosen on the Appearance screen. Links are used, so nothing reloads. */
async function chooseMode(page: Page, mode: "Light" | "Dark") {
  await page.getByRole("main").getByRole("link", { name: "Back to Settings" }).click();
  await page.getByRole("main").getByRole("link", { name: /^Appearance/ }).click();
  await page.getByRole("radiogroup", { name: "Light or dark" }).getByRole("radio", { name: mode, exact: true }).click();
  await page.getByRole("main").getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("main").getByRole("link", { name: /^System status/ }).click();
  await expect(page.getByRole("heading", { name: "System status", level: 1 })).toBeVisible();
}

test("status screen shows real readiness and task states; optional features are compact", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/settings/system-status");
  await expect(
    page.getByRole("heading", { name: "System status", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Back to Settings" }),
  ).toBeVisible();
  const status = page.locator('section[aria-labelledby="system-status-heading"]');
  await status.scrollIntoViewIfNeeded();
  await expect(status.getByText("Detailed status")).toBeVisible();
  await expect(
    status.getByText(new RegExp(process.env.E2E_RELEASE_COMMIT ?? "abc123release")),
  ).toBeVisible();
  await expect(status.getByText(/Last heartbeat/).first()).toBeVisible();
  await expect(status.getByText("Assistant").first()).toBeVisible();
  await expect(status.getByText(/Not live-tested/).first()).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/release-stabilisation/02-system-status-light.png",
    fullPage: false,
  });
  await chooseMode(page, "Dark");
  await page.locator("html.dark").waitFor();
  await status.scrollIntoViewIfNeeded();
  await expect(status.getByText("Detailed status")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "../../docs/walkthrough/release-stabilisation/03-system-status-dark.png",
    fullPage: false,
  });
  await chooseMode(page, "Light");
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  const room = await createRoom(request, `Release room ${suffix()}`);
  const item = await createItem(request, `Release item ${suffix()}`, room.id);
  await page.goto(`/items/${item.item.id}`);
  // The image source and its actions are under "Manage photos" on the item page.
  await page.getByRole("button", { name: "Manage photos" }).click();
  await expect(
    page.getByRole("button", { name: "Find online image" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Generate illustration/ })).toHaveCount(0);
  await expect(page.getByText("Setup required").first()).toBeVisible();
  await page.getByRole("button", { name: "Find online image" }).click();
  await expect(
    page.getByText("Online image lookup setup required"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open online search settings" }),
  ).toHaveAttribute("href", "/settings#online-search");
  await page.screenshot({
    path: "../../docs/walkthrough/local-polish/04-image-lookup-setup-light.png",
    fullPage: false,
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Add items" }).first().click();
  const micButton = page
    .getByRole("dialog", { name: "Add items" })
    .getByRole("button", { name: "Record voice note" });
  await expect(micButton).toHaveAttribute("aria-disabled", "true");
  await expect(micButton).toHaveAttribute(
    "title",
    "Voice needs transcription — set up in AI settings",
  );
  // The button is only marked as off (aria-disabled), so a press still shows why.
  // The test tool waits for "enabled" by default, so the press is forced.
  await micButton.click({ force: true });
  await expect(
    page.getByRole("link", { name: "set up in AI settings" }),
  ).toHaveAttribute("href", "/settings/ai");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/system-status");
  await status.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "../../docs/walkthrough/release-stabilisation/04-system-status-mobile.png",
    fullPage: false,
  });
});
