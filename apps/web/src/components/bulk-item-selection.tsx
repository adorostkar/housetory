import {
  ClipboardCheck,
  Download,
  FolderTree,
  ImagePlus,
  ListChecks,
  MoreHorizontal,
  MoveRight,
  Tags,
  X,
} from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

import {
  BulkCategoryDialog,
  BulkMoveDialog,
  BulkTagDialog,
} from "@/components/bulk-organise-dialogs";
import { BulkImagesDialog } from "@/components/bulk-images-dialog";
import { EvidenceExportDialog } from "@/components/evidence-export-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSoftwareKeyboardOpen } from "@/hooks/use-software-keyboard-open";
import type { ItemListEntry } from "@/lib/types";
import { cn, pluralize } from "@/lib/utils";

export interface BulkSelection {
  selected: Set<string>;
  selectedItems: ItemListEntry[];
  selectableItems: ItemListEntry[];
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
  /**
   * Whether rows show their checkbox. Always true, unless the page asked for
   * selection on request (`onRequest`): then it is on after "Select" is pressed.
   */
  selecting: boolean;
  startSelecting: () => void;
  /** Clears the selection. With selection on request it also hides the checkboxes. */
  stopSelecting: () => void;
  /** The `selection` prop for an item's row or card; undefined while rows have no checkbox. */
  itemSelection: (
    item: ItemListEntry,
  ) => { selected: boolean; onToggle: () => void; disabled: boolean } | undefined;
}

const SELECTION_STORAGE_KEY = "housetory:bulk-selection";

/** One list's selection is kept for this browser tab, so it survives opening an item. */
function selectionScope(scopeKey: string) {
  return `${window.location.pathname}|${scopeKey}`;
}

function readStoredSelection(scopeKey: string): Set<string> {
  try {
    const stored = JSON.parse(sessionStorage.getItem(SELECTION_STORAGE_KEY) ?? "null") as {
      scope?: unknown;
      ids?: unknown;
    } | null;
    if (stored?.scope === selectionScope(scopeKey) && Array.isArray(stored.ids)) {
      return new Set(stored.ids.filter((id): id is string => typeof id === "string"));
    }
  } catch {
    // Without storage the selection simply starts empty.
  }
  return new Set();
}

function writeStoredSelection(scopeKey: string, selected: Set<string>) {
  try {
    const scope = selectionScope(scopeKey);
    if (selected.size > 0) {
      sessionStorage.setItem(
        SELECTION_STORAGE_KEY,
        JSON.stringify({ scope, ids: [...selected] }),
      );
      return;
    }
    // An empty list must not wipe the selection that another list is keeping.
    const stored = JSON.parse(sessionStorage.getItem(SELECTION_STORAGE_KEY) ?? "null") as {
      scope?: unknown;
    } | null;
    if (stored?.scope === scope) sessionStorage.removeItem(SELECTION_STORAGE_KEY);
  } catch {
    // The selection still works until the list is left.
  }
}

export function useBulkSelection({
  items,
  enabled,
  scopeKey,
  onRequest = false,
}: {
  items: ItemListEntry[];
  enabled: boolean;
  scopeKey: string;
  /**
   * The list shows no checkboxes until the user turns selection on (see
   * `BulkSelectButton`). Without it the checkboxes are always there.
   */
  onRequest?: boolean;
}): BulkSelection {
  const [selected, setSelected] = React.useState<Set<string>>(() =>
    enabled ? readStoredSelection(scopeKey) : new Set(),
  );
  // A selection kept from before (the user opened an item and came back) is shown at once.
  const [requested, setRequested] = React.useState(() => selected.size > 0);
  const selecting = !onRequest || (enabled && requested);
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
    writeStoredSelection(scopeKey, selected);
  }, [scopeKey, selected]);

  React.useEffect(() => {
    // Nothing is loaded yet (for example on the way back to the list): keep waiting.
    if (!loadedIdsKey) return;
    const current = selectedRef.current;
    if (current.size === 0) return;
    const loaded = new Set(loadedIdsKey.split("|"));
    const next = new Set([...current].filter((id) => loaded.has(id)));
    const dropped = current.size - next.size;
    if (dropped === 0) return;
    setSelected(next);
    setNotice(
      `${pluralize(dropped, "selected item")} ${
        dropped === 1 ? "is" : "are"
      } no longer in the loaded list and ${dropped === 1 ? "was" : "were"} taken out of the selection.`,
    );
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

  const startSelecting = () => {
    if (enabled) setRequested(true);
  };

  const stopSelecting = () => {
    setSelected(new Set());
    setRequested(false);
  };

  const itemSelection = (item: ItemListEntry) =>
    enabled && selecting
      ? {
          selected: selected.has(item.id),
          onToggle: () => toggleItem(item.id),
          disabled: item.is_archived,
        }
      : undefined;

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
    selecting,
    startSelecting,
    stopSelecting,
    itemSelection,
  };
}

