import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import type {
  AiStatus,
  VoiceApplyResult,
  VoiceConfig,
  VoiceNote,
  VoiceSuggestion,
} from "@/lib/types";
import { VoicePage } from "@/pages/voice-page";

const voiceStatus: AiStatus = {
  provider: "openai",
  mode: "cloud",
  source: "database",
  task: "transcription",
  provider_id: "provider-1",
  provider_label: "OpenAI household",
  capabilities: ["text", "audio"],
  model: "whisper-1",
  configured: true,
  available: true,
  catalog_checked: true,
  catalog_count: 1,
  cloud_enabled: true,
  cloud_consent: true,
  data_leaves_server: true,
  error: null,
  privacy_note: "Cloud inference can send household data.",
};

const config: VoiceConfig = {
  transcription_configured: true,
  max_duration_seconds: 120,
  max_upload_mb: 15,
  supported_formats: ["WebM", "Ogg", "WAV", "MP3", "M4A"],
  retention_note: "Audio is deleted after a successful transcript or cancellation.",
};

const suggestion: VoiceSuggestion = {
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
    text: "Office",
    entity_type: "room",
    identifier: null,
    status: "matched",
    matched_id: "room-1",
    name: "Office",
    room_id: "room-1",
    parent_id: null,
    suggested_parent_id: null,
    candidates: [],
    evidence: "in the office",
    create: false,
    create_kind: "box",
  },
  storage_location: {
    text: "Box 2",
    entity_type: "storage_location",
    identifier: null,
    status: "matched",
    matched_id: "box-2",
    name: "Box 2",
    room_id: "room-1",
    parent_id: null,
    suggested_parent_id: null,
    candidates: [],
    evidence: "box two",
    create: false,
    create_kind: "box",
  },
  confidence: 88,
  split_of: null,
  mention_count: 3,
  quantity_explicit: false,
  sources: [
    { text: "ethernet cable", start: 0, end: 15, role: "item", quantity: null, quantity_explicit: false },
    { text: "ethernet cable", start: 17, end: 32, role: "item", quantity: null, quantity_explicit: false },
    { text: "another ethernet cable", start: 34, end: 57, role: "item", quantity: null, quantity_explicit: false },
  ],
  duplicate_candidates: [],
  state: "proposed",
  imported_item_id: null,
  error: null,
  warnings: [],
};

const note: VoiceNote = {
  id: "note-1",
  status: "review",
  original_filename: "voice-note.webm",
  content_type: "audio/webm",
  byte_size: 5000,
  duration_seconds: 12,
  audio_retained: false,
  default_room_id: "room-1",
  default_location_id: null,
  transcript: "Box two has ethernet cable, ethernet cable, another ethernet cable.",
  transcript_provider: "openai",
  transcript_model: "whisper-1",
  transcript_mode: "cloud",
  transcript_error: null,
  interpretation_provider: "openai",
  interpretation_model: "gpt-4o-mini",
  interpretation_mode: "cloud",
  interpretation_error: null,
  suggestions: [suggestion],
  warnings: [],
  applied_items: [],
  applied_at: null,
  completed_at: null,
  cancelled_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:01Z",
};

const applyResult: VoiceApplyResult = {
  note: {
    ...note,
    status: "confirmed",
    suggestions: note.suggestions.map((entry) => ({ ...entry, state: "imported" })),
    applied_items: [
      { suggestion_id: "suggestion-1", item_id: "item-1", resolution: "new" },
    ],
  },
  created: 2,
  added_quantity: 0,
  skipped: 0,
  rejected: 0,
  failed: 0,
  failures: [],
};

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

let transcriptionConfigured = true;

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useVoiceConfig: () => ({ data: config, isPending: false }),
    useAiStatus: (task: string) => ({
      data:
        task === "transcription" && !transcriptionConfigured
          ? {
              ...voiceStatus,
              configured: false,
              error: "No transcription task is configured.",
            }
          : voiceStatus,
      isPending: false,
    }),
    useRooms: () => ({
      data: {
        items: [
          {
            id: "room-1",
            name: "Office",
            description: null,
            parent_id: null,
            sort_order: 0,
            item_count: 0,
            location_count: 0,
            total_item_count: 0,
            total_location_count: 0,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
      isPending: false,
    }),
    useLocations: () => ({
      data: {
        items: [
          {
            id: "box-2",
            room_id: "room-1",
            parent_id: null,
            name: "Box 2",
            description: null,
            kind: "box",
            is_container: true,
            container_type: "box",
            identifier: "BOX-002",
            summary_headline: null,
            summary_short: null,
            label_generated_at: null,
            sort_order: 0,
            item_count: 0,
            total_item_count: 0,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
      isPending: false,
    }),
    useVoiceNote: (noteId?: string) => ({
      data: noteId ? note : undefined,
      isPending: false,
      isError: false,
      error: null,
    }),
    useInvalidateInventory: () => vi.fn(),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      post: vi.fn(),
      postForm: vi.fn(),
    },
  };
});

beforeEach(() => {
  transcriptionConfigured = true;
  vi.mocked(api.post).mockReset();
  vi.mocked(api.postForm).mockReset();
  vi.mocked(api.post).mockResolvedValue(applyResult);
});

function renderPage(entry = "/voice?note_id=note-1") {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <VoicePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("VoicePage", () => {
  it("shows grouped quantities, splits them and confirms only reviewed entries", async () => {
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "Review 1 suggestion" }),
    ).toBeVisible();
    expect(screen.getByText("Combined 3 mentions")).toBeVisible();
    expect(screen.getByLabelText("Quantity")).toHaveValue(3);

    await userEvent.click(screen.getByRole("button", { name: "Split one" }));
    await screen.findByRole("heading", { name: "Review 2 suggestions" });
    expect(screen.getByText(/split record/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /Confirm selected \(2\)/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, payload] = vi.mocked(api.post).mock.calls[0] as [
      string,
      { entries: Array<Record<string, unknown>> },
    ];
    expect(path).toBe("/voice/note-1/confirm");
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0]).toMatchObject({
      action: "import",
      quantity: 2,
      room: expect.objectContaining({ matched_id: "room-1" }),
      storage_location: expect.objectContaining({ matched_id: "box-2" }),
    });
    expect(payload.entries[1]).toMatchObject({
      quantity: 1,
      split_of: "suggestion-1",
    });
  });

  it("shows a clear setup state when transcription is not configured", () => {
    transcriptionConfigured = false;
    renderPage("/voice");
    expect(screen.getByText("Voice transcription is not configured.")).toBeVisible();
    expect(screen.getByRole("button", { name: /Start recording/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Upload audio/ })).toBeDisabled();
    expect(screen.getByText(/No transcription task is configured/)).toBeVisible();
  });
});
