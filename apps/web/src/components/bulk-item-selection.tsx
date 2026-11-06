import {
  Download,
  FolderTree,
  ImagePlus,
  MoveRight,
  Tags,
  X,
} from "lucide-react";
import * as React from "react";

import {
  BulkCategoryDialog,
  BulkMoveDialog,
  BulkTagDialog,
} from "@/components/bulk-organise-dialogs";
import { BulkImagesDialog } from "@/components/bulk-images-dialog";
import { EvidenceExportDialog } from "@/components/evidence-export-dialog";
import { Button } from "@/components/ui/button";
import type { ItemSummary } from "@/lib/types";
import { pluralize } from "@/lib/utils";

export interface BulkSelection {
  selected: Set<string>;
  selectedItems: ItemSummary[];
  selectableItems: ItemSummary[];
  selectedUnits: number;
  selectedOnLoan: number;
  hasArchivedSelection: boolean;
  allLoadedSelected: boolean;
  someLoadedSelected: boolean;
  selectAllRef: React.RefObject<HTMLInputElement | null>;
  notice: string | null;
  showNotice: (message: string | null) => void;
  dismissNotice: () => void;
  toggleItem: (itemId: string) => void;
  toggleAllLoaded: () => void;
  clearSelection: (message?: string) => void;
}

