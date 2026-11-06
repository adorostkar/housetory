import fs from "node:fs/promises";
import http from "node:http";
import { AddressInfo } from "node:net";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

let fixtureServer: http.Server;
let fixturePort = 0;
let sttRequests: Array<Record<string, unknown>> = [];
let imageRequests: Array<Record<string, unknown>> = [];

const PNG_64X48 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAaElEQVR4nNXOQREAIAzAsFKZiEAJohGxB9coyNr3UCZxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEufvwNQD/V4BtOYVtIgAAAAASUVORK5CYII=",
  "base64",
);

const AUDIO_CHAT_MODEL = {
  id: "openai/audio-chat",
  name: "Audio Chat",
  architecture: {
    input_modalities: ["text", "audio"],
    output_modalities: ["text"],
  },
  endpoints: ["/api/v1/chat/completions"],
  supported_parameters: ["temperature"],
};

const TEXT_CHAT_MODEL = {
  id: "openai/text-chat",
  name: "Text Chat",
  architecture: {
    input_modalities: ["text"],
    output_modalities: ["text"],
  },
  endpoints: ["/api/v1/chat/completions"],
  supported_parameters: ["temperature"],
};

const WHISPER_MODEL = {
  id: "openai/whisper-test",
  name: "Whisper Test",
  architecture: {
    input_modalities: ["audio"],
    output_modalities: ["transcription"],
  },
  endpoints: ["/api/v1/audio/transcriptions"],
  supported_parameters: ["temperature"],
};

const IMAGE_MODEL = {
  id: "openai/image-test",
  name: "Image Test",
  architecture: {
    input_modalities: ["text"],
    output_modalities: ["image"],
  },
  endpoints: ["/api/v1/images"],
  supported_parameters: [],
};

const IMAGE_ERROR_MODEL = {
  id: "openai/image-error",
  name: "Image Error",
  architecture: {
    input_modalities: ["text"],
    output_modalities: ["image"],
  },
  endpoints: ["/api/v1/images"],
  supported_parameters: [],
};

test.beforeAll(async () => {
  fixtureServer = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && url.pathname === "/api/v1/models") {
      const modality = url.searchParams.get("output_modalities");
      if (modality === "text") {
        response.end(
          JSON.stringify({ data: [AUDIO_CHAT_MODEL, TEXT_CHAT_MODEL] }),
        );
        return;
      }
      if (modality === "image") {
        response.end(
          JSON.stringify({ data: [IMAGE_MODEL, IMAGE_ERROR_MODEL] }),
        );
        return;
      }
      if (modality === "transcription") {
        response.end(JSON.stringify({ data: [WHISPER_MODEL] }));
        return;
      }
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/audio/transcriptions"
    ) {
      sttRequests.push(JSON.parse(bodyText || "{}") as Record<string, unknown>);
      response.end(
        JSON.stringify({
          text: "There is a cordless drill in the office.",
          usage: { seconds: 3.2, cost: 0.0001 },
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/images") {
      const body = JSON.parse(bodyText || "{}") as Record<string, unknown>;
      imageRequests.push(body);
      if (body.model === "openai/image-error") {
        response.statusCode = 400;
        response.end(
          JSON.stringify({
            error: { message: "fixture image generation failure", code: 400 },
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          created: 1748372400,
          data: [
            {
              b64_json: PNG_64X48.toString("base64"),
              media_type: "image/png",
            },
          ],
          usage: { cost: 0.01 },
        }),
      );
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/chat/completions"
    ) {
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ matches: [], warnings: [] }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
      return;
    }
    response.end(JSON.stringify({}));
  });
  await new Promise<void>((resolve) =>
    fixtureServer.listen(0, "0.0.0.0", resolve),
  );
  fixturePort = (fixtureServer.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    fixtureServer.close((error) => (error ? reject(error) : resolve())),
  );
});

function fixtureBaseUrl() {
  return `http://host.docker.internal:${fixturePort}/api/v1`;
}

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

interface SessionState {
  household: { id: string; name: string };
}