/**
 * Turns selection on and off for a list that uses `onRequest`. Pressing it
 * again hides the checkboxes and clears the selection.
 */
export function BulkSelectButton({
  selection,
  className,
}: {
  selection: BulkSelection;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant={selection.selecting ? "secondary" : "outline"}
      size="sm"
      className={cn("shrink-0 px-3 coarse:min-w-11", className)}
      aria-label="Select items"
      aria-pressed={selection.selecting}
      title={selection.selecting ? "Stop selecting" : "Select items"}
      onClick={selection.selecting ? selection.stopSelecting : selection.startSelecting}
    >
      <ListChecks />
      <span className="hidden sm:inline">Select</span>
    </Button>
  );
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
  if (!selection.selecting) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
      {selection.selectableItems.length > 0 && (
        <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 sm:min-h-0 coarse:!min-h-11">
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
      className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-border/70 bg-secondary/25 px-3.5 py-2.5 text-2xs leading-relaxed text-muted-foreground"
      role="status"
    >
      <span>{selection.notice}</span>
      <button
        type="button"
        className="flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-secondary hover:text-foreground sm:size-auto sm:p-1"
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
  items: ItemListEntry[];
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
  const keyboardOpen = useSoftwareKeyboardOpen();
  const { anchor, box } = useAnchorBox(items.length > 0);
  const touchButton = "h-11 px-3 sm:h-9 coarse:!h-11";
  return (
    <>
      {/* Marks the list's column. The bar is fixed to the screen but lines up with it. */}
      <div ref={anchor} aria-hidden="true" className="h-0" />
      {/* The bar is drawn in the page body. Inside the page it would be placed from the
          page's own box, because the page keeps a transform after its opening animation. */}
      {items.length > 0 && !keyboardOpen && createPortal(
        <div
          role="region"
          aria-label="Selected items"
          data-testid="bulk-action-bar"
          className="fixed inset-x-2 bottom-[calc(var(--shell-bar-height,0px)+var(--keyboard-inset,0px)+0.5rem)] z-30 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl border border-brass/30 bg-background/95 px-3 py-2 shadow-lift backdrop-blur-xl"
          style={box ? { left: box.left, right: "auto", width: box.width } : undefined}
        >
          <p className="min-w-0 flex-1 basis-32 text-xs font-medium" role="status">
            {`${pluralize(summary.count, "item")} selected · ${pluralize(summary.units, "unit")}${
              summary.onLoan > 0 ? `, ${summary.onLoan} on loan` : ""
            }`}
          </p>
          {/* On the narrowest phones the buttons take two lines instead of spilling out. */}
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <Button
              size="sm"
              className={touchButton}
              disabled={summary.archived}
              onClick={() => setDialog("move")}
            >
              <MoveRight />
              Move
            </Button>
            <Button
              size="sm"
              variant="outline"
              className={touchButton}
              disabled={summary.archived}
              onClick={() => setDialog("tags")}
            >
              <Tags />
              Tags
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className={touchButton}>
                  <MoreHorizontal />
                  More
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top">
                <DropdownMenuItem
                  className="min-h-11"
                  disabled={summary.archived}
                  onSelect={() => setDialog("category")}
                >
                  <FolderTree />
                  Category
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="min-h-11"
                  disabled={summary.archived}
                  onSelect={() => setDialog("images")}
                >
                  <ImagePlus />
                  Images
                </DropdownMenuItem>
                <DropdownMenuItem asChild className="min-h-11">
                  <Link
                    to={`/review?scope_type=items&item_ids=${items
                      .map((item) => item.id)
                      .join(",")}`}
                  >
                    <ClipboardCheck />
                    Review
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem className="min-h-11" onSelect={() => setEvidenceOpen(true)}>
                  <Download />
                  Export evidence
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="icon"
              variant="ghost"
              className="size-11 sm:size-9 coarse:!size-11"
              onClick={onClear}
              aria-label="Clear selection"
              title="Clear selection"
            >
              <X />
            </Button>
          </div>
        </div>,
        document.body,
      )}

      {items.length > 0 && (
        <>
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
      )}
    </>
  );
}

/**
 * Where the list's column is on the screen. A fixed bar takes its left edge
 * and width from it, so it never covers the room rail, the sidebar or a side
 * panel, whatever page the list is on.
 */
function useAnchorBox(active: boolean) {
  const anchor = React.useRef<HTMLDivElement>(null);
  const [box, setBox] = React.useState<{ left: number; width: number } | null>(null);
  React.useLayoutEffect(() => {
    const node = anchor.current;
    if (!active || !node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setBox((current) => {
        if (rect.width <= 0) return null;
        return current?.left === rect.left && current.width === rect.width
          ? current
          : { left: rect.left, width: rect.width };
      });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active]);
  return { anchor, box };
}
