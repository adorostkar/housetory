import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import type { ImportReviewDraft } from "@/lib/assistant-documents";
import type { ImportBatchDetail, ImportEntry } from "@/lib/types";
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

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ImportDetailPage batchId="batch-1" embedded />
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
      if (request.action === "skip") { skipped += 1; return { ...item, status: "skipped", proposed: request.proposed }; }
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
});
