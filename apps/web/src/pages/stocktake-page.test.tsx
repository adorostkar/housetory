import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import type {
  StocktakeItem,
  StocktakeObservation,
  StocktakeReview,
  StocktakeSessionDetail,
} from "@/lib/types";
import { StocktakePage } from "@/pages/stocktake-page";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return { ...actual, useCanWrite: () => true };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
      post: vi.fn(),
    },
  };
});

const ITEM_UPDATED = "2026-11-05T09:00:00Z";

function observation(
  status: StocktakeObservation["status"],
  overrides: Partial<StocktakeObservation> = {},
): StocktakeObservation {
  return {
    id: `obs-${status}`,
    status,
    snapshot_item_id: "snap-1",
    item_id: "item-1",
    linked_item_id: null,
    counted_quantity: status === "present" ? 2 : null,
    observed_room_id: null,
    observed_location_id: null,
    observed_room_name: null,
    observed_location_name: null,
    observed_location_identifier: null,
    observed_location_path: null,
    unexpected_name: null,
    notes: null,
    owned_quantity_at_observation: 3,
    on_loan_quantity_at_observation: 1,
    at_home_quantity_at_observation: 2,
    verifier_name: "Ada Lovelace",
    observed_at: "2026-11-05T10:00:00Z",
    applied: false,
    ...overrides,
  };
}

function item(overrides: Partial<StocktakeItem> = {}): StocktakeItem {
  return {
    snapshot_item_id: "snap-1",
    item_id: "item-1",
    item_name: "Drill",
    expected_quantity: 3,
    expected_at_home_quantity: 2,
    expected_on_loan_quantity: 1,
    expected_location_path: "Workshop / BOX-001 · Gear",
    item_updated_at: ITEM_UPDATED,
    changed_since_snapshot: false,
    deleted: false,
    latest_observation: null,
    correction_applied: false,
    current: {
      exists: true,
      name: "Drill",
      quantity: 3,
      on_loan_quantity: 1,
      at_home_quantity: 2,
      room_id: "room-1",
      location_id: "loc-1",
      location_path: "Workshop / BOX-001 · Gear",
      is_archived: false,
      updated_at: ITEM_UPDATED,
      photo_thumbnail_url: null,
    },
    ...overrides,
  };
}

function session(overrides: Partial<StocktakeSessionDetail> = {}): StocktakeSessionDetail {
  return {
    id: "session-1",
    status: "in_progress",
    scope_label: "Room: Workshop",
    scope: { room_ids: ["room-1"], container_ids: [], include_descendants: true },
    snapshot_fingerprint: "snapshot-1",
    expected_item_count: 3,
    expected_unit_count: 5,
    expected_at_home_unit_count: 4,
    expected_on_loan_unit_count: 1,
    checked_item_count: 0,
    checked_unit_count: 0,
    verified_item_count: 0,
    missing_item_count: 0,
    quantity_discrepancy_count: 0,
    unknown_item_count: 0,
    unexpected_count: 0,
    coverage: {},
    partial: true,
    created_by_name: "Ada Lovelace",
    completed_by_name: null,
    started_at: "2026-11-05T08:00:00Z",
    completed_at: null,
    abandoned_at: null,
    last_refreshed_at: null,
    created_at: "2026-11-05T08:00:00Z",
    updated_at: "2026-11-05T10:00:00Z",
    items: [
      item({ latest_observation: observation("present") }),
      item({
        snapshot_item_id: "snap-2",
        item_id: "item-2",
        item_name: "Tent",
        expected_quantity: 1,
        expected_at_home_quantity: 1,
        expected_on_loan_quantity: 0,
        expected_location_path: "Workshop",
        current: {
          ...item().current,
          name: "Tent",
          quantity: 1,
          on_loan_quantity: 0,
          at_home_quantity: 1,
          location_id: null,
          location_path: "Workshop",
        },
      }),
      item({
        snapshot_item_id: "snap-3",
        item_id: "item-3",
        item_name: "Rope",
        expected_quantity: 1,
        expected_at_home_quantity: 1,
        expected_on_loan_quantity: 0,
        expected_location_path: "Workshop",
        current: {
          ...item().current,
          name: "Rope",
          quantity: 1,
          on_loan_quantity: 0,
          at_home_quantity: 1,
          location_id: null,
          location_path: "Workshop",
        },
      }),
    ],
    unexpected_findings: [],
    ...overrides,
  };
}

