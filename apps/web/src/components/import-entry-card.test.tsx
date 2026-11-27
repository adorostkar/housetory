import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { ImportEntryCard } from "@/components/import-entry-card";
import type { ImportDecision, ImportEntry, ProposedItem } from "@/lib/types";

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return { ...actual, useDefaultCurrency: () => "SEK" };
});

const decision: ImportDecision = { include: false, action: "import", mergeItemId: "", mergeFields: [] };

function entryOf(patch: Partial<ProposedItem>, entryPatch: Partial<ImportEntry> = {}): ImportEntry {
  return {
    id: "entry-1", source_file_id: null, source_path: "photo.png", source_excerpt: null, note_title: null,
    proposed: {
      name: "Window", description: null, quantity: 1, category: null, brand: null, model: null,
      serial_number: null, room: null, storage_location: null, purchase: null, warranty: null,
      tags: [], notes: null, collection: null, relationships: {}, field_sources: {}, confidence: null,
      ...patch,
    },
    field_sources: {}, confidence: null, status: "proposed", duplicate_candidates: [],
    duplicate_resolution: null, matched_item_id: null, imported_item_id: null, error: null, position: 0,
    ...entryPatch,
  };
}

function renderCard(entry: ImportEntry) {
  render(
    <MemoryRouter>
      <ImportEntryCard
        entry={entry}
        proposed={entry.proposed}
        decision={decision}
        rooms={[]}
        locations={[]}
        categories={[]}
        disabled={false}
        onProposedChange={() => undefined}
        onDecisionChange={() => undefined}
        onCreateRoom={async () => null}
        onCreateLocation={async () => null}
        onAdd={() => undefined}
        onSkip={() => undefined}
      />
    </MemoryRouter>,
  );
  return screen.getByRole("article", { name: entry.proposed.name });
}

describe("ImportEntryCard closed row", () => {
  it("shows the fixed-feature warning without opening the row", async () => {
    const reason = "Windows are fixed architectural features, not movable possessions.";
    const row = renderCard(entryOf(
      { relationships: { review: true, review_reason: reason } },
      { source_excerpt: reason },
    ));
    // The row is closed: its editor is not there, but its button is.
    expect(within(row).queryByLabelText("Item name")).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Add item" })).toBeEnabled();
    expect(within(row).getByText(`Check: ${reason}`)).toBeVisible();

    // Opened, the full explanation is in the editor, once.
    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));
    expect(within(row).getAllByText(/fixed architectural features/)).toHaveLength(1);
  });

  it("keeps the full reason in the editor when the source text is a caption", async () => {
    const reason = "Radiators are usually installed fixtures. Verify whether this is a fixed part of the room.";
    const row = renderCard(entryOf(
      { name: "Radiator", relationships: { review: true, review_reason: reason } },
      { source_excerpt: "things in the hall" },
    ));
    // The closed row has one short line; the rest is in the editor.
    expect(within(row).getByText("Check: Radiators are usually installed fixtures.")).toBeVisible();
    await userEvent.click(within(row).getByRole("button", { name: "Edit" }));
    expect(within(row).getByText(reason)).toBeVisible();
  });

  it("joins a new room, a guessed name and the other warnings in one line, and keeps the row's own markers", () => {
    const row = renderCard(entryOf(
      {
        name: "Lamp",
        confidence: 40,
        field_sources: { name: "inferred", quantity: "inferred" },
        room: {
          text: "Attic", entity_type: "room", status: "missing", matched_id: null, name: "Attic",
          room_id: null, parent_id: null, suggested_parent_id: null, candidates: [],
        },
      },
      {
        error: "The room is gone.",
        duplicate_candidates: [{
          item_id: "item-9", name: "Floor lamp", brand: null, model: null, serial_number: null,
          room_name: "Hall", location_name: null, purchase_date: null, score: 91, reasons: [],
        }],
      },
    ));
    expect(within(row).getByText("Check: Room “Attic” is new · Guessed, not read: name, quantity")).toBeVisible();
    expect(within(row).getByText("40% sure")).toBeVisible();
    expect(within(row).getByText("Possible duplicate")).toBeVisible();
    expect(within(row).getByText("You may already have this")).toBeVisible();
    expect(within(row).getByRole("alert")).toHaveTextContent("The room is gone.");
    expect(within(row).queryByLabelText("Item name")).not.toBeInTheDocument();
  });

  it("shows no warning line for a plain row", () => {
    const row = renderCard(entryOf({ name: "Ladder" }));
    expect(within(row).queryByText(/^Check:/)).not.toBeInTheDocument();
  });
});
