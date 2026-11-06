import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PlaceTransferDialog } from "@/components/place-transfer-dialog";
import { api } from "@/lib/api";
import type { PlaceTransferPreview, Room } from "@/lib/types";

const rooms: Room[] = [
  {
    id: "room-source",
    name: "Loft",
    description: null,
    property_id: "property-1",
    property: { id: "property-1", name: "Home", is_archived: false },
    parent_id: null,
    sort_order: 0,
    item_count: 0,
    location_count: 0,
    total_item_count: 0,
    total_location_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "room-destination",
    name: "Garage",
    description: null,
    property_id: "property-1",
    property: { id: "property-1", name: "Home", is_archived: false },
    parent_id: null,
    sort_order: 1,
    item_count: 0,
    location_count: 0,
    total_item_count: 0,
    total_location_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

let preview: PlaceTransferPreview;

function basePreview(overrides: Partial<PlaceTransferPreview> = {}): PlaceTransferPreview {
  return {
    source_kind: "location",
    source_id: "box-1",
    source_label: "BOX-001",
    source_path: ["Home", "Loft", "BOX-001"],
    destination: {
      property_id: "property-1",
      property_name: "Home",
      room_id: "room-destination",
      room_name: "Garage",
      location_id: null,
      location_name: null,
      location_identifier: null,
      path: ["Home", "Garage"],
    },
    direct_item_count: 1,
    nested_item_count: 2,
    total_item_count: 3,
    total_quantity: 8,
    archived_item_count: 1,
    on_loan_quantity: 1,
    nested_place_count: 1,
    child_room_count: 0,
    borrowed_record_count: 1,
    source_photo_count: 0,
    items_preview: [
      {
        id: "item-1",
        name: "Fairy lights",
        quantity: 2,
        is_archived: false,
        place_label: "Home / Loft / BOX-001",
        on_loan_quantity: 1,
      },
    ],
    nested_places_preview: [
      {
        id: "tray-1",
        name: "Tray",
        identifier: null,
        kind: "drawer",
        is_container: false,
        total_item_count: 2,
        total_quantity: 6,
      },
    ],
    child_rooms_preview: [],
    blockers: [],
    warnings: ["1 archived item(s) are included and will move too."],
    can_proceed: true,
    fingerprint: "fingerprint-1234567890",
    ...overrides,
  };
}

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    useRooms: () => ({ data: { items: rooms }, isPending: false }),
    useLocations: () => ({ data: { items: [] }, isPending: false }),
    useInvalidateInventory: () => vi.fn(),
    usePlaceTransferPreview: () => ({
      data: preview,
      isFetching: false,
      refetch: vi.fn(),
    }),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      post: vi.fn(async () => ({
        request_id: "request-1",
        history_event_id: "event-1",
        source_kind: "location",
        source_id: "box-1",
        source_label: "BOX-001",
        deleted: true,
        direct_items_moved: 1,
        nested_items_moved: 2,
        total_items_preserved: 3,
        total_quantity: 8,
        nested_places_moved: 1,
        child_rooms_moved: 0,
        borrowed_records_moved: 1,
        on_loan_quantity: 1,
        destination: basePreview().destination,
      })),
    },
  };
});

function renderDialog(mode: "move" | "delete" = "delete") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PlaceTransferDialog
        open
        onOpenChange={() => {}}
        source={{
          kind: "location",
          id: "box-1",
          label: "BOX-001",
          roomId: "room-source",
          propertyId: "property-1",
        }}
        mode={mode}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  preview = basePreview();
  vi.mocked(api.post).mockClear();
});

describe("PlaceTransferDialog", () => {
  it("previews counts, nested places and borrowed contents before deleting", () => {
    renderDialog();
    expect(screen.getByText(/3 items/)).toBeVisible();
    expect(screen.getByText(/8 recorded units/)).toBeVisible();
    expect(screen.getByText(/1 nested place/)).toBeVisible();
    expect(screen.getByText(/Tray/)).toBeVisible();
    expect(screen.getByText(/archived item/)).toBeVisible();
    expect(screen.getByText(/Deleting BOX-001 is permanent/)).toBeVisible();
    expect(screen.getByText(/does not promise undo/)).toBeVisible();
  });

  it("blocks confirmation when the destination is invalid", () => {
    preview = basePreview({
      can_proceed: false,
      blockers: ["Choose a destination outside the source place and its nested places."],
    });
    renderDialog();
    expect(
      screen.getByText(/Choose a destination outside the source place/),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Move contents and delete" }),
    ).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("submits the reviewed fingerprint and delete flag", async () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Destination room"),
      "room-destination",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Move contents and delete" }),
    );
    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        "/place-management/locations/box-1/transfer",
        expect.objectContaining({
          destination_room_id: "room-destination",
          destination_location_id: null,
          delete_source: true,
          expected_fingerprint: "fingerprint-1234567890",
        }),
      ),
    );
  });

  it("keeps the source when using the standalone move-contents mode", () => {
    renderDialog("move");
    expect(
      screen.getByRole("button", { name: "Move all contents" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Deleting BOX-001 is permanent/),
    ).not.toBeInTheDocument();
  });
});