function review(): StocktakeReview {
  return {
    session_id: "session-1",
    fingerprint: "review-fingerprint",
    proposals: [
      {
        observation_id: "obs-moved",
        snapshot_item_id: "snap-1",
        item_id: "item-1",
        item_name: "Drill",
        status: "moved",
        action: "move",
        current_quantity: 3,
        proposed_quantity: 3,
        current_room_id: "room-1",
        current_room_name: "Workshop",
        current_location_id: "loc-1",
        current_location_name: "Gear",
        current_location_path: "Workshop / BOX-001 · Gear",
        proposed_room_id: "room-2",
        proposed_room_name: "Garage",
        proposed_location_id: "loc-2",
        proposed_location_name: "Shelf",
        proposed_location_path: "Garage / Shelf",
        on_loan_quantity: 1,
        counted_quantity: 2,
        conflict: null,
        warnings: ["1 unit(s) are on loan and remain owned; only at-home stock was counted."],
      },
    ],
    actionable_count: 1,
    conflict_count: 0,
    can_apply: true,
    checked_item_count: 2,
    expected_item_count: 3,
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/stocktake/session-1"]}>
        <Routes>
          <Route path="/stocktake/:sessionId" element={<StocktakePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

let currentSession: StocktakeSessionDetail;

beforeEach(() => {
  currentSession = session();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === "/stocktake/sessions/session-1") return currentSession;
    if (path === "/stocktake/sessions/session-1/review") return review();
    if (path === "/rooms") return { items: [] };
    if (path.startsWith("/storage-locations")) return { items: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.mocked(api.post).mockImplementation(async (path: string, body?: unknown) => {
    if (path === "/stocktake/sessions/session-1/observations") {
      const payload = body as {
        status: StocktakeObservation["status"];
        counted_quantity: number;
        expected_on_loan_quantity: number;
        snapshot_item_id: string;
      };
      const observationRecord = observation(payload.status, {
        id: `obs-${payload.snapshot_item_id}`,
        snapshot_item_id: payload.snapshot_item_id,
        counted_quantity: payload.counted_quantity,
        on_loan_quantity_at_observation: payload.expected_on_loan_quantity,
      });
      currentSession = session({
        checked_item_count: 2,
        checked_unit_count: 3,
        verified_item_count: 2,
        items: currentSession.items.map((row) =>
          row.snapshot_item_id === payload.snapshot_item_id
            ? {
                ...row,
                latest_observation: observationRecord,
                correction_applied: false,
              }
            : row,
        ),
      });
      return observationRecord;
    }
    if (path === "/stocktake/sessions/session-1/apply") {
      currentSession = session({
        checked_item_count: 2,
        checked_unit_count: 3,
        verified_item_count: 2,
        items: currentSession.items.map((row) =>
          row.snapshot_item_id === "snap-1"
            ? {
                ...row,
                correction_applied: true,
                current: {
                  ...row.current,
                  room_id: "room-2",
                  location_id: "loc-2",
                  location_path: "Garage / Shelf",
                },
              }
            : row,
        ),
      });
      return {
        application_id: "application-1",
        session: currentSession,
        applied_count: 1,
        skipped_count: 0,
        proposals: review().proposals,
        message: "Applied 1 reviewed correction.",
      };
    }
    if (path === "/stocktake/sessions/session-1/complete") {
      const payload = body as { acknowledge_partial: boolean };
      currentSession = session({
        status: "completed",
        completed_at: "2026-11-05T11:00:00Z",
        completed_by_name: "Ada Lovelace",
        checked_item_count: 2,
        checked_unit_count: 3,
        verified_item_count: 2,
        partial: payload.acknowledge_partial,
        coverage: {
          partial: true,
          checked_items: 2,
          expected_items: 3,
          checked_at_home_units: 3,
          applied_corrections: 1,
          missing_units: 0,
          note: "Partial stocktake. Only the checked items and units are verified.",
        },
      });
      return currentSession;
    }
    throw new Error(`Unexpected POST ${path}`);
  });
});

describe("StocktakePage", () => {
  it("shows explicit checklist state and records a present observation only on request", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Room: Workshop" })).toBeVisible();
    expect(screen.getAllByText(/Not checked yet/)).toHaveLength(2);
    expect(screen.getAllByText(/Opening this page does not mark it present/)).toHaveLength(2);
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^Unchecked/ }));
    await waitFor(() => expect(screen.queryByText("Drill")).not.toBeInTheDocument());

    await userEvent.click(
      screen.getByRole("button", { name: "Mark Tent present" }),
    );
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(screen.getByText("Mark as present")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Save present" }));
    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        "/stocktake/sessions/session-1/observations",
        expect.objectContaining({
          status: "present",
          snapshot_item_id: "snap-2",
          counted_quantity: 1,
          expected_on_loan_quantity: 0,
          expected_item_updated_at: ITEM_UPDATED,
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("Tent")).not.toBeInTheDocument());
    expect(screen.getByText("Rope")).toBeVisible();
  });

  it("reviews old/current/new corrections, applies atomically and completes partial coverage explicitly", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Room: Workshop" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(await screen.findByText("Review proposed corrections")).toBeVisible();
    expect(await screen.findByText("Garage / Shelf")).toBeVisible();
    expect(screen.getAllByText("Workshop / BOX-001 · Gear").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Garage / Shelf").length).toBeGreaterThan(0);
    expect(screen.getByText(/only at-home stock was counted/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Apply corrections" }));
    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        "/stocktake/sessions/session-1/apply",
        expect.objectContaining({ review_fingerprint: "review-fingerprint" }),
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(await screen.findByText("This is a partial stocktake.")).toBeVisible();
    const complete = screen.getByRole("button", { name: "Complete stocktake" });
    expect(complete).toBeDisabled();
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /I understand this records partial coverage/,
      }),
    );
    expect(complete).toBeEnabled();
    await userEvent.click(complete);
    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        "/stocktake/sessions/session-1/complete",
        expect.objectContaining({ acknowledge_partial: true }),
      ),
    );
    expect(await screen.findByText("Completed · partial")).toBeVisible();
  });
});
