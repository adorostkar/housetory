import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ScanPage } from "@/pages/scan-page";
import { api } from "@/lib/api";
import type { AiRecognition, AiRecognitionApplyResult, AiStatus } from "@/lib/types";

const status: AiStatus = {
  provider: "openai",
  mode: "cloud",
  source: "database",
  task: "vision",
  provider_id: "provider-1",
  provider_label: "OpenAI household",
  capabilities: ["text", "vision", "structured"],
  model: "gpt-4o",
  configured: true,
  available: true,
  catalog_checked: true,
  catalog_count: 1,
  cloud_enabled: true,
  cloud_consent: true,
  data_leaves_server: true,
  error: null,
  privacy_note: "Cloud inference can send household prompts.",
};

const recognition: AiRecognition = {
  id: "recognition-1",
  status: "succeeded",
  original_filename: "box.png",
  content_type: "image/png",
  width: 800,
  height: 600,
  result: {
    suggestions: [
      {
        name: "Camera body",
        quantity: 1,
        description: null,
        category: "Electronics",
        brand: "Acme",
        model: "C-1",
        tags: [],
        notes: null,
        confidence: 88,
        source: "vision",
        field_sources: { name: "inferred" },
      },
      {
        name: "USB-C cables",
        quantity: 3,
        description: null,
        category: "Electronics",
        brand: null,
        model: null,
        tags: [],
        notes: null,
        confidence: 74,
        source: "vision",
        field_sources: { name: "inferred" },
      },
    ],
    warnings: [],
  },
  field_sources: {},
  confidence: 88,
  error: null,
  model_provider: "openai",
  model_name: "gpt-4o",
  room_id: null,
  location_id: "box-1",
  location_label: "BOX-001",
  suggestion_duplicates: [
    {
      suggestion_index: 0,
      candidates: [
        {
          item_id: "item-camera",
          name: "Camera body",
          brand: null,
          model: null,
          serial_number: null,
          room_name: "Office",
          location_name: "BOX-001",
          purchase_date: null,
          score: 60,
          reasons: ["same name"],
        },
      ],
    },
  ],
  processing_mode: "cloud",
  processing_path: "vision",
  applied_at: null,
  applied_items: [],
  created_at: "2026-01-01T00:00:00Z",
  completed_at: "2026-01-01T00:00:01Z",
  image_url: "/api/v1/ai/recognitions/recognition-1/file",
  original_url: "/api/v1/ai/recognitions/recognition-1/original",
};