async function currentHeaders(request: APIRequestContext) {
  const response = await request.get("/api/v1/auth/session");
  const session = (await response.json()) as SessionState;
  return { "X-Household-Id": session.household.id };
}

async function resetProviders(request: APIRequestContext) {
  const settingsResponse = await request.get("/api/v1/ai/settings");
  expect(settingsResponse.ok()).toBeTruthy();
  const settings = (await settingsResponse.json()) as {
    providers: Array<{ id: string }>;
  };
  for (const provider of settings.providers) {
    const deleted = await request.delete(`/api/v1/ai/providers/${provider.id}`);
    expect(deleted.status()).toBe(204);
  }
}

async function createRoom(request: APIRequestContext, name: string) {
  const headers = await currentHeaders(request);
  const propertiesResponse = await request.get("/api/v1/properties", {
    headers,
  });
  expect(propertiesResponse.ok()).toBeTruthy();
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
  extra: Record<string, unknown> = {},
) {
  const response = await request.post("/api/v1/items", {
    headers: await currentHeaders(request),
    data: { name, room_id: roomId, ...extra },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { item: Record<string, unknown> & { id: string } };
}

async function configureTask(
  page: Page,
  providerId: string,
  taskLabel: string,
  expectedModel: string,
  forbiddenModels: string[],
) {
  const providerSelect = page.getByLabel(`${taskLabel} provider`);
  await expect(providerSelect).toBeVisible();
  await providerSelect.selectOption(providerId);
  const row = providerSelect.locator("xpath=../..");
  const picker = row.getByRole("combobox", { name: `${taskLabel} model` });
  await expect(picker).toBeEnabled();
  await picker.click();
  const list = row.getByRole("listbox");
  await expect(
    list.getByRole("option", { name: new RegExp(expectedModel) }),
  ).toBeVisible();
  for (const forbidden of forbiddenModels) {
    await expect(
      list.getByRole("option", { name: new RegExp(forbidden) }),
    ).toHaveCount(0);
  }
  await list.getByRole("option", { name: new RegExp(expectedModel) }).click();
  await row.getByRole("checkbox").check();
  await row.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`${taskLabel} updated`)).toBeVisible();
}

