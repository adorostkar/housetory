import { expect, test, type APIRequestContext } from "@playwright/test";

async function createRoom(request: APIRequestContext, name: string) {
  const response = await request.post("/api/v1/rooms", { data: { name } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string };
}

async function createContainer(request: APIRequestContext, roomId: string, name: string) {
  const response = await request.post("/api/v1/containers", {
    data: { room_id: roomId, container_type: "box", name },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; name: string; identifier: string };
}

function note(roomId: string, roomName: string, boxId: string, boxName: string) {
  const locationBase = {
    identifier: null,
    status: "matched" as const,
    suggested_parent_id: null,
    candidates: [],
    create: false,
    create_kind: "box" as const,
  };
  return {
    id: "note-1",
    status: "review",
    original_filename: "voice-note.webm",
    content_type: "audio/webm",
    byte_size: 4096,
    duration_seconds: 12,
    audio_retained: false,
    default_room_id: roomId,
    default_location_id: null,
    transcript:
      "Box two has ethernet cable, ethernet cable, another ethernet cable.",
    transcript_provider: "openai",
    transcript_model: "whisper-1",
    transcript_mode: "cloud",
    transcript_error: null,
    interpretation_provider: "openai",
    interpretation_model: "gpt-4o-mini",
    interpretation_mode: "cloud",
    interpretation_error: null,
    suggestions: [
      {
        id: "suggestion-1",
        name: "Ethernet cable",
        description: null,
        quantity: 3,
        variant: null,
        category: null,
        brand: null,
        model: null,
        serial_number: null,
        tags: [],
        notes: null,
        room: {
          ...locationBase,
          text: roomName,
          entity_type: "room" as const,
          matched_id: roomId,
          name: roomName,
          room_id: roomId,
          parent_id: null,
          evidence: `in ${roomName}`,
        },
        storage_location: {
          ...locationBase,
          text: boxName,
          entity_type: "storage_location" as const,
          matched_id: boxId,
          name: boxName,
          room_id: roomId,
          parent_id: null,
          evidence: boxName,
        },
        confidence: 90,
        split_of: null,
        mention_count: 3,
        quantity_explicit: false,
        sources: [
          {
            text: "ethernet cable",
            start: 0,
            end: 15,
            role: "item" as const,
            quantity: null,
            quantity_explicit: false,
          },
        ],
        duplicate_candidates: [],
        state: "proposed",
        imported_item_id: null,
        error: null,
        warnings: [],
      },
    ],
    warnings: [],
    applied_items: [],
    applied_at: null,
    completed_at: null,
    cancelled_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:01Z",
  };
}

test("voice review groups mentions, splits a suggestion and confirms explicitly", async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString().slice(-6);
  const room = await createRoom(request, `Voice room ${suffix}`);
  const container = await createContainer(request, room.id, `VOICE-${suffix}`);
  const reviewNote = note(room.id, room.name, container.id, container.name);
  let confirmPayload: Record<string, unknown> | null = null;

  await page.route("**/api/v1/voice/note-1/confirm", async (route) => {
    confirmPayload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        note: {
          ...reviewNote,
          status: "confirmed",
          suggestions: reviewNote.suggestions.map((suggestion) => ({
            ...suggestion,
            state: "imported",
          })),
          applied_items: [
            { suggestion_id: "suggestion-1", item_id: "item-1", resolution: "new" },
            { suggestion_id: "split-1", item_id: "item-2", resolution: "new" },
          ],
        },
        created: 2,
        added_quantity: 0,
        skipped: 0,
        rejected: 0,
        failed: 0,
        failures: [],
      }),
    });
  });
  await page.route("**/api/v1/voice/note-1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reviewNote),
    });
  });

  await page.goto("/voice?note_id=note-1");
  await expect(page.getByRole("heading", { name: "Review 1 suggestion" })).toBeVisible();
  await expect(page.getByText("Combined 3 mentions")).toBeVisible();
  await expect(page.getByLabel("Quantity")).toHaveValue("3");
  await expect(page.getByText(/ethernet cable/i).first()).toBeVisible();

  await page.getByRole("button", { name: "Split one" }).click();
  await expect(page.getByRole("heading", { name: "Review 2 suggestions" })).toBeVisible();
  await expect(page.getByText(/split record/)).toBeVisible();

  await page.getByRole("button", { name: /Confirm selected \(2\)/ }).click();
  await expect(page.getByText("Voice note applied")).toBeVisible();
  expect(confirmPayload).not.toBeNull();
  const entries = (confirmPayload as { entries: Array<Record<string, unknown>> }).entries;
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({ action: "import", quantity: 2 });
  expect(entries[1]).toMatchObject({ quantity: 1, split_of: "suggestion-1" });
  await expect(page.getByText(/2 new items/)).toBeVisible();
});
