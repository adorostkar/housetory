import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, ApiError } from "@/lib/api";
import type { ImportReviewDraft } from "@/lib/assistant-documents";
import type { ImportBatchDetail, ImportEntry } from "@/lib/types";
import { writerId } from "@/lib/review-draft-store";
import { BarEditorBoundary } from "@/components/shell/bar-editor";
import { ImportDetailPage } from "@/pages/import-detail-page";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const drafts = new Map<string, ImportReviewDraft>();
vi.mock("@/lib/assistant-documents", () => ({
  useAssistantDocuments: () => ({
    getImportReviewDraft: (id: string) => drafts.get(id),
    saveImportReviewDraft: (id: string, draft: ImportReviewDraft) => drafts.set(id, draft),
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn(), put: vi.fn() } };
});

function entry(id: string, name: string, patch: Partial<ImportEntry> = {}): ImportEntry {
  return {
    id, source_file_id: null, source_path: null, source_excerpt: null, note_title: null,
    proposed: {
      name, description: null, quantity: 1, category: null, brand: null, model: null,
      serial_number: null, room: null, storage_location: null, purchase: null, warranty: null,
      tags: [], notes: null, collection: null, relationships: {}, field_sources: {}, confidence: null,
    },
    field_sources: {}, confidence: null, status: "proposed", duplicate_candidates: [],
    duplicate_resolution: null, matched_item_id: null, imported_item_id: null, error: null, position: 0,
    ...patch,
  };
}

function batchOf(entries: ImportEntry[], patch: Partial<ImportBatchDetail> = {}): ImportBatchDetail {
  return {
    id: "batch-1", title: "Garage shelf", source_type: "text", status: "review",
    original_filename: null, content_type: null, byte_size: null, error: null, warnings: [],
    total_entries: entries.length, imported_entries: 0, skipped_entries: 0, failed_entries: 0,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", completed_at: null,
    source_url: null, entry_count: entries.length, entries, files: [], vault_tree: [],
    ignored_notes: [], broken_links: [], metadata: {},
    ...patch,
  };
}

let server: ImportBatchDetail;
// Without a signed-in user there is no copy of a correction on this device.
let signedIn = false;
// Who stores a draft from this browser: the device, and the person when one is signed in.
const thisWriter = () => writerId(signedIn ? "user-1" : null);
const session = { authenticated: true, user: { id: "user-1" }, household: { id: "house-1" } };
const localCopies = () => Object.keys(localStorage).filter((key) => key.startsWith("housetory:review-draft:"));

function renderPage({ bar = false, client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
}) }: { bar?: boolean; client?: QueryClient } = {}) {
  const page = <ImportDetailPage batchId="batch-1" embedded />;
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {bar ? <BarEditorBoundary>{page}</BarEditorBoundary> : page}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const row = (name: string) => screen.getByRole("article", { name });

beforeEach(() => {
  drafts.clear();
  localStorage.clear();
  signedIn = false;
  server = batchOf([
    entry("e1", "Ladder"),
    entry("e2", "Rope"),
    entry("e3", "Drill", {
      duplicate_candidates: [{
        item_id: "item-9", name: "Cordless drill", brand: "Bosch", model: null, serial_number: "OLD-1",
        room_name: "Garage", location_name: null, purchase_date: null, score: 92, reasons: ["same name"],
      }],
      proposed: { ...entry("e3", "Drill").proposed, serial_number: "NEW-7" },
    }),
  ]);
  vi.mocked(api.get).mockReset();
  vi.mocked(api.get).mockImplementation(async (path: string) =>
    (path === "/imports/batch-1" ? server : path === "/auth/session" && signedIn ? session : { items: [] }) as never);
  // Like the server: the draft of a waiting row is kept in its proposal. The row stays
  // as it is. A row that no longer waits answers 409.
  vi.mocked(api.put).mockReset();
  vi.mocked(api.put).mockImplementation(async (path: string, body?: unknown) => {
    const id = path.split("/").at(-2)!;
    const draft = body as {
      action: string; merge_item_id: string | null; merge_fields: string[];
      edited_fields: string[]; proposed: ImportEntry["proposed"];
      expected_revision: number; writer: string;
    };
    const current = server.entries.find((item) => item.id === id);
    if (!current || !["proposed", "failed"].includes(current.status)) {
      throw new ApiError(409, "import_entry_not_pending", "This row is no longer waiting.");
    }
    const proposed = {
      ...draft.proposed,
      relationships: { ...draft.proposed.relationships, review_draft: {
        action: draft.action, merge_item_id: draft.merge_item_id, merge_fields: draft.merge_fields,
        allow_duplicate: false, edited_fields: draft.edited_fields,
      } },
    };
    // Like the server: a draft is kept when it was made on the revision the row has,
    // or when the draft the row has is from the same device. The same draft again
    // changes nothing. Anything else is a conflict, and nothing is kept.
    const revision = current.draft_revision ?? 0;
    if (JSON.stringify(proposed) === JSON.stringify(current.proposed)) return current as never;
    if (draft.expected_revision !== revision && draft.writer !== current.draft_writer) {
      throw new ApiError(409, "draft_conflict", "This row was also corrected on another device.");
    }
    server = { ...server, entries: server.entries.map((item) => item.id === id
      ? { ...item, proposed, draft_revision: revision + 1, draft_writer: draft.writer } : item) };
    return server.entries.find((item) => item.id === id) as never;
  });
  vi.mocked(api.post).mockReset();
  vi.mocked(api.post).mockImplementation(async (path: string, body?: unknown) => {
    if (path.endsWith("/restore")) {
      const id = path.split("/").at(-2)!;
      server = { ...server, status: "review", entries: server.entries.map((item) =>
        item.id === id ? { ...item, status: "proposed" } : item) };
      return server as never;
    }
    const requested = (body as { entries: Array<{ id: string; action: string; proposed: ImportEntry["proposed"] }> }).entries;
    let created = 0, skipped = 0, failed = 0, merged = 0;
    const failures: Array<{ entry_id: string; message: string }> = [];
    server = { ...server, entries: server.entries.map((item) => {
      const request = requested.find((candidate) => candidate.id === item.id);
      if (!request) return item;
      if (item.status === "imported") { skipped += 1; return item; }
      if (request.action === "skip") {
        skipped += 1;
        // Like the server: the edited proposal is kept, with the choices of the row.
        const choice = request as { merge_item_id?: string | null; merge_fields?: string[] };
        // A skip changes what is kept for the row: one revision on, from no device.
        return { ...item, status: "skipped", draft_revision: (item.draft_revision ?? 0) + 1, draft_writer: null, proposed: {
          ...request.proposed,
          relationships: { ...request.proposed.relationships, review_draft: {
            action: choice.merge_item_id ? "merge" : "import",
            merge_item_id: choice.merge_item_id ?? null,
            merge_fields: choice.merge_fields ?? [],
            allow_duplicate: false,
          } },
        } };
      }
      if (request.action === "merge") { merged += 1; return { ...item, status: "merged", matched_item_id: "item-9" }; }
      if (request.proposed.name === "Broken") {
        failed += 1;
        failures.push({ entry_id: item.id, message: "The room is gone." });
        return { ...item, status: "failed", error: "The room is gone.", proposed: request.proposed };
      }
      created += 1;
      return { ...item, status: "imported", imported_item_id: `item-${item.id}`, proposed: request.proposed };
    }) };
    return { batch: server, created, merged, skipped, rejected: 0, failed, failures } as never;
  });
});

describe("ImportDetailPage review", () => {
  it("starts with nothing selected, closed rows, no action dropdowns and a disabled bulk button", async () => {
    renderPage();
    await screen.findByRole("article", { name: "Ladder" });
    for (const box of screen.getAllByRole("checkbox")) expect(box).not.toBeChecked();
    expect(screen.queryByRole("combobox", { name: /Action for/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Item name")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add selected items" })).toBeDisabled();
    expect(screen.getByText("0 selected · 1 possible duplicate left for you to decide")).toBeVisible();
    // The duplicate comparison is shown only on the row that has one.
    expect(within(row("Drill")).getByText("You may already have this")).toBeVisible();
    expect(within(row("Ladder")).queryByText("You may already have this")).not.toBeInTheDocument();
  });

  it("names the bulk action exactly and keeps new items and updates apart", async () => {
    renderPage();
    await screen.findByRole("article", { name: "Ladder" });
    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    // Select all leaves the possible duplicate for the user.
    expect(screen.getByRole("checkbox", { name: "Select Drill" })).not.toBeChecked();
    expect(screen.getAllByRole("button", { name: "Add 2 selected items" })).toHaveLength(2);

    await userEvent.click(within(row("Drill")).getByRole("button", { name: "Update this one" }));
    // An update shows what the existing record has now and what it will get.
    expect(within(row("Drill")).getByText("OLD-1")).toBeVisible();
    expect(within(row("Drill")).getByText("NEW-7")).toBeVisible();
    expect(within(row("Drill")).getByRole("button", { name: "Apply changes" })).toBeEnabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Drill" }));
    expect(screen.getAllByRole("button", { name: "Add 2 selected items" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Apply 1 selected change" })).toHaveLength(2);

    await userEvent.click(screen.getAllByRole("button", { name: "Apply 1 selected change" })[0]!);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.post).mock.calls[0]![1]).toEqual({ entries: [
      expect.objectContaining({ id: "e3", action: "merge", merge_item_id: "item-9", merge_fields: ["serial_number"] }),
    ] });
    // The two new items are still selected and were not sent.
    expect(await screen.findAllByRole("button", { name: "Add 2 selected items" })).toHaveLength(2);
  });

  it("adds one row with its inline corrections, and an added row cannot be added again", async () => {
    renderPage();
    await screen.findByRole("article", { name: "Ladder" });
    const name = within(row("Ladder")).getByRole("textbox", { name: "Name of Ladder" });
    await userEvent.clear(name);
    await userEvent.type(name, "Step ladder");
    await userEvent.click(within(row("Step ladder")).getByRole("button", { name: "Add item" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.post).mock.calls[0]![1]).toEqual({ entries: [
      expect.objectContaining({ id: "e1", action: "import", proposed: expect.objectContaining({ name: "Step ladder" }) }),
    ] });
    const added = await screen.findByRole("article", { name: "Step ladder" });
    await waitFor(() => expect(within(added).getByText("Added")).toBeVisible());
    expect(within(added).queryByRole("button", { name: "Add item" })).not.toBeInTheDocument();
    expect(within(added).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(added).getByRole("link", { name: /Open item/ })).toHaveAttribute("href", "/items/item-e1");
  });

  it("explains a missing name beside the field and sends nothing", async () => {
    renderPage();
    await screen.findByRole("article", { name: "Rope" });
    await userEvent.clear(within(row("Rope")).getByRole("textbox", { name: "Name of Rope" }));
    await userEvent.click(within(row("Unnamed")).getByRole("button", { name: "Add item" }));
    expect(within(row("Unnamed")).getByRole("alert")).toHaveTextContent("Give this item a name.");
    expect(within(row("Unnamed")).getByRole("textbox", { name: "Name of Rope" })).toHaveAttribute("aria-invalid", "true");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("skips a row into Skipped with its edits, and restores it from there after a reload", async () => {
    const view = renderPage();
    await screen.findByRole("article", { name: "Rope" });
    const name = within(row("Rope")).getByRole("textbox", { name: "Name of Rope" });
    await userEvent.clear(name);
    await userEvent.type(name, "Climbing rope");
    await userEvent.click(within(row("Climbing rope")).getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Climbing rope" })).not.toBeInTheDocument());
    expect(vi.mocked(api.post).mock.calls[0]![1]).toEqual({ entries: [
      expect.objectContaining({ id: "e2", action: "skip", proposed: expect.objectContaining({ name: "Climbing rope" }) }),
    ] });
    expect(screen.getByText("Skipped (1)")).toBeVisible();

    // A reload has only what the server kept: the skip and the edited name.
    view.unmount();
    drafts.clear();
    renderPage();
    await userEvent.click(await screen.findByText("Skipped (1)"));
    await userEvent.click(screen.getByRole("button", { name: "Restore Climbing rope" }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith("/imports/batch-1/entries/e2/restore"));
    const restored = await screen.findByRole("article", { name: "Climbing rope" });
    expect(within(restored).getByRole("checkbox")).not.toBeChecked();
    expect(within(restored).getByRole("button", { name: "Add item" })).toBeEnabled();
    expect(screen.queryByText(/^Skipped \(/)).not.toBeInTheDocument();
  });

  it("keeps a failed row selected and editable while the saved ones are not sent again", async () => {
    server = batchOf([entry("e1", "Ladder"), entry("e2", "Broken")]);
    renderPage();
    await screen.findByRole("article", { name: "Ladder" });
    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Add 2 selected items" })[0]!);
    const failed = await screen.findByRole("article", { name: "Broken" });
    await waitFor(() => expect(within(failed).getByRole("alert")).toHaveTextContent("The room is gone."));
    expect(within(failed).getByRole("checkbox")).toBeChecked();
    expect(within(failed).getByRole("textbox", { name: "Name of Broken" })).toBeEnabled();
    expect(within(row("Ladder")).getByText("Added")).toBeVisible();

    // Trying again sends only the row that failed.
    await userEvent.click(screen.getAllByRole("button", { name: "Add 1 selected item" })[0]!);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect((vi.mocked(api.post).mock.calls[1]![1] as { entries: Array<{ id: string }> }).entries.map((item) => item.id))
      .toEqual(["e2"]);
  });
  it("brings a skipped row back after a reload with its edits and its action and target", async () => {
    const view = renderPage();
    await screen.findByRole("article", { name: "Drill" });
    // Edit the row and choose to update the existing item instead of adding a new one.
    const name = within(row("Drill")).getByRole("textbox", { name: "Name of Drill" });
    await userEvent.clear(name);
    await userEvent.type(name, "Drill 18V");
    await userEvent.click(within(row("Drill 18V")).getByRole("button", { name: "Update this one" }));
    await userEvent.click(within(row("Drill 18V")).getByRole("checkbox", { name: "Brand" }));
    await userEvent.click(within(row("Drill 18V")).getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    // The skip carries the whole draft: the edited values and the chosen target.
    expect(vi.mocked(api.post).mock.calls[0]![1]).toEqual({ entries: [expect.objectContaining({
      id: "e3", action: "skip", merge_item_id: "item-9", merge_fields: ["serial_number", "brand"],
      proposed: expect.objectContaining({ name: "Drill 18V", serial_number: "NEW-7" }),
    })] });
    await waitFor(() => expect(screen.queryByRole("article", { name: "Drill 18V" })).not.toBeInTheDocument());

    // A reload has only what the server kept.
    view.unmount();
    drafts.clear();
    renderPage();
    await userEvent.click(await screen.findByText("Skipped (1)"));
    await userEvent.click(screen.getByRole("button", { name: "Restore Drill 18V" }));
    const restored = await screen.findByRole("article", { name: "Drill 18V" });
    expect(within(restored).getByRole("button", { name: "Updating this one" })).toHaveAttribute("aria-pressed", "true");
    expect(within(restored).getByRole("checkbox", { name: "Brand" })).toBeChecked();
    expect(within(restored).getByRole("checkbox", { name: "Serial number" })).toBeChecked();
    expect(within(restored).getByText("Cordless drill", { selector: "span" }).closest("li")).toHaveTextContent("Updates: Cordless drill");
    expect(within(restored).getByText("NEW-7")).toBeVisible();

    // Applying the restored row does what was chosen before the skip.
    await userEvent.click(within(restored).getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(vi.mocked(api.post).mock.calls.at(-1)![1]).toEqual({ entries: [
      expect.objectContaining({
        id: "e3", action: "merge", merge_item_id: "item-9", merge_fields: ["serial_number", "brand"],
        proposed: expect.objectContaining({ name: "Drill 18V" }),
      }),
    ] }));
  });
});

// The bar editor takes the focus and selects the old value one frame after it opens.
async function barField() {
  const field = within(await screen.findByTestId("bar-editor")).getByRole("textbox");
  await waitFor(() => expect(field).toHaveFocus());
  return field;
}

describe("ImportDetailPage photo findings", () => {
  const region = (x: number, y: number) => ({ x, y, width: 0.2, height: 0.3 });
  const photo = (regions: Array<ImportEntry["source_region"]>) => batchOf(
    [entry("e1", "Ladder"), entry("e2", "Rope"), entry("e3", "Lamp")]
      .map((item, index) => ({ ...item, source_region: regions[index] })),
    { source_type: "image", metadata: { recognition_id: "rec-1" } },
  );
  const pins = () => screen.queryAllByRole("button", { name: /^Finding \d+: / });

  it("numbers the findings and draws pins only where the position is real", async () => {
    server = photo([region(0.1, 0.2), null, region(0.6, 0.5)]);
    renderPage();
    await screen.findByRole("article", { name: "Ladder" });
    expect(within(row("Ladder")).getByLabelText("Finding 1")).toBeVisible();
    expect(within(row("Rope")).getByLabelText("Finding 2")).toBeVisible();
    expect(within(row("Lamp")).getByLabelText("Finding 3")).toBeVisible();

    // No pin for the finding without a position, and one honest line about it.
    expect(pins().map((pin) => pin.getAttribute("aria-label"))).toEqual(["Finding 1: Ladder", "Finding 3: Lamp"]);
    expect(screen.getByText(/^1 of 3 findings is not marked on the photo/)).toBeVisible();
    // A pin sits at the centre of its region.
    expect(pins()[0]).toHaveStyle({ left: "20%", top: "35%" });
    expect(pins()[1]).toHaveStyle({ left: "70%", top: "65%" });
  });

  it("says so when no position is known, and draws no pin at all", async () => {
    server = photo([null, undefined, { x: 0.9, y: 0.2, width: 0.5, height: 0.1 }]);
    renderPage();
    await screen.findByRole("article", { name: "Ladder" });
    expect(pins()).toHaveLength(0);
    expect(screen.getByText("Positions are not available for this photo.")).toBeVisible();
    expect(screen.queryByTestId("finding-region")).not.toBeInTheDocument();
  });

  it("says nothing extra when every finding has a position, and shows no pins without a photo", async () => {
    server = photo([region(0.1, 0.1), region(0.4, 0.4), region(0.7, 0.6)]);
    const view = renderPage();
    await screen.findByRole("article", { name: "Ladder" });
    expect(pins()).toHaveLength(3);
    expect(screen.queryByText(/not marked on the photo|Positions are not available/)).not.toBeInTheDocument();

    view.unmount();
    server = batchOf([{ ...entry("e1", "Ladder"), source_region: region(0.1, 0.1) }]);
    renderPage();
    await screen.findByRole("article", { name: "Ladder" });
    expect(pins()).toHaveLength(0);
    expect(within(row("Ladder")).queryByLabelText("Finding 1")).not.toBeInTheDocument();
  });

  it("links pins and rows both ways, with the keyboard too", async () => {
    server = photo([region(0.1, 0.2), null, region(0.6, 0.5)]);
    renderPage();
    await screen.findByRole("article", { name: "Ladder" });
    const [ladderPin, lampPin] = pins();

    // A pin takes the person to its row and marks it.
    lampPin!.focus();
    await userEvent.keyboard("{Enter}");
    expect(row("Lamp")).toHaveAttribute("data-marked", "true");
    expect(row("Lamp")).toHaveFocus();
    expect(lampPin).toHaveAttribute("aria-pressed", "true");
    expect(row("Ladder")).not.toHaveAttribute("data-marked");
    expect(screen.getByTestId("finding-region")).toHaveStyle({ left: "60%", top: "50%", width: "20%", height: "30%" });

    // A row marks its pin: by pointer, by focus, and by selecting it.
    await userEvent.hover(row("Ladder"));
    expect(ladderPin).toHaveAttribute("aria-pressed", "true");
    expect(lampPin).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Lamp" }));
    expect(lampPin).toHaveAttribute("aria-pressed", "true");
    expect(row("Lamp")).toHaveAttribute("data-selected", "true");
    // A row without a position marks no pin.
    await userEvent.hover(row("Rope"));
    expect(pins().every((pin) => pin.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  it("edits a tapped value through the bar, and the row still selects, adds and skips", async () => {
    const { toast } = await import("sonner");
    server = photo([region(0.1, 0.2), null, region(0.6, 0.5)]);
    renderPage({ bar: true });
    await screen.findByRole("article", { name: "Ladder" });

    await userEvent.click(within(row("Ladder")).getByRole("button", { name: "Edit name of Ladder" }));
    const field = await barField();
    await userEvent.clear(field);
    await userEvent.keyboard("{Enter}");
    // Not valid: the editor stays, with the reason, and the draft is not changed.
    expect(within(screen.getByTestId("bar-editor")).getByRole("alert")).toHaveTextContent("Give this item a name.");
    expect(row("Ladder")).toBeVisible();
    await userEvent.type(field, "Step ladder{Enter}");
    expect(screen.queryByTestId("bar-editor")).not.toBeInTheDocument();
    // The pin of the finding follows the corrected name.
    expect(screen.getByRole("button", { name: "Finding 1: Step ladder" })).toBeVisible();

    await userEvent.click(within(row("Step ladder")).getByRole("button", { name: "Edit quantity of Step ladder" }));
    const quantity = await barField();
    await userEvent.clear(quantity);
    await userEvent.type(quantity, "2{Enter}");

    // Selection and the row's own Add still work, with the corrected values.
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Step ladder" }));
    expect(row("Step ladder")).toHaveAttribute("data-selected", "true");
    expect(screen.getAllByRole("button", { name: "Add 1 selected item" }).length).toBeGreaterThan(0);
    await userEvent.click(within(row("Step ladder")).getByRole("button", { name: "Add item" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.post).mock.calls[0]![1]).toEqual({ entries: [expect.objectContaining({
      id: "e1", action: "import", proposed: expect.objectContaining({ name: "Step ladder", quantity: 2 }),
    })] });
    await waitFor(() => expect(within(row("Step ladder")).getByText("Added")).toBeVisible());

    // Skip and Undo still work after a bar edit of another row.
    await userEvent.click(within(row("Rope")).getByRole("button", { name: "Edit name of Rope" }));
    const ropeName = await barField();
    await userEvent.clear(ropeName);
    await userEvent.type(ropeName, "Rope 30 m{Enter}");
    await userEvent.click(within(row("Rope 30 m")).getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Rope 30 m" })).not.toBeInTheDocument());
    expect(screen.getByText("Skipped (1)")).toBeVisible();
    const undo = vi.mocked(toast.success).mock.calls.at(-1)![1] as { action: { label: string; onClick: () => void } };
    expect(undo.action.label).toBe("Undo");
    undo.action.onClick();
    const back = await screen.findByRole("article", { name: "Rope 30 m" });
    expect(within(back).getByLabelText("Finding 2")).toBeVisible();
    expect(within(back).getByRole("button", { name: "Add item" })).toBeEnabled();
  });

  it("uses what is typed in the bar when Add is pressed without Enter, and keeps an earlier edit of the row", async () => {
    server = photo([region(0.1, 0.2), null, region(0.6, 0.5)]);
    renderPage({ bar: true });
    await screen.findByRole("article", { name: "Ladder" });

    // Name, then straight to the quantity without Enter: the name must not go back.
    await userEvent.click(within(row("Ladder")).getByRole("button", { name: "Edit name of Ladder" }));
    const name = await barField();
    await userEvent.clear(name);
    await userEvent.type(name, "Step ladder");
    await userEvent.click(within(row("Ladder")).getByRole("button", { name: /^Edit quantity of/ }));
    expect(row("Step ladder")).toBeVisible();
    const quantity = await barField();
    await userEvent.clear(quantity);
    await userEvent.type(quantity, "3");

    // Add while the quantity is still open in the bar.
    await userEvent.click(within(row("Step ladder")).getByRole("button", { name: "Add item" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.post).mock.calls[0]![1]).toEqual({ entries: [expect.objectContaining({
      id: "e1", proposed: expect.objectContaining({ name: "Step ladder", quantity: 3 }),
    })] });
    expect(screen.queryByTestId("bar-editor")).not.toBeInTheDocument();
  });

  it("does not add a row while the value open in the bar is not valid", async () => {
    server = photo([region(0.1, 0.2), null, region(0.6, 0.5)]);
    renderPage({ bar: true });
    await screen.findByRole("article", { name: "Ladder" });

    await userEvent.click(within(row("Ladder")).getByRole("button", { name: "Edit name of Ladder" }));
    await userEvent.clear(await barField());
    await userEvent.click(within(row("Ladder")).getByRole("button", { name: "Add item" }));

    expect(api.post).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("bar-editor")).getByRole("alert")).toHaveTextContent("Give this item a name.");
  });
});

describe("ImportDetailPage kept corrections", () => {
  afterEach(() => vi.useRealTimers());

  const draftPath = (id: string) => `/imports/batch-1/entries/${id}/draft`;
  const pass = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const type = (name: string, value: string) =>
    fireEvent.change(screen.getByRole("textbox", { name }), { target: { value } });
  // The page is loaded with real time; the clock is held only for the corrections.
  const load = async (options?: { bar?: boolean }) => {
    const view = renderPage(options);
    await screen.findByRole("article", { name: "Ladder" });
    vi.useFakeTimers();
    return view;
  };

  it("keeps a correction a short moment after the last change, in one request for the whole row", async () => {
    await load();
    await pass(2000);
    // Nothing is sent for rows that were not touched.
    expect(api.put).not.toHaveBeenCalled();

    type("Name of Ladder", "Step");
    await pass(300);
    type("Name of Step", "Step ladder");
    fireEvent.change(within(row("Step ladder")).getByRole("spinbutton"), { target: { value: "2" } });
    await pass(599);
    expect(api.put).not.toHaveBeenCalled();
    await pass(1);
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.put).mock.calls[0]).toEqual([draftPath("e1"), {
      action: "import", merge_item_id: null, merge_fields: [], edited_fields: ["name", "quantity"],
      proposed: expect.objectContaining({ name: "Step ladder", quantity: 2, serial_number: null }),
      // The revision of the row's draft that the row was built from, and this device.
      expected_revision: 0, writer: thisWriter(),
    }, undefined]);
    // The next correction is made on what the server kept.
    type("Name of Step ladder", "Tall ladder");
    await pass(600);
    expect(vi.mocked(api.put).mock.calls[1]![1]).toEqual(expect.objectContaining({ expected_revision: 1 }));
    type("Name of Tall ladder", "Step ladder");
    await pass(600);
    vi.mocked(api.put).mockClear();
    // The row is as it was: still there, not selected, with what was typed.
    expect(screen.getByRole("textbox", { name: "Name of Step ladder" })).toHaveValue("Step ladder");
    expect(screen.getByRole("checkbox", { name: "Select Step ladder" })).not.toBeChecked();
    expect(screen.queryByText(/not saved yet/)).not.toBeInTheDocument();
    const { toast } = await import("sonner");
    expect(toast.success).not.toHaveBeenCalled();

    // Selecting is not a correction. An empty name is not kept; the last real one stays.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Step ladder" }));
    await pass(2000);
    expect(api.put).not.toHaveBeenCalled();
    type("Name of Step ladder", "");
    fireEvent.change(within(row("Unnamed")).getByRole("spinbutton"), { target: { value: "3" } });
    await pass(600);
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.put).mock.calls[0]![1]).toEqual(expect.objectContaining({
      proposed: expect.objectContaining({ name: "Step ladder", quantity: 3 }),
    }));
    expect(within(row("Unnamed")).getByRole("textbox", { name: "Name of Step ladder" })).toHaveValue("");
  });

  it("keeps the action and its target, and a reload shows the row as it was corrected", async () => {
    const view = await load();
    type("Name of Drill", "Drill 18V");
    fireEvent.click(within(row("Drill 18V")).getByRole("button", { name: "Update this one" }));
    fireEvent.click(within(row("Drill 18V")).getByRole("checkbox", { name: "Brand" }));
    type("Name of Rope", "Rope 30 m");
    await pass(600);
    // One request for each row that was corrected.
    expect(vi.mocked(api.put).mock.calls.map((call) => call[0]).sort()).toEqual([draftPath("e2"), draftPath("e3")]);
    expect(vi.mocked(api.put).mock.calls.find((call) => call[0] === draftPath("e3"))![1]).toEqual(
      expect.objectContaining({
        action: "merge", merge_item_id: "item-9", merge_fields: ["serial_number", "brand"],
        proposed: expect.objectContaining({ name: "Drill 18V", serial_number: "NEW-7" }),
      }),
    );

    // A reload has only what the server kept. No Skip and no Add was pressed.
    view.unmount();
    vi.useRealTimers();
    drafts.clear();
    vi.mocked(api.put).mockClear();
    expect(server.entries.map((item) => item.status)).toEqual(["proposed", "proposed", "proposed"]);
    renderPage();
    const drill = await screen.findByRole("article", { name: "Drill 18V" });
    expect(within(drill).getByRole("button", { name: "Updating this one" })).toHaveAttribute("aria-pressed", "true");
    expect(within(drill).getByRole("checkbox", { name: "Brand" })).toBeChecked();
    expect(within(drill).getByRole("checkbox", { name: "Serial number" })).toBeChecked();
    expect(within(drill).getByRole("button", { name: "Apply changes" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Name of Rope 30 m" })).toHaveValue("Rope 30 m");
    for (const box of screen.getAllByRole("checkbox", { name: /^Select / })) expect(box).not.toBeChecked();
    // What was loaded is what the server has: nothing is sent again.
    vi.useFakeTimers();
    await pass(2000);
    expect(api.put).not.toHaveBeenCalled();

    // Applying the row does what was chosen before the reload.
    fireEvent.click(within(drill).getByRole("button", { name: "Apply changes" }));
    await pass(0);
    expect(vi.mocked(api.post).mock.calls.at(-1)![1]).toEqual({ entries: [expect.objectContaining({
      id: "e3", action: "merge", merge_item_id: "item-9", merge_fields: ["serial_number", "brand"],
      proposed: expect.objectContaining({ name: "Drill 18V" }),
    })] });
  });

  it("sends what still waits when the page is hidden or left, and when the review goes away", async () => {
    const view = await load();
    type("Name of Ladder", "Step ladder");
    window.dispatchEvent(new Event("pagehide"));
    // It does not wait for the short moment, and the request may outlive the page.
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.put).mock.calls[0]).toEqual([
      draftPath("e1"), expect.objectContaining({ proposed: expect.objectContaining({ name: "Step ladder" }) }),
      { keepalive: true },
    ]);
    await pass(2000);
    expect(api.put).toHaveBeenCalledTimes(1);

    type("Name of Rope", "Rope 30 m");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    expect(api.put).toHaveBeenCalledTimes(2);

    type("Name of Rope 30 m", "Rope 40 m");
    view.unmount();
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.put).mock.calls[2]![1]).toEqual(
      expect.objectContaining({ proposed: expect.objectContaining({ name: "Rope 40 m" }) }),
    );
    await pass(2000);
    expect(api.put).toHaveBeenCalledTimes(3);
  });

  it("says quietly when a correction could not be kept, tries again, and never blocks Add", async () => {
    const { toast } = await import("sonner");
    await load();
    vi.mocked(api.put)
      .mockRejectedValueOnce(new ApiError(0, "network_error", "Housetory can't reach the server."))
      .mockRejectedValueOnce(new ApiError(503, "request_failed", "Something went wrong."));
    type("Name of Ladder", "Step ladder");
    await pass(600);
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Your corrections are not saved yet. Trying again.")).toHaveAttribute("role", "status");
    // The draft on the page is as it was typed, and the row can still be added or skipped.
    expect(screen.getByRole("textbox", { name: "Name of Step ladder" })).toHaveValue("Step ladder");
    expect(within(row("Step ladder")).getByRole("button", { name: "Add item" })).toBeEnabled();
    expect(within(row("Step ladder")).getByRole("button", { name: "Skip" })).toBeEnabled();
    expect(toast.error).not.toHaveBeenCalled();

    // It is tried again by itself, and again when the connection returns.
    await pass(5000);
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Your corrections are not saved yet. Trying again.")).toBeVisible();
    window.dispatchEvent(new Event("online"));
    await pass(0);
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.put).mock.calls[2]![1]).toEqual(
      expect.objectContaining({ proposed: expect.objectContaining({ name: "Step ladder" }) }),
    );
    expect(screen.queryByText("Your corrections are not saved yet. Trying again.")).not.toBeInTheDocument();

    // A change of another row is also a moment to try a row that failed.
    vi.mocked(api.put).mockRejectedValueOnce(new ApiError(0, "network_error", "No connection."));
    type("Name of Step ladder", "Tall ladder");
    await pass(600);
    expect(screen.getByText("Your corrections are not saved yet. Trying again.")).toBeVisible();
    vi.mocked(api.put).mockClear();
    type("Name of Rope", "Rope 30 m");
    await pass(600);
    expect(vi.mocked(api.put).mock.calls.map((call) => call[0]).sort()).toEqual([draftPath("e1"), draftPath("e2")]);
    expect(screen.queryByText("Your corrections are not saved yet. Trying again.")).not.toBeInTheDocument();
    expect(server.entries[0]!.proposed.name).toBe("Tall ladder");
  });

  it("keeps a corrected field when the suggestions are loaded, and takes the suggestion for the rest", async () => {
    const suggestion = { ...server.entries[0]!.proposed, name: "Ladder, aluminium", brand: "Wibe" };
    server = { ...server, enhancement: {
      status: "ready", job_id: "job-1", version: "v1", reason: null, error: null, provider: "ollama",
      model: "test", ai_attempted: true, ai_succeeded: true,
      proposals: [{ entry_id: "e1", proposed: suggestion, entity_type: "item", legacy_identifier: null, source_excerpt: null }],
    } };
    const view = renderPage();
    await screen.findByRole("article", { name: "Ladder" });
    // Like the server: the suggestion goes under the draft it has kept for the row.
    vi.mocked(api.post).mockImplementationOnce(async (path) => {
      expect(path).toBe("/imports/batch-1/enhancement/accept");
      server = { ...server, enhancement: { ...server.enhancement!, status: "accepted" },
        entries: server.entries.map((item) => {
          if (item.id !== "e1") return item;
          const draft = item.proposed.relationships.review_draft as { edited_fields?: string[] } | undefined;
          const kept = Object.fromEntries((draft?.edited_fields ?? []).map((field) =>
            [field, item.proposed[field as keyof typeof item.proposed]]));
          return { ...item, proposed: { ...suggestion, ...kept,
            relationships: draft ? { review_draft: draft } : {} } };
        }) };
      return server as never;
    });
    const name = screen.getByRole("textbox", { name: "Name of Ladder" });
    await userEvent.clear(name);
    await userEvent.type(name, "Step ladder");
    // The suggestions are loaded at once, before the short moment has passed.
    await userEvent.click(screen.getByText("Review AI suggestions"));
    await userEvent.click(screen.getByRole("button", { name: "Load suggestions into review" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    // The correction that still waited was sent first, so the server could keep it.
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.put).mock.calls[0]![1]).toEqual(expect.objectContaining({
      edited_fields: ["name"], proposed: expect.objectContaining({ name: "Step ladder", brand: null }),
    }));
    expect(vi.mocked(api.put).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(api.post).mock.invocationCallOrder[0]!);
    await waitFor(() => expect(server.entries[0]!.proposed).toEqual(
      expect.objectContaining({ name: "Step ladder", brand: "Wibe" }),
    ));
    expect(await screen.findByRole("textbox", { name: "Name of Step ladder" })).toHaveValue("Step ladder");

    // A reload shows the same row, and adding it sends the person's name with the
    // suggested brand. Nothing more was sent for the row in between.
    view.unmount();
    drafts.clear();
    renderPage();
    const reloaded = await screen.findByRole("article", { name: "Step ladder" });
    await userEvent.click(within(reloaded).getByRole("button", { name: "Add item" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.post).mock.calls[1]![1]).toEqual({ entries: [expect.objectContaining({
      id: "e1", action: "import", proposed: expect.objectContaining({ name: "Step ladder", brand: "Wibe" }),
    })] });
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it("shows another device's correction of a row without a suggestion after the suggestions are loaded", async () => {
    signedIn = true;
    const suggestion = { ...server.entries[0]!.proposed, name: "Ladder, aluminium", brand: "Wibe" };
    server = { ...server, enhancement: {
      status: "ready", job_id: "job-1", version: "v1", reason: null, error: null, provider: "ollama",
      model: "test", ai_attempted: true, ai_succeeded: true,
      proposals: [{ entry_id: "e1", proposed: suggestion, entity_type: "item", legacy_identifier: null, source_excerpt: null }],
    } };
    renderPage();
    await screen.findByRole("article", { name: "Ladder" });
    // Like the server: only the row that has a suggestion is changed, one revision on.
    vi.mocked(api.post).mockImplementationOnce(async () => {
      server = { ...server, enhancement: { ...server.enhancement!, status: "accepted" },
        entries: server.entries.map((item) => item.id === "e1"
          ? { ...item, proposed: suggestion, draft_revision: (item.draft_revision ?? 0) + 1, draft_writer: null }
          : item) };
      return server as never;
    });
    // This device corrects the rope, which has no suggestion. That is saved.
    const name = screen.getByRole("textbox", { name: "Name of Rope" });
    await userEvent.clear(name);
    await userEvent.type(name, "Rope 30 m");
    await waitFor(() => expect(server.entries[1]!.proposed.name).toBe("Rope 30 m"), { timeout: 3000 });
    // Then the laptop corrects the rope too.
    correctElsewhere("e2", "Rope from the laptop");
    vi.mocked(api.put).mockClear();
    await userEvent.click(screen.getByText("Review AI suggestions"));
    await userEvent.click(screen.getByRole("button", { name: "Load suggestions into review" }));
    // The ladder takes its suggestion. The rope was not part of the suggestions,
    // so its newer revision is the laptop's: the row shows it, and the older
    // correction of this visit is not saved over it.
    expect(await screen.findByRole("article", { name: "Ladder, aluminium" })).toBeVisible();
    expect(await screen.findByRole("article", { name: "Rope from the laptop" })).toBeVisible();
    expect(screen.queryByRole("article", { name: "Rope 30 m" })).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(vi.mocked(api.put).mock.calls.filter((call) => call[0] === draftPath("e2"))).toEqual([]);
    expect(server.entries[1]!.proposed.name).toBe("Rope from the laptop");
  });

  it("shows a correction again after a reload when its request was lost, and the row still waits", async () => {
    signedIn = true;
    const kept = vi.mocked(api.put).getMockImplementation()!;
    // The request is lost, as it can be when a page is closed or reloaded just then.
    vi.mocked(api.put).mockRejectedValue(new ApiError(0, "network_error", "No connection."));
    const view = await load();
    type("Name of Ladder", "Step ladder");
    fireEvent.change(within(row("Step ladder")).getByRole("spinbutton"), { target: { value: "2" } });
    type("Name of Drill", "Drill 18V");
    fireEvent.click(within(row("Drill 18V")).getByRole("button", { name: "Update this one" }));
    // The copies are on this device before anything is sent.
    expect(api.put).not.toHaveBeenCalled();
    expect(localCopies().sort()).toEqual([
      "housetory:review-draft:v2:user-1:house-1:import:batch-1:e1",
      "housetory:review-draft:v2:user-1:house-1:import:batch-1:e3",
    ]);
    view.unmount();
    expect(server.entries.map((item) => item.proposed.name)).toEqual(["Ladder", "Rope", "Drill"]);

    // A reload: the page has nothing in memory, and the server never got the corrections.
    vi.useRealTimers();
    drafts.clear();
    vi.mocked(api.put).mockReset();
    vi.mocked(api.put).mockImplementation(kept);
    renderPage();
    const ladder = await screen.findByRole("article", { name: "Step ladder" });
    expect(within(ladder).getByRole("spinbutton")).toHaveValue(2);
    const drill = row("Drill 18V");
    expect(within(drill).getByRole("button", { name: "Updating this one" })).toHaveAttribute("aria-pressed", "true");
    // The rows still wait: nothing is selected, nothing was added or applied.
    for (const box of screen.getAllByRole("checkbox", { name: /^Select / })) expect(box).not.toBeChecked();
    expect(api.post).not.toHaveBeenCalled();
    expect(server.entries.map((item) => item.status)).toEqual(["proposed", "proposed", "proposed"]);
    // They are sent again by themselves. When the server has them, the copies go.
    await waitFor(() => expect(server.entries[0]!.proposed).toEqual(
      expect.objectContaining({ name: "Step ladder", quantity: 2 }),
    ), { timeout: 3000 });
    await waitFor(() => expect(localCopies()).toEqual([]), { timeout: 3000 });
    expect(server.entries[2]!.proposed.relationships.review_draft).toEqual(
      expect.objectContaining({ action: "merge", merge_item_id: "item-9" }),
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  // Another device corrects a row: the server keeps its draft as the next revision.
  const correctElsewhere = (id: string, name: string) => {
    server = { ...server, entries: server.entries.map((item) => item.id === id ? {
      ...item,
      draft_revision: (item.draft_revision ?? 0) + 1, draft_writer: "laptop-0123456789",
      proposed: { ...item.proposed, name, relationships: { review_draft: {
        action: "import", merge_item_id: null, merge_fields: [], allow_duplicate: false, edited_fields: ["name"],
      } } },
    } : item) };
  };
  const notice = (name: string) => within(row(name).parentElement!).getByRole("group", { name: "Two corrections" });

  it("keeps a correction of this device beside a row that another device corrected, and lets the person choose", async () => {
    signedIn = true;
    const kept = vi.mocked(api.put).getMockImplementation()!;
    vi.mocked(api.put).mockRejectedValue(new ApiError(0, "network_error", "No connection."));
    const view = await load();
    type("Name of Ladder", "Step ladder");
    fireEvent.change(within(row("Step ladder")).getByRole("spinbutton"), { target: { value: "2" } });
    type("Name of Rope", "Rope 30 m");
    type("Name of Drill", "Drill 18V");
    expect(localCopies()).toHaveLength(3);
    view.unmount();
    vi.useRealTimers();
    drafts.clear();
    vi.mocked(api.put).mockReset();
    vi.mocked(api.put).mockImplementation(kept);
    // Before this device is opened again, two of the rows are corrected on a laptop.
    correctElsewhere("e1", "Ladder from the laptop");
    correctElsewhere("e2", "Rope from the laptop");
    renderPage();
    // The rows show what the server has. The corrections of this device are not
    // lost: each waits in one plain notice beside its row.
    expect(await screen.findByRole("article", { name: "Ladder from the laptop" })).toBeVisible();
    expect(screen.queryByRole("article", { name: "Step ladder" })).not.toBeInTheDocument();
    expect(within(notice("Ladder from the laptop")).getByRole("status")).toHaveTextContent(
      "This row was also corrected on another device. Yours: «Step ladder», quantity 2.",
    );
    expect(within(notice("Rope from the laptop")).getByRole("status")).toHaveTextContent("Yours: «Rope 30 m», quantity 1.");
    // The drill was not touched anywhere else: its copy is used by itself, as before.
    expect(row("Drill 18V")).toBeVisible();
    await waitFor(() => expect(server.entries[2]!.proposed.name).toBe("Drill 18V"), { timeout: 3000 });
    await waitFor(() => expect(localCopies()).toHaveLength(2), { timeout: 3000 });
    // Nothing of the two is sent by itself, and nothing went over the laptop's rows.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(vi.mocked(api.put).mock.calls.map((call) => call[0])).toEqual([draftPath("e3")]);
    expect(server.entries.map((item) => item.proposed.name))
      .toEqual(["Ladder from the laptop", "Rope from the laptop", "Drill 18V"]);

    // "Use mine": the correction goes into the row and is saved on the revision the
    // server has now. The row still waits: not selected, nothing added.
    vi.mocked(api.put).mockClear();
    await userEvent.click(within(notice("Ladder from the laptop")).getByRole("button", { name: "Use mine" }));
    expect(within(row("Step ladder")).getByRole("spinbutton")).toHaveValue(2);
    await waitFor(() => expect(server.entries[0]!.proposed).toEqual(
      expect.objectContaining({ name: "Step ladder", quantity: 2 }),
    ), { timeout: 3000 });
    expect(vi.mocked(api.put).mock.calls).toEqual([[draftPath("e1"), expect.objectContaining({
      expected_revision: 1, writer: thisWriter(), proposed: expect.objectContaining({ name: "Step ladder" }),
    }), undefined]]);
    await waitFor(() => expect(localCopies()).toHaveLength(1), { timeout: 3000 });
    expect(within(row("Step ladder").parentElement!).queryByRole("group", { name: "Two corrections" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Step ladder" })).not.toBeChecked();

    // "Keep the other": the copy of this device is removed, and nothing is sent.
    vi.mocked(api.put).mockClear();
    await userEvent.click(within(notice("Rope from the laptop")).getByRole("button", { name: "Keep the other" }));
    expect(screen.queryByRole("group", { name: "Two corrections" })).not.toBeInTheDocument();
    expect(localCopies()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(api.put).not.toHaveBeenCalled();
    expect(server.entries[1]!.proposed.name).toBe("Rope from the laptop");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("shows the other device's row when a save meets a newer one, and never adds a correction that waits for a choice", async () => {
    signedIn = true;
    await load();
    // Both devices have the review open. The laptop saves first.
    type("Name of Ladder", "Step ladder");
    correctElsewhere("e1", "Ladder from the laptop");
    await pass(600);
    // The server kept nothing of this save. The row now shows the laptop's value,
    // with the correction of this device beside it.
    expect(vi.mocked(api.put).mock.calls).toEqual([[draftPath("e1"), expect.objectContaining({ expected_revision: 0 }), undefined]]);
    await pass(0);
    expect(row("Ladder from the laptop")).toBeVisible();
    expect(within(notice("Ladder from the laptop")).getByRole("status")).toHaveTextContent("Yours: «Step ladder», quantity 1.");
    expect(server.entries[0]!.proposed.name).toBe("Ladder from the laptop");
    expect(localCopies()).toEqual(["housetory:review-draft:v2:user-1:house-1:import:batch-1:e1"]);
    // It is not a failed save, and it is not sent again by itself.
    expect(screen.queryByText(/not saved yet/)).not.toBeInTheDocument();
    await pass(60_000);
    expect(api.put).toHaveBeenCalledTimes(1);

    // Add takes the row as it is shown. The correction that waits is not part of it.
    fireEvent.click(within(row("Ladder from the laptop")).getByRole("button", { name: "Add item" }));
    await pass(0);
    expect(vi.mocked(api.post).mock.calls.at(-1)![1]).toEqual({ entries: [expect.objectContaining({
      id: "e1", action: "import", proposed: expect.objectContaining({ name: "Ladder from the laptop" }),
    })] });
    // The row is decided, so there is nothing left to choose.
    expect(screen.queryByRole("group", { name: "Two corrections" })).not.toBeInTheDocument();
    expect(localCopies()).toEqual([]);
  });

  it("shows a row of this visit as the server has it when another device corrected it since", async () => {
    signedIn = true;
    const view = await load();
    type("Name of Ladder", "Step ladder");
    type("Name of Rope", "Rope 30 m");
    await pass(600);
    expect(localCopies()).toEqual([]);
    // The person goes to another page of the app. The laptop corrects the ladder.
    view.unmount();
    vi.useRealTimers();
    correctElsewhere("e1", "Ladder from the laptop");
    vi.mocked(api.put).mockClear();
    renderPage();
    // Everything of this device was saved before, so the laptop's row is the newer
    // one. The rope is still as it was corrected here.
    expect(await screen.findByRole("article", { name: "Ladder from the laptop" })).toBeVisible();
    expect(row("Rope 30 m")).toBeVisible();
    expect(screen.queryByRole("group", { name: "Two corrections" })).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(api.put).not.toHaveBeenCalled();
    expect(server.entries[0]!.proposed.name).toBe("Ladder from the laptop");
  });

  it("shows a row of this visit as the server has it when another device corrected, skipped and restored it", async () => {
    signedIn = true;
    const view = await load();
    type("Name of Ladder", "Step ladder");
    await pass(600);
    expect(server.entries[0]!.proposed.name).toBe("Step ladder");
    // The person goes to another page of the app. On the laptop the ladder is
    // corrected, skipped and restored. A skip leaves no writer with the row.
    view.unmount();
    vi.useRealTimers();
    correctElsewhere("e1", "Ladder from the laptop");
    server = { ...server, entries: server.entries.map((item) => item.id === "e1"
      ? { ...item, draft_revision: item.draft_revision! + 1, draft_writer: null } : item) };
    vi.mocked(api.put).mockClear();
    renderPage();
    // The row of this visit is older than what the server keeps. It is not sent
    // over it: the server's row is shown.
    expect(await screen.findByRole("article", { name: "Ladder from the laptop" })).toBeVisible();
    expect(screen.queryByRole("article", { name: "Step ladder" })).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(api.put).not.toHaveBeenCalled();
    expect(server.entries[0]!.proposed.name).toBe("Ladder from the laptop");
  });

  it("goes on from a row that this page skipped and restored, without a question", async () => {
    signedIn = true;
    await load();
    type("Name of Rope", "Rope 30 m");
    await pass(600);
    fireEvent.click(within(row("Rope 30 m")).getByRole("button", { name: "Skip" }));
    await pass(0);
    expect(server.entries[1]).toEqual(expect.objectContaining({ status: "skipped", draft_revision: 2 }));
    fireEvent.click(screen.getByText("Skipped (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Restore Rope 30 m" }));
    await pass(0);
    // The row is back as it was skipped here. The next correction is made on the
    // revision the skip left, so the server keeps it and nothing is asked.
    type("Name of Rope 30 m", "Rope 40 m");
    await pass(600);
    expect(vi.mocked(api.put).mock.calls.at(-1)![1]).toEqual(expect.objectContaining({
      expected_revision: 2, proposed: expect.objectContaining({ name: "Rope 40 m" }),
    }));
    expect(server.entries[1]!.proposed.name).toBe("Rope 40 m");
    expect(screen.queryByRole("group", { name: "Two corrections" })).not.toBeInTheDocument();
  });

  it("keeps a newer correction when an older one of this browser reached the server without an answer", async () => {
    signedIn = true;
    const kept = vi.mocked(api.put).getMockImplementation()!;
    // A slow link: the request reaches the server, but its answer never reaches the page.
    vi.mocked(api.put).mockImplementation(async (path, body) => {
      await kept(path, body);
      return new Promise(() => undefined);
    });
    const view = await load();
    type("Name of Ladder", "Step");
    await pass(600);
    expect(server.entries[0]!.proposed.name).toBe("Step");
    // The person types more. The tab dies before that is sent.
    type("Name of Step", "Step ladder");
    expect(localCopies()).toHaveLength(1);
    vi.mocked(api.put).mockImplementation(() => Promise.reject(new ApiError(0, "network_error", "No connection.")));
    view.unmount();
    expect(server.entries[0]!.proposed.name).toBe("Step");

    // The review is opened again. The server has the first correction, which this
    // browser sent itself, so the newer one is still good: it is shown and sent.
    vi.useRealTimers();
    drafts.clear();
    vi.mocked(api.put).mockReset();
    vi.mocked(api.put).mockImplementation(kept);
    renderPage();
    expect(await screen.findByRole("article", { name: "Step ladder" })).toBeVisible();
    await waitFor(() => expect(server.entries[0]!.proposed.name).toBe("Step ladder"), { timeout: 3000 });
    await waitFor(() => expect(localCopies()).toEqual([]), { timeout: 3000 });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("starts the next correction from what the server confirmed, also when the review is opened again offline", async () => {
    signedIn = true;
    const kept = vi.mocked(api.put).getMockImplementation()!;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    const view = renderPage({ client });
    await screen.findByRole("article", { name: "Ladder" });
    vi.useFakeTimers();
    type("Name of Ladder", "Step");
    await pass(600);
    expect(server.entries[0]!.proposed.name).toBe("Step");
    expect(localCopies()).toEqual([]);
    // The device goes offline. The person leaves the review and opens it again: the
    // import is not read again, and nothing can be sent.
    vi.mocked(api.put).mockImplementation(() => Promise.reject(new ApiError(0, "network_error", "No connection.")));
    view.unmount();
    vi.useRealTimers();
    renderPage({ client });
    await screen.findByRole("article", { name: "Step" });
    vi.useFakeTimers();
    type("Name of Step", "Step ladder");
    const copy = JSON.parse(localStorage.getItem(localCopies()[0]!)!) as { baseRevision: number };
    // The copy was made on the revision the server confirmed, not on the row as it was first read.
    expect(copy.baseRevision).toBe(1);
    cleanup();

    // Back online after a reload: the server still has that revision, so the copy is used.
    vi.useRealTimers();
    drafts.clear();
    vi.mocked(api.put).mockReset();
    vi.mocked(api.put).mockImplementation(kept);
    renderPage();
    expect(await screen.findByRole("article", { name: "Step ladder" })).toBeVisible();
    await waitFor(() => expect(server.entries[0]!.proposed.name).toBe("Step ladder"), { timeout: 3000 });
  });

  it("keeps the copy when Add does not go through, removes it when it does, and drops one for a decided row", async () => {
    signedIn = true;
    const added = vi.mocked(api.post).getMockImplementation()!;
    vi.mocked(api.put).mockRejectedValue(new ApiError(0, "network_error", "No connection."));
    await load();
    type("Name of Ladder", "Step ladder");
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(0, "network_error", "No connection."));
    fireEvent.click(within(row("Step ladder")).getByRole("button", { name: "Add item" }));
    await pass(0);
    // The decision failed. A reload now would still have the correction.
    expect(localCopies()).toEqual(["housetory:review-draft:v2:user-1:house-1:import:batch-1:e1"]);
    vi.mocked(api.post).mockImplementation(added);
    fireEvent.click(within(row("Step ladder")).getByRole("button", { name: "Add item" }));
    await pass(0);
    expect(within(row("Step ladder")).getByText("Added")).toBeVisible();
    expect(localCopies()).toEqual([]);

    // A copy for a row that was decided elsewhere in the meantime is not shown and is removed.
    cleanup();
    vi.useRealTimers();
    drafts.clear();
    localStorage.setItem("housetory:review-draft:v2:user-1:house-1:import:batch-1:e1", JSON.stringify({
      path: draftPath("e1"), at: Date.now(), baseRevision: 0,
      body: { action: "import", proposed: { ...server.entries[0]!.proposed, name: "Old correction" } },
    }));
    renderPage();
    await screen.findByRole("article", { name: "Step ladder" });
    expect(screen.queryByRole("article", { name: "Old correction" })).not.toBeInTheDocument();
    await waitFor(() => expect(localCopies()).toEqual([]));
  });

  it("waits a moment, without a message, when other rows of the import are being added just then", async () => {
    await load();
    vi.mocked(api.put).mockRejectedValueOnce(
      new ApiError(409, "import_busy", "Rows of this import are being added right now. Try again."),
    );
    type("Name of Rope", "Rope 30 m");
    await pass(600);
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Your corrections are not saved yet. Trying again.")).not.toBeInTheDocument();
    await pass(1000);
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(server.entries[1]!.proposed.name).toBe("Rope 30 m");
  });

  it("adds a row right after a correction with the corrected values, and the waiting draft does no harm", async () => {
    const { toast } = await import("sonner");
    await load();
    type("Name of Ladder", "Step ladder");
    fireEvent.change(within(row("Step ladder")).getByRole("spinbutton"), { target: { value: "2" } });
    fireEvent.click(within(row("Step ladder")).getByRole("button", { name: "Add item" }));
    await pass(0);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.post).mock.calls[0]![1]).toEqual({ entries: [expect.objectContaining({
      id: "e1", action: "import", proposed: expect.objectContaining({ name: "Step ladder", quantity: 2 }),
    })] });
    // The draft that waited is dropped: the row is decided.
    await pass(5000);
    expect(api.put).not.toHaveBeenCalled();
    expect(within(row("Step ladder")).getByText("Added")).toBeVisible();

    // A draft that was already on its way when the row was skipped gets 409. It is
    // ignored: no line, no message, and the skip keeps the newest values.
    type("Name of Rope", "Rope 30 m");
    await pass(600);
    expect(api.put).toHaveBeenCalledTimes(1);
    let refuse!: (error: unknown) => void;
    vi.mocked(api.put).mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    type("Name of Rope 30 m", "Rope 40 m");
    await pass(600);
    expect(api.put).toHaveBeenCalledTimes(2);
    fireEvent.click(within(row("Rope 40 m")).getByRole("button", { name: "Skip" }));
    await pass(0);
    refuse(new ApiError(409, "import_entry_not_pending", "This row is no longer waiting."));
    await pass(5000);
    expect(vi.mocked(api.post).mock.calls.at(-1)![1]).toEqual({ entries: [expect.objectContaining({
      id: "e2", action: "skip", edited_fields: ["name"],
      proposed: expect.objectContaining({ name: "Rope 40 m" }),
    })] });
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Your corrections are not saved yet. Trying again.")).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not overwrite a row that another tab corrected, and a reload shows the newest kept draft", async () => {
    const view = await load();
    // Another tab keeps a correction of Rope while this page is open.
    server = { ...server, entries: server.entries.map((item) => item.id === "e2"
      ? { ...item, proposed: { ...item.proposed, name: "Rope from the other tab" } } : item) };
    fireEvent.click(within(row("Ladder")).getByRole("button", { name: "Add item" }));
    await pass(0);
    await pass(5000);
    // This page did not change Rope, so it sends nothing for it and keeps what it shows.
    expect(vi.mocked(api.put).mock.calls).toEqual([]);
    expect(row("Rope")).toBeVisible();
    // The last write wins: a correction made here goes over the other one.
    type("Name of Drill", "Drill 18V");
    await pass(600);
    expect(vi.mocked(api.put).mock.calls.map((call) => call[0])).toEqual([draftPath("e3")]);

    view.unmount();
    vi.useRealTimers();
    drafts.clear();
    renderPage();
    expect(await screen.findByRole("article", { name: "Rope from the other tab" })).toBeVisible();
    expect(row("Drill 18V")).toBeVisible();
  });

  it("keeps the corrections of a place or container row: name, kinds, parent and old identifier", async () => {
    const node = (id: string, name: string, type: string, parent: string | null, patch: Partial<ImportEntry> = {}) =>
      entry(id, name, { entity_type: type as ImportEntry["entity_type"], parent_entry_id: parent, ...patch });
    server = batchOf([
      node("r1", "Storage", "room", null),
      node("r2", "Attic", "room", null),
      node("c1", "Box A", "container", "r1", { legacy_identifier: "STO-01" }),
      node("i1", "Cables", "item", "c1"),
    ], { metadata: { hierarchy: true } });
    const view = renderPage();
    const box = await screen.findByRole("article", { name: "Box A" });
    vi.useFakeTimers();
    fireEvent.click(within(box).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(box).getByRole("textbox", { name: "Name" }), { target: { value: "Blue box" } });
    const blue = row("Blue box");
    fireEvent.change(within(blue).getByRole("combobox", { name: "Container type" }), { target: { value: "crate" } });
    fireEvent.change(within(blue).getByRole("textbox", { name: "Legacy identifier" }), { target: { value: "BOX-9" } });
    // A new parent moves the row to another branch.
    fireEvent.change(within(blue).getByRole("combobox", { name: "Parent" }), { target: { value: "r2" } });
    await pass(600);
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.put).mock.calls[0]).toEqual([draftPath("c1"), {
      action: "import", merge_item_id: null, merge_fields: [], allow_duplicate: false,
      entity_type: "container", parent_entry_id: "r2", legacy_identifier: "BOX-9",
      edited_fields: ["name", "relationships"],
      proposed: expect.objectContaining({ name: "Blue box", relationships: { container_type: "crate" } }),
      expected_revision: 0, writer: thisWriter(),
    }, undefined]);
    fireEvent.click(within(row("Blue box")).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(row("Blue box")).getByRole("combobox", { name: "Entity type" }), { target: { value: "location" } });
    await pass(600);
    expect(vi.mocked(api.put).mock.calls[1]![1]).toEqual(expect.objectContaining({ entity_type: "location" }));

    // The mock server keeps the choices as the real one does, inside the proposal.
    server = { ...server, entries: server.entries.map((item) => item.id === "c1" ? { ...item, proposed: {
      ...item.proposed, relationships: { ...item.proposed.relationships, review_draft: {
        ...(item.proposed.relationships.review_draft as object),
        entity_type: "location", parent_entry_id: "r2", legacy_identifier: "BOX-9",
      } },
    } } : item) };
    view.unmount();
    vi.useRealTimers();
    drafts.clear();
    renderPage();
    await screen.findByRole("article", { name: "Blue box" });
    await userEvent.click(within(row("Blue box")).getByRole("button", { name: "Edit" }));
    const reloaded = row("Blue box");
    expect(within(reloaded).getByRole("combobox", { name: "Entity type" })).toHaveValue("location");
    expect(within(reloaded).getByRole("combobox", { name: "Parent" })).toHaveValue("r2");
    expect(within(reloaded).getByRole("textbox", { name: "Legacy identifier" })).toHaveValue("BOX-9");
    // The row itself was not changed on the server: it still waits as a container.
    expect(server.entries[2]).toEqual(expect.objectContaining({
      status: "proposed", entity_type: "container", parent_entry_id: "r1", legacy_identifier: "STO-01",
    }));
  });

  it("keeps a value that was changed through the bar, and the pin of a finding keeps its corrected name", async () => {
    server = batchOf(
      [entry("e1", "Ladder"), entry("e2", "Rope")].map((item, index) => ({
        ...item, source_region: { x: 0.1 + index * 0.4, y: 0.2, width: 0.2, height: 0.3 },
      })),
      { source_type: "image", metadata: { recognition_id: "rec-1" } },
    );
    const view = renderPage({ bar: true });
    await screen.findByRole("article", { name: "Ladder" });
    await userEvent.click(within(row("Ladder")).getByRole("button", { name: "Edit quantity of Ladder" }));
    const quantity = await barField();
    await userEvent.clear(quantity);
    await userEvent.type(quantity, "2{Enter}");
    await userEvent.click(within(row("Ladder")).getByRole("button", { name: "Edit name of Ladder" }));
    const name = await barField();
    await userEvent.clear(name);
    await userEvent.type(name, "Step ladder{Enter}");
    await waitFor(() => expect(api.put).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => expect(server.entries[0]!.proposed).toEqual(
      expect.objectContaining({ name: "Step ladder", quantity: 2 }),
    ), { timeout: 3000 });
    // The editor of the bar is closed by the person, not by the save.
    expect(screen.queryByTestId("bar-editor")).not.toBeInTheDocument();

    view.unmount();
    drafts.clear();
    renderPage({ bar: true });
    const reloaded = await screen.findByRole("article", { name: "Step ladder" });
    expect(within(reloaded).getByRole("button", { name: "Edit quantity of Step ladder" })).toHaveTextContent("×2");
    expect(within(reloaded).getByRole("button", { name: "Edit name of Step ladder" })).toHaveTextContent("Step ladder");
    expect(screen.getByRole("button", { name: "Finding 1: Step ladder" })).toBeVisible();
  });
});