async function waitForTranscription(
  request: APIRequestContext,
  noteId: string,
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await request.get(`/api/v1/voice/${noteId}`);
    expect(response.ok()).toBeTruthy();
    const note = (await response.json()) as {
      status: string;
      transcript: string | null;
      transcript_error: string | null;
    };
    if (note.status === "transcribed") return note;
    if (note.status === "failed") {
      throw new Error(note.transcript_error ?? "Voice transcription failed.");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Voice transcription did not finish.");
}

test("OpenRouter audio and image models configure, transcribe and generate locally", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.setItem("housetory-theme", "light");
  });
  await fs.mkdir("../../docs/walkthrough/openrouter-media", {
    recursive: true,
  });
  await resetProviders(request);
  const providerResponse = await request.post("/api/v1/ai/providers", {
    data: {
      provider: "openrouter",
      display_name: "OpenRouter media fixture",
      base_url: fixtureBaseUrl(),
      default_model: null,
      api_key: "sk-or-e2e-fixture-not-real",
      enabled: true,
      cloud_consent: true,
    },
  });
  expect(providerResponse.ok()).toBeTruthy();
  const provider = (await providerResponse.json()) as { id: string };
  const modelsResponse = await request.get(
    `/api/v1/ai/providers/${provider.id}/models`,
  );
  expect(modelsResponse.ok()).toBeTruthy();
  const discovered = (await modelsResponse.json()) as {
    models: Array<{ id: string; kind: string; capabilities: string[] }>;
  };
  expect(
    discovered.models.find((model) => model.id === "openai/whisper-test"),
  ).toMatchObject({ kind: "speech" });
  expect(
    discovered.models.find((model) => model.id === "openai/image-test"),
  ).toMatchObject({ kind: "image" });

  await page.goto("/settings/ai");
  await expect(
    page.getByRole("heading", { name: "AI providers", level: 1 }),
  ).toBeVisible();
  await configureTask(
    page,
    provider.id,
    "Voice transcription",
    "Whisper Test",
    ["Image Test", "Text Chat"],
  );
  await configureTask(
    page,
    provider.id,
    "Item illustrations",
    "Image Test",
    ["Whisper Test", "Audio Chat", "Text Chat"],
  );
  await expect(page.getByText("Item illustrations updated")).toHaveCount(0, {
    timeout: 7_000,
  });
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.getByText("Task defaults", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "../../docs/walkthrough/openrouter-media/01-settings-light.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  const room = await createRoom(request, `OpenRouter media room ${suffix()}`);
  const item = await createItem(
    request,
    `Cordless drill ${suffix()}`,
    room.id,
    { description: "Cordless drill in a case" },
  );

  const voiceResponse = await request.post("/api/v1/voice", {
    multipart: {
      file: {
        name: "synthetic-note.webm",
        mimeType: "audio/webm",
        buffer: Buffer.concat([
          Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
          Buffer.alloc(512),
        ]),
      },
      duration_seconds: "3",
    },
  });
  expect(voiceResponse.ok(), await voiceResponse.text()).toBeTruthy();
  const voiceNote = (await voiceResponse.json()) as { id: string };
  const transcribed = await waitForTranscription(request, voiceNote.id);
  expect(transcribed.transcript).toBe(
    "There is a cordless drill in the office.",
  );
  expect(sttRequests.length).toBeGreaterThan(0);
  const sttRequest = sttRequests.at(-1)!;
  expect(sttRequest["model"]).toBe("openai/whisper-test");
  const inputAudio = sttRequest["input_audio"] as Record<string, unknown>;
  expect(inputAudio["format"]).toBe("webm");
  expect(String(inputAudio["data"]).startsWith("data:")).toBeFalsy();
  expect(inputAudio["data"]).toBeTruthy();

  await page.goto(`/voice?note_id=${voiceNote.id}`);
  await expect(page.getByLabel("Editable voice transcript")).toHaveValue(
    "There is a cordless drill in the office.",
  );
  await page.screenshot({
    path: "../../docs/walkthrough/openrouter-media/02-voice-transcript-light.png",
    fullPage: false,
  });

  await page.goto(`/items/${item.item.id}`);
  await expect(page.getByRole("button", { name: "Generate illustration" })).toBeEnabled();
  await page.getByRole("button", { name: "Generate illustration" }).click();
  await expect(page.getByText("AI illustration preview")).toBeVisible();
  await page.screenshot({
    path: "../../docs/walkthrough/openrouter-media/03-image-preview-light.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await expect(page.getByText("AI illustration").first()).toBeVisible();
  await expect(page.getByText(/not a photo/).first()).toBeVisible();
  expect(imageRequests.length).toBeGreaterThan(0);
  expect(imageRequests.at(-1)?.["model"]).toBe("openai/image-test");
  await page.getByRole("button", { name: "Switch to dark mode" }).first().click();
  await page.locator("html.dark").waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({
    path: "../../docs/walkthrough/openrouter-media/04-image-accepted-dark.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "Switch to light mode" }).first().click();

  const errorTask = await request.put("/api/v1/ai/tasks/item_images", {
    data: {
      provider_id: provider.id,
      model: "openai/image-error",
      enabled: true,
    },
  });
  expect(errorTask.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: "Generate illustration" }).click();
  await expect(
    page.getByText(/did not return a usable image|HTTP 400/).first(),
  ).toBeVisible();
  const restored = await request.put("/api/v1/ai/tasks/item_images", {
    data: {
      provider_id: provider.id,
      model: "openai/image-test",
      enabled: true,
    },
  });
  expect(restored.ok()).toBeTruthy();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/ai");
  await expect(
    page.getByRole("heading", { name: "AI providers", level: 1 }),
  ).toBeVisible();
  await page.getByText("Voice transcription", { exact: true }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "../../docs/walkthrough/openrouter-media/05-settings-mobile.png",
    fullPage: false,
  });
  await resetProviders(request);
});