const applyResult: AiRecognitionApplyResult = {
  recognition: { ...recognition, applied_at: "2026-01-01T00:00:02Z" },
  created: 2,
  updated: 0,
  rejected: 0,
  skipped: 0,
  failed: 0,
  failures: [],
};

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useAiStatus: () => ({ data: status, isPending: false }),
    useLocations: () => ({
      data: {
        items: [
          {
            id: "box-1",
            room_id: "room-1",
            parent_id: null,
            name: "Camera gear",
            description: null,
            kind: "box",
            is_container: true,
            container_type: "box",
            identifier: "BOX-001",
            summary_headline: null,
            summary_short: null,
            label_generated_at: null,
            sort_order: 0,
            item_count: 0,
            total_item_count: 0,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
          {
            id: "shelf-2",
            room_id: "room-2",
            parent_id: null,
            name: "Garage shelf",
            description: null,
            kind: "shelf",
            is_container: false,
            container_type: null,
            identifier: "SHELF-001",
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
    useRooms: () => ({
      data: {
        items: [
          { id: "room-1", name: "Office", description: null, parent_id: null, sort_order: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
          { id: "room-2", name: "Garage", description: null, parent_id: null, sort_order: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
        ],
      },
      isPending: false,
    }),
    useItems: () => ({
      data: { pages: [{ items: [], total: 0, limit: 100, offset: 0 }], pageParams: [] },
      isPending: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      isFetchingNextPage: false,
    }),
    useInvalidateInventory: () => vi.fn(),
    useRecognition: (id: string | undefined) => ({
      data: id ? currentRecognition : undefined,
      isPending: false,
    }),
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

beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    writable: true,
    value: vi.fn(() => "blob:scan-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    writable: true,
    value: vi.fn(),
  });
});

let currentRecognition = recognition;

beforeEach(() => {
  currentRecognition = recognition;
  vi.mocked(api.post).mockReset();
  vi.mocked(api.postForm).mockReset();
  vi.mocked(api.postForm).mockImplementation(async () => currentRecognition);
  vi.mocked(api.post).mockResolvedValue(applyResult);
});

function renderPage(entry = "/scan?location_id=box-1") {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <ScanPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScanPage", () => {
  it("captures a photo, shows cloud processing mode and approves a reviewed batch", async () => {
    const { container } = renderPage();
    const cameraInput = container.querySelector<HTMLInputElement>(
      "input[capture='environment']",
    );
    expect(cameraInput).not.toBeNull();
    fireEvent.change(cameraInput as HTMLInputElement, {
      target: {
        files: [new File([new Uint8Array([1, 2, 3])], "box.png", { type: "image/png" })],
      },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Upload photograph" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Review 2 suggestions" }),
    ).toBeVisible();
    expect(screen.getByText(/Remote\/cloud · openai · gpt-4o/)).toBeVisible();
    expect(screen.getByText("Camera body")).toBeVisible();
    expect(screen.getByText("USB-C cables")).toBeVisible();
    expect(screen.getAllByLabelText("Quantity")[1]).toHaveValue(3);
    expect(screen.getByText("Possible existing items")).toBeVisible();
    expect(screen.getByText(/whole photograph is not automatically used/i)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Approve selected" }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, payload] = vi.mocked(api.post).mock.calls[0] as [
      string,
      { entries: Array<Record<string, unknown>> },
    ];
    expect(path).toBe("/ai/recognitions/recognition-1/apply");
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0]).toMatchObject({
      suggestion_index: 0,
      action: "create",
      room_id: "room-1",
      location_id: "box-1",
      proposal: expect.objectContaining({ name: "Camera body", quantity: 1 }),
    });
    expect(await screen.findByText("Scan applied")).toBeVisible();
    expect(screen.getByText(/2 created/)).toBeVisible();
  });

  it("splits and merges suggestions into reviewed records", async () => {
    const { container } = renderPage();
    const cameraInput = container.querySelector<HTMLInputElement>(
      "input[capture='environment']",
    );
    fireEvent.change(cameraInput as HTMLInputElement, {
      target: {
        files: [new File([new Uint8Array([1])], "box.png", { type: "image/png" })],
      },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Upload photograph" }),
    );
    await screen.findByRole("heading", { name: "Review 2 suggestions" });
    const cameraCard = screen
      .getByRole("heading", { name: "Camera body" })
      .closest("article") as HTMLElement;
    await userEvent.click(
      within(cameraCard).getByRole("button", { name: "Split" }),
    );
    await screen.findByRole("heading", { name: "Review 3 suggestions" });
    expect(screen.getByText(/split record/)).toBeVisible();
    const splitCard = screen
      .getByRole("heading", { name: "Camera body (split)" })
      .closest("article") as HTMLElement;
    await userEvent.click(
      within(splitCard).getByRole("button", { name: "Merge with next" }),
    );
    await screen.findByRole("heading", { name: "Review 2 suggestions" });
    expect(
      screen.getByRole("heading", { name: "Camera body (split) + USB-C cables" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Approve selected" }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, payload] = vi.mocked(api.post).mock.calls[0] as [
      string,
      { entries: Array<{ suggestion_index: number; entry_key: string }> },
    ];
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0]).toMatchObject({
      suggestion_index: 0,
      entry_key: "0",
    });
    expect(payload.entries[1]).toMatchObject({
      suggestion_index: 0,
      entry_key: "0-split-1",
    });
  });

  it("edits a suggestion quantity before approval", async () => {
    const { container } = renderPage();
    const cameraInput = container.querySelector<HTMLInputElement>(
      "input[capture='environment']",
    );
    fireEvent.change(cameraInput as HTMLInputElement, {
      target: {
        files: [new File([new Uint8Array([1])], "box.png", { type: "image/png" })],
      },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Upload photograph" }),
    );
    await screen.findByRole("heading", { name: "Review 2 suggestions" });
    const quantity = screen.getAllByLabelText("Quantity")[1] as HTMLInputElement;
    await userEvent.clear(quantity);
    await userEvent.type(quantity, "5");
    await userEvent.click(screen.getByRole("button", { name: "Approve selected" }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, payload] = vi.mocked(api.post).mock.calls[0] as [
      string,
      { entries: Array<{ proposal: { quantity: number } }> },
    ];
    expect(payload.entries[1]?.proposal.quantity).toBe(5);
  });

  it("supports a room-only destination and clears an incompatible container when room changes", async () => {
    currentRecognition = {
      ...recognition,
      room_id: "room-2",
      location_id: null,
      location_label: null,
      suggestion_duplicates: [],
      result: {
        suggestions: [recognition.result.suggestions![0]!],
        warnings: [],
      },
    };
    const { container } = renderPage("/scan?room_id=room-2");
    const cameraInput = container.querySelector<HTMLInputElement>(
      "input[capture='environment']",
    );
    fireEvent.change(cameraInput as HTMLInputElement, {
      target: {
        files: [new File([new Uint8Array([1])], "room.png", { type: "image/png" })],
      },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Upload photograph" }),
    );
    await screen.findByRole("heading", { name: "Review 1 suggestion" });
    expect(screen.getByLabelText(/Default room/)).toHaveValue("room-2");
    expect(
      screen.getByLabelText(/Default container or storage location/),
    ).toHaveValue("");

    await userEvent.selectOptions(screen.getByLabelText(/Default room/), "room-1");
    const defaultContainer = screen.getByLabelText(
      /Default container or storage location/,
    );
    expect(defaultContainer).toHaveValue("");
    await userEvent.selectOptions(defaultContainer, "box-1");
    await userEvent.click(screen.getByRole("button", { name: "Approve selected" }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, payload] = vi.mocked(api.post).mock.calls[0] as [
      string,
      { entries: Array<Record<string, unknown>> },
    ];
    expect(payload.entries[0]).toMatchObject({
      room_id: "room-1",
      location_id: "box-1",
    });
  });

  it("flags fixed fixtures, excludes them by default and allows a per-suggestion room override", async () => {
    currentRecognition = {
      ...recognition,
      room_id: "room-1",
      location_id: null,
      location_label: null,
      suggestion_duplicates: [],
      result: {
        suggestions: [
          {
            name: "Window",
            quantity: 1,
            description: null,
            category: null,
            brand: null,
            model: null,
            tags: [],
            notes: null,
            confidence: 82,
            source: "vision",
            review: true,
            review_reason:
              "Windows are fixed architectural features, not movable possessions.",
            field_sources: { name: "inferred" },
          },
          {
            name: "Portable heater",
            quantity: 1,
            description: null,
            category: null,
            brand: null,
            model: null,
            tags: [],
            notes: null,
            confidence: 80,
            source: "vision",
            review: false,
            review_reason: null,
            field_sources: { name: "inferred" },
          },
        ],
        warnings: [],
      },
    };
    const { container } = renderPage("/scan?room_id=room-1");
    const cameraInput = container.querySelector<HTMLInputElement>(
      "input[capture='environment']",
    );
    fireEvent.change(cameraInput as HTMLInputElement, {
      target: {
        files: [new File([new Uint8Array([1])], "room.png", { type: "image/png" })],
      },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Upload photograph" }),
    );
    await screen.findByRole("heading", { name: "Review 2 suggestions" });
    expect(screen.getByLabelText("Include Window")).not.toBeChecked();
    expect(screen.getByLabelText("Include Portable heater")).toBeChecked();
    expect(screen.getByText("Review")).toBeVisible();
    expect(screen.getByText(/fixed architectural features/i)).toBeVisible();
    expect(screen.getByText(/not preselected/i)).toBeVisible();

    const heaterCard = screen
      .getByRole("heading", { name: "Portable heater" })
      .closest("article") as HTMLElement;
    await userEvent.selectOptions(within(heaterCard).getByLabelText(/^Room/), "room-2");
    expect(
      within(heaterCard).getByLabelText(/Container or storage location/),
    ).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "Approve selected" }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [, payload] = vi.mocked(api.post).mock.calls[0] as [
      string,
      { entries: Array<Record<string, unknown>> },
    ];
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0]).toMatchObject({
      suggestion_index: 1,
      room_id: "room-2",
      location_id: null,
      proposal: expect.objectContaining({ name: "Portable heater" }),
    });
  });

  it("shows OCR fallback and the actionable vision reason", async () => {
    currentRecognition = {
      ...recognition,
      model_provider: null,
      model_name: null,
      processing_mode: "deterministic",
      processing_path: "ocr",
      suggestion_duplicates: [],
      result: {
        suggestions: [
          {
            ...recognition.result.suggestions![0]!,
            source: "ocr",
          },
        ],
        warnings: [
          "No vision task is configured. Choose a vision-capable provider and model under Settings → AI providers → Task defaults.",
        ],
      },
    };
    const { container } = renderPage();
    const cameraInput = container.querySelector<HTMLInputElement>(
      "input[capture='environment']",
    );
    fireEvent.change(cameraInput as HTMLInputElement, {
      target: {
        files: [new File([new Uint8Array([1])], "label.png", { type: "image/png" })],
      },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Upload photograph" }),
    );
    await screen.findByRole("heading", { name: "Review 1 suggestion" });
    expect(screen.getByText("OCR text fallback")).toBeVisible();
    expect(screen.getByText(/No vision task is configured/)).toBeVisible();
    expect(screen.queryByText(/Remote\/cloud ·/)).not.toBeInTheDocument();
  });
});

