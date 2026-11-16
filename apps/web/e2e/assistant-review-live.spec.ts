import { expect, test, type Page } from "@playwright/test";

// Real-provider check for delegated review outcomes. Skipped unless LIVE_AI_E2E=1. Run it
// against a disposable stack whose household has a real Assistant provider configured
// (and cloud consent where needed). It makes a handful of real inference requests.
test.skip(!process.env.LIVE_AI_E2E, "Needs a disposable stack with a real configured provider");

async function askPanel(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Ask the Housetory assistant" }).fill(text);
  await page.getByRole("button", { name: "Send question", exact: true }).click();
  const task = page.getByLabel("Assistant tool task").last();
  await expect(task).toHaveAttribute("data-state", /completed|awaiting_approval|needs_attention/, { timeout: 300_000 });
  await expect(task, "the request must not hit a context or provider limit")
    .not.toHaveAttribute("data-state", "needs_attention");
  const answer = page.getByTestId("answer-text").last();
  const words = await answer.innerText().catch(() => "");
  console.log(`LIVE "${text}" ->`, words.replace(/\s+/g, " "));
  return words;
}

test("category requests end in a category or a recorded reason, with grounded follow-ups", async ({ page, request }) => {
  test.setTimeout(900_000);
  const status = await (await request.get("/api/v1/ai/status?task=assistant")).json();
  expect(status.configured, "Configure a real Assistant provider first").toBeTruthy();
  const suffix = Date.now().toString().slice(-5);
  const monitorName = `Validation Monitor ${suffix}`;
  const drillName = `Heavy drill ${suffix}`;
  const create = async (data: object) =>
    (await (await request.post("/api/v1/items", { data: { quantity: 1, ...data } })).json()).item;
  const monitor = await create({ name: monitorName });
  const drill = await create({ name: drillName, brand: "Dewalt" });
  const pending = async (id: string) => (await (await request.get(
    `/api/v1/inventory-review/suggestions?status=pending&limit=20&item_ids=${id}`,
  )).json()).items.filter((entry: { type: string }) => entry.type === "organisation");
  const proposedCategory = async (id: string) =>
    (await pending(id)).map((entry: { after: { category_name?: string } }) => entry.after.category_name).find(Boolean);
  const untouched = async () => {
    for (const item of [monitor, drill]) {
      const current = (await (await request.get(`/api/v1/items/${item.id}`)).json()).item;
      expect(current.category).toBeNull();
      expect(current.tags).toEqual([]);
    }
  };

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/items");
  const header = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await header.fill("review my items and suggest categories");
  await header.press("Enter");
  const review = page.getByRole("region", { name: "Inventory review", exact: true }).last();
  await expect(review.getByRole("status")).toContainText(/Analysing with AI…|Analysis finished|Local checks finished/, { timeout: 180_000 });
  const confirm = review.getByRole("button", { name: "Run AI analysis", exact: true });
  if (await confirm.isVisible()) await confirm.click();
  await expect(review.getByRole("status")).toContainText("Analysis finished", { timeout: 600_000 });

  // Each uncategorised item ends with a proposed category; tags alone do not count.
  for (const item of [monitor, drill]) {
    const category = await proposedCategory(item.id);
    console.log(`LIVE category for ${item.name}:`, category ?? "(none)");
    expect(category, `${item.name} should get a category proposal`).toBeTruthy();
  }
  await untouched();

  const again = await askPanel(page, `Review ${monitorName} again with AI and suggest a category for it.`);
  const monitorCategory = await proposedCategory(monitor.id);
  expect(again.toLowerCase(), "the answer names the proposed category").toContain(String(monitorCategory).toLowerCase());

  const followUp = await askPanel(page, `What category did you suggest for ${monitorName}?`);
  expect(followUp.toLowerCase()).toContain(String(monitorCategory).toLowerCase());
  expect(followUp.toLowerCase(), "no invented explanation").not.toMatch(/supersed/);

  const drillAgain = await askPanel(page, `Review ${drillName} again and suggest a category.`);
  expect(drillAgain.toLowerCase()).toContain(String(await proposedCategory(drill.id)).toLowerCase());
  await untouched();
  await page.screenshot({ path: test.info().outputPath("live-review-sequence.png"), fullPage: false });
});
