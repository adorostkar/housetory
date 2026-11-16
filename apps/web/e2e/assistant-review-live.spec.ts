import { expect, test } from "@playwright/test";

// Real-provider check for the AI-first review. It is skipped unless LIVE_AI_E2E=1 and is
// meant for a disposable stack whose household already has a real Assistant provider
// configured (and cloud consent where needed). It makes a few paid requests.
test.skip(!process.env.LIVE_AI_E2E, "Needs a disposable stack with a real configured provider");

test("the original categorisation request is analysed by the configured model", async ({ page, request }) => {
  test.setTimeout(300_000);
  const status = await (await request.get("/api/v1/ai/status?task=assistant")).json();
  expect(status.configured, "Configure a real Assistant provider first").toBeTruthy();
  const suffix = Date.now().toString().slice(-6);
  const names = ["Cordless drill", "Stand mixer", "Camping tent", "HDMI cable", "Winter coat"];
  const ids: string[] = [];
  for (const name of names) {
    const created = await request.post("/api/v1/items", { data: { name: `${name} ${suffix}`, quantity: 1 } });
    expect(created.ok(), await created.text()).toBeTruthy();
    ids.push((await created.json()).item.id);
  }
  const untouched = async () => {
    for (const id of ids) {
      const item = (await (await request.get(`/api/v1/items/${id}`)).json()).item;
      expect(item.category).toBeNull();
      expect(item.tags).toEqual([]);
    }
  };

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/items");
  const header = page.getByRole("combobox", { name: "Search or ask about your inventory" });
  await header.fill("Review my items and suggest categories.");
  await header.press("Enter");
  const review = page.getByRole("region", { name: "Inventory review", exact: true }).last();
  // Either analysis started straight away, or a large household needs the one confirmation.
  const confirm = review.getByRole("button", { name: "Run AI analysis", exact: true });
  await expect(review.getByRole("status")).toContainText(/Analysing with AI…|Analysis finished|Local checks finished/, { timeout: 120_000 });
  if (await confirm.isVisible()) await confirm.click();
  await expect(review.getByRole("status")).toContainText("Analysis finished", { timeout: 240_000 });
  await expect(review.getByRole("status")).toContainText(/AI reviewed [1-9]/);
  await expect(review.getByRole("checkbox", { name: /Include AI suggestions/ })).toHaveCount(0);

  // Real proposals for the new items, and no inventory change from analysis alone.
  const suggestions = await (await request.get(
    `/api/v1/inventory-review/suggestions?status=pending&limit=50&item_ids=${ids.join(",")}`,
  )).json();
  const organisation = suggestions.items.filter((entry: { type: string }) => entry.type === "organisation");
  expect(organisation.length, "the model proposed categories or tags").toBeGreaterThan(0);
  console.log("LIVE suggestions:", organisation.map((entry: { title: string }) => entry.title).join(" | "));
  await untouched();
  await page.screenshot({ path: test.info().outputPath("live-review.png") });

  // A follow-up is answered from the review, in words.
  const composer = page.getByRole("textbox", { name: "Ask the Housetory assistant" });
  await composer.fill("What did you suggest for the drill?");
  await page.getByRole("button", { name: "Send question", exact: true }).click();
  const answer = page.getByLabel("Assistant tool task").last();
  await expect(answer).toHaveAttribute("data-state", /completed|awaiting_approval/, { timeout: 120_000 });
  console.log("LIVE follow-up:", await answer.getByTestId("answer-text").innerText());
  await untouched();
});
