import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import type { ImportReviewDraft } from "@/lib/assistant-documents";
import type { ImportBatchDetail, ImportEntry } from "@/lib/types";
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
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
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

function renderPage({ bar = false }: { bar?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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
    (path === "/imports/batch-1" ? server : { items: [] }) as never);
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
        return { ...item, status: "skipped", proposed: {
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

