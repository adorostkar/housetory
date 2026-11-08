import { expect, test, type APIRequestContext } from "@playwright/test";

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

test("search examples and immediate submit keep their query", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/search");
  const example = "Which items have no purchase information?";
  await page.getByRole("button", { name: example }).click();
  await expect(
    page.getByRole("combobox", { name: "Search or ask about your inventory" }),
  ).toHaveValue(example);
  await page.waitForTimeout(550);
  let url = new URL(page.url());
  expect(url.searchParams.get("q")).toBe(example);
  expect(url.searchParams.get("ask")).toBeNull();
  await page.screenshot({
    path: "../../docs/walkthrough/release-stabilisation/01-search-example-light.png",
    fullPage: false,
  });

  await page.goto("/search");
  const input = page.getByRole("combobox", {
    name: "Search or ask about your inventory",
  });
  await input.fill("PS5");
  await input.press("Enter");
  await page.waitForTimeout(550);
  url = new URL(page.url());
  expect(url.searchParams.get("q")).toBe("PS5");
  expect(url.searchParams.get("ask")).toBeNull();
});

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
  await page.getByRole("button", { name: "Switch to dark mode" }).first().click();
  await page.locator("html.dark").waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "../../docs/walkthrough/release-stabilisation/03-system-status-dark.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "Switch to light mode" }).first().click();

  const room = await createRoom(request, `Release room ${suffix()}`);
  const item = await createItem(request, `Release item ${suffix()}`, room.id);
  await page.goto(`/items/${item.item.id}`);
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
  await page.goto("/voice");
  await expect(
    page.getByRole("heading", { name: "Voice transcription is not set up" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Configure voice transcription" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Start recording/ }),
  ).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/system-status");
  await status.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "../../docs/walkthrough/release-stabilisation/04-system-status-mobile.png",
    fullPage: false,
  });
});
