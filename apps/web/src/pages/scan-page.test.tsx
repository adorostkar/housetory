import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  models: ["gpt-4o"],
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
      data: id ? recognition : undefined,
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

beforeEach(() => {
  vi.mocked(api.post).mockReset();
  vi.mocked(api.postForm).mockReset();
  vi.mocked(api.postForm).mockResolvedValue(recognition);
  vi.mocked(api.post).mockResolvedValue(applyResult);
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/scan?location_id=box-1"]}>
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
    expect(screen.getByText(/Cloud vision/)).toBeVisible();
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
      location_id: "box-1",
      proposal: expect.objectContaining({ name: "Camera body", quantity: 1 }),
    });
    expect(await screen.findByText("Scan applied")).toBeVisible();
    expect(screen.getByText(/2 created/)).toBeVisible();
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
});
