import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { HierarchyReview } from "@/components/hierarchy-review";
import type {
  ImportDecision,
  ImportEntry,
  ImportEntityType,
  ProposedItem,
} from "@/lib/types";

function proposed(name: string, quantity = 1): ProposedItem {
  return {
    name,
    description: null,
    quantity,
    category: null,
    brand: null,
    model: null,
    serial_number: null,
    room: null,
    storage_location: null,
    purchase: null,
    warranty: null,
    tags: [],
    notes: null,
    collection: null,
    relationships: {},
    field_sources: { name: "explicit" },
    confidence: 92,
  };
}

function entry(
  id: string,
  name: string,
  type: ImportEntityType,
  parent: string | null,
  position: number,
  extra: Partial<ImportEntry> = {},
): ImportEntry {
  return {
    id,
    source_file_id: null,
    source_path: "Home Inventory.md",
    source_excerpt: `#### ${name}`,
    note_title: "Home Inventory",
    proposed: proposed(name, type === "item" ? 2 : 1),
    field_sources: { name: "explicit" },
    confidence: 92,
    status: "proposed",
    duplicate_candidates: [],
    duplicate_resolution: null,
    matched_item_id: null,
    imported_item_id: null,
    entity_type: type,
    parent_entry_id: parent,
    created_room_id: null,
    created_location_id: null,
    legacy_identifier: type === "container" ? name.toUpperCase().replace(" ", "-") : null,
    error: null,
    position,
    ...extra,
  };
}

const entries = [
  entry("storage", "Storage", "room", null, 0),
  entry("room", "Storage room 2", "room", "storage", 1),
  entry("sto03", "STO-03", "container", "room", 2),
  entry("keyboards", "Keyboards", "item", "sto03", 3),
  entry("cables", "Ethernet cables", "item", "sto03", 4, {
    duplicate_candidates: [
      {
        item_id: "existing-cable",
        name: "Ethernet cables",
        brand: null,
        model: null,
        serial_number: null,
        room_name: "Storage room 2",
        location_name: "STO-03",
        purchase_date: null,
        score: 60,
        reasons: ["same name"],
      },
    ],
  }),
];

function Harness({ onDecisionSpy }: { onDecisionSpy?: (id: string, decision: ImportDecision) => void }) {
  const [edits, setEdits] = React.useState<Record<string, ProposedItem>>({});
  const [decisions, setDecisions] = React.useState<Record<string, ImportDecision>>(
    Object.fromEntries(
      entries.map((item) => [
        item.id,
        { include: false, action: "import", mergeItemId: "", mergeFields: [] },
      ]),
    ),
  );
  return (
    <HierarchyReview
      entries={entries}
      edits={edits}
      decisions={decisions}
      disabled={false}
      onEdit={(id, value) => setEdits((current) => ({ ...current, [id]: value }))}
      onDecision={(id, value) => {
        onDecisionSpy?.(id, value);
        setDecisions((current) => ({ ...current, [id]: value }));
      }}
    />
  );
}

describe("HierarchyReview", () => {
  it("renders a tree, collapses branches and approves a whole branch", async () => {
    const onDecision = vi.fn();
    render(<Harness onDecisionSpy={onDecision} />);
    expect(screen.getByRole("heading", { name: "Storage" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "STO-03" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Keyboards" })).toBeVisible();

    const storage = screen.getByRole("heading", { name: "Storage" }).closest("article");
    expect(storage).not.toBeNull();
    await userEvent.click(
      within(storage as HTMLElement).getByRole("button", { name: "Collapse branch" }),
    );
    expect(screen.queryByRole("heading", { name: "STO-03" })).not.toBeInTheDocument();

    await userEvent.click(
      within(storage as HTMLElement).getByRole("button", { name: "Expand branch" }),
    );
    const sto03 = screen.getByRole("heading", { name: "STO-03" }).closest("article");
    expect(sto03).not.toBeNull();
    await userEvent.click(within(sto03 as HTMLElement).getByRole("button", { name: /Branch/ }));
    const changed = new Set(onDecision.mock.calls.map(([id]) => id));
    expect(changed).toEqual(
      new Set(["storage", "room", "sto03", "keyboards", "cables"]),
    );
  });

  it("shows duplicate warnings, source references and edits entity type and parent", async () => {
    const onDecision = vi.fn();
    render(<Harness onDecisionSpy={onDecision} />);
    expect(screen.getByText("Possible duplicate")).toBeVisible();
    expect(screen.getByText("Existing item may match")).toBeVisible();

    const sto03 = screen.getByRole("heading", { name: "STO-03" }).closest("article");
    await userEvent.click(within(sto03 as HTMLElement).getByRole("button", { name: "Edit" }));
    await userEvent.selectOptions(
      within(sto03 as HTMLElement).getByLabelText("Entity type"),
      "location",
    );
    await userEvent.selectOptions(
      within(sto03 as HTMLElement).getByLabelText("Parent"),
      "storage",
    );
    const last = onDecision.mock.calls.at(-1);
    expect(last?.[1]).toMatchObject({
      entityType: "location",
      parentEntryId: "storage",
    });
    const reference = within(sto03 as HTMLElement).getByText("Source reference");
    expect(reference.closest("details")?.textContent).toContain("#### STO-03");
  });
});