export function useBulkSelection({
  items,
  enabled,
  scopeKey,
}: {
  items: ItemSummary[];
  enabled: boolean;
  scopeKey: string;
}): BulkSelection {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [notice, setNotice] = React.useState<string | null>(null);
  const previousScope = React.useRef(scopeKey);
  const selectedRef = React.useRef(selected);
  selectedRef.current = selected;
  const selectAllRef = React.useRef<HTMLInputElement | null>(null);
  const loadedIdsKey = items.map((item) => item.id).join("|");

  React.useEffect(() => {
    if (previousScope.current === scopeKey) return;
    previousScope.current = scopeKey;
    const hadSelection = selectedRef.current.size > 0;
    setSelected(new Set());
    if (hadSelection) setNotice("Selection cleared because the view changed.");
  }, [scopeKey]);

  React.useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current;
      const loaded = new Set(loadedIdsKey.split("|").filter(Boolean));
      const next = new Set([...current].filter((id) => loaded.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [loadedIdsKey]);

  const selectableItems = items.filter((item) => !item.is_archived);
  const selectedItems = items.filter((item) => selected.has(item.id));
  const allLoadedSelected =
    selectableItems.length > 0 &&
    selectableItems.every((item) => selected.has(item.id));
  const someLoadedSelected = selectableItems.some((item) => selected.has(item.id));
  const selectedUnits = selectedItems.reduce((sum, item) => sum + item.quantity, 0);
  const selectedOnLoan = selectedItems.reduce(
    (sum, item) => sum + (item.on_loan_quantity ?? 0),
    0,
  );
  const hasArchivedSelection = selectedItems.some((item) => item.is_archived);

  React.useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        someLoadedSelected && !allLoadedSelected;
    }
  }, [someLoadedSelected, allLoadedSelected]);

  const clearSelection = (message?: string) => {
    setSelected(new Set());
    if (message && selectedRef.current.size > 0) setNotice(message);
  };

  const toggleItem = (itemId: string) => {
    if (!enabled) return;
    const item = items.find((entry) => entry.id === itemId);
    if (!item || item.is_archived) return;
    setNotice(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const toggleAllLoaded = () => {
    if (!enabled) return;
    setNotice(null);
    setSelected((current) => {
      if (selectableItems.every((item) => current.has(item.id))) {
        return new Set();
      }
      return new Set(selectableItems.map((item) => item.id));
    });
  };

  return {
    selected,
    selectedItems,
    selectableItems,
    selectedUnits,
    selectedOnLoan,
    hasArchivedSelection,
    allLoadedSelected,
    someLoadedSelected,
    selectAllRef,
    notice,
    showNotice: setNotice,
    dismissNotice: () => setNotice(null),
    toggleItem,
    toggleAllLoaded,
    clearSelection,
  };
}

export function BulkSelectionControls({
  selection,
  showing,
  total,
}: {
  selection: BulkSelection;
  showing: number;
  total: number;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[0.74rem] text-muted-foreground">
      {selection.selectableItems.length > 0 && (
        <label className="flex min-w-0 items-center gap-2">
          <input
            ref={selection.selectAllRef}
            type="checkbox"
            className="size-4 accent-primary"
            checked={selection.allLoadedSelected}
            onChange={selection.toggleAllLoaded}
            aria-label="Select all loaded items"
          />
          <span>Select all loaded ({selection.selectableItems.length})</span>
        </label>
      )}
      <span aria-hidden>·</span>
      <span>
        Showing {showing} of {total}
        {showing < total ? "; only loaded items can be selected" : ""}
      </span>
    </div>
  );
}

export function BulkSelectionNotice({ selection }: { selection: BulkSelection }) {
  if (!selection.notice) return null;
  return (
    <div
      className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-border/70 bg-secondary/25 px-3.5 py-2.5 text-[0.74rem] leading-relaxed text-muted-foreground"
      role="status"
    >
      <span>{selection.notice}</span>
      <button
        type="button"
        className="shrink-0 rounded-full p-1 hover:bg-secondary hover:text-foreground"
        onClick={selection.dismissNotice}
        aria-label="Dismiss selection notice"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function BulkItemActionBar({
  items,
  onClear,
  onNotice,
}: {
  items: ItemSummary[];
  onClear: () => void;
  onNotice: (message: string) => void;
}) {
  const [dialog, setDialog] = React.useState<
    "move" | "tags" | "category" | "images" | null
  >(null);
  const [evidenceOpen, setEvidenceOpen] = React.useState(false);
  const summary = {
    count: items.length,
    units: items.reduce((sum, item) => sum + item.quantity, 0),
    onLoan: items.reduce((sum, item) => sum + (item.on_loan_quantity ?? 0), 0),
    archived: items.some((item) => item.is_archived),
  };
  if (items.length === 0) return null;
  return (
    <>
      <div className="surface mb-4 flex flex-col gap-3 border-brass/25 bg-brass-soft/25 p-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-[0.78rem]">
          <p className="font-medium">
            {pluralize(summary.count, "item")} selected ·{" "}
            {pluralize(summary.units, "unit")}
          </p>
          <p className="mt-0.5 text-[0.68rem] text-muted-foreground">
            {summary.onLoan > 0
              ? `${summary.onLoan} unit(s) on loan; their home place can move without changing loans.`
              : "Bulk actions apply to the selected loaded records only."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={summary.archived}
            onClick={() => setDialog("move")}
          >
            <MoveRight />
            Move
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={summary.archived}
            onClick={() => setDialog("tags")}
          >
            <Tags />
            Tags
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={summary.archived}
            onClick={() => setDialog("category")}
          >
            <FolderTree />
            Category
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={summary.archived}
            onClick={() => setDialog("images")}
          >
            <ImagePlus />
            Images
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEvidenceOpen(true)}>
            <Download />
            Export evidence
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear}>
            Clear
          </Button>
        </div>
      </div>

      <BulkMoveDialog
        open={dialog === "move"}
        onOpenChange={(open) => setDialog(open ? "move" : null)}
        items={items}
        onCompleted={(result) => {
          onClear();
          onNotice(
            `Moved ${pluralize(result.moved_count, "item")}. Each moved item has its own history entry and can be undone individually.`,
          );
        }}
      />
      <BulkTagDialog
        open={dialog === "tags"}
        onOpenChange={(open) => setDialog(open ? "tags" : null)}
        items={items}
        onCompleted={(result) => {
          onClear();
          onNotice(
            `${result.mode === "add" ? "Added" : "Removed"} tags on ${pluralize(
              result.updated_count,
              "item",
            )}.`,
          );
        }}
      />
      <BulkCategoryDialog
        open={dialog === "category"}
        onOpenChange={(open) => setDialog(open ? "category" : null)}
        items={items}
        onCompleted={(result) => {
          onClear();
          onNotice(
            result.mode === "set"
              ? `Set category on ${pluralize(result.updated_count, "item")}.`
              : `Cleared category on ${pluralize(result.updated_count, "item")}.`,
          );
        }}
      />
      <BulkImagesDialog
        open={dialog === "images"}
        onOpenChange={(open) => setDialog(open ? "images" : null)}
        items={items}
      />
      <EvidenceExportDialog
        open={evidenceOpen}
        onOpenChange={setEvidenceOpen}
        scope={{ item_ids: items.map((item) => item.id) }}
        title={`Export ${pluralize(items.length, "selected item")} with evidence`}
      />
    </>
  );
}
