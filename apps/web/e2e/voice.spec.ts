import { expect, test } from "@playwright/test";

// Replaces the microphone with a silent Web Audio stream so the real
// MediaRecorder runs without hardware or permission prompts.
async function fakeMicrophone(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const getUserMedia = async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      return destination.stream;
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
  });
}

test("a voice note is transcribed and opens straight in the import review", async ({
  page,
}) => {
  await fakeMicrophone(page);
  let uploads = 0;
  let importBody = "";

  const transcriptionStatus = (url: URL) =>
    url.pathname.endsWith("/api/v1/ai/status") &&
    url.searchParams.get("task") === "transcription";
  await page.route(transcriptionStatus, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, configured: true, available: true },
    });
  });
  await page.route("**/api/v1/voice", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    uploads += 1;
    await route.fulfill({
      status: 201,
      json: { id: "note-1", status: "queued", transcript: null, transcript_error: null },
    });
  });
  await page.route("**/api/v1/voice/note-1", async (route) => {
    await route.fulfill({
      json: {
        id: "note-1",
        status: "transcribed",
        transcript: "One camping stove in the garage",
        transcript_error: null,
      },
    });
  });
  await page.route("**/api/v1/imports", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    importBody = route.request().postData() ?? "";
    await route.fulfill({ status: 201, json: { id: "voice-batch", entries: [] } });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.locator("aside").getByRole("button", { name: "Add items" }).click();
  const dialog = page.getByRole("dialog", { name: "Add items" });
  const textbox = dialog.getByRole("textbox", {
    name: "Describe items or paste a product link",
  });
  const mic = dialog.getByRole("button", { name: "Record voice note" });

  await textbox.fill("Chairs");
  await expect(mic).toHaveAttribute("aria-disabled", "true");
  await mic.click();
  await expect(
    dialog.locator("p", { hasText: "Voice is sent on its own — clear the box to record." }),
  ).toBeVisible();
  await textbox.fill("");

  await mic.click();
  const strip = dialog.getByRole("group", { name: "Recording voice note" });
  await expect(strip).toBeVisible();
  await strip.getByRole("button", { name: "Cancel" }).click();
  await expect(strip).toHaveCount(0);
  expect(uploads).toBe(0);

  await mic.click();
  await expect(strip).toBeVisible();
  await page.waitForTimeout(1200);
  await strip.getByRole("button", { name: "Stop" }).click();
  await expect(page).toHaveURL(/\/imports\/voice-batch$/);
  await expect(page.getByRole("dialog", { name: "Add items" })).toHaveCount(0);
  expect(uploads).toBe(1);
  expect(importBody).toContain("One camping stove in the garage");
});
