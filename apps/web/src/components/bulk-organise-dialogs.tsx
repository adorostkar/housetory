import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, FolderTree, MoveRight, Plus, Tags } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { CategoryDialog } from "@/components/category-dialog";
import { Field, FormError } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  queryKeys,
  useCategories,
  useInvalidateInventory,
  useLocations,
  useRooms,
  useTags,
} from "@/lib/queries";
import type {
  BulkCategoryResult,
  BulkMoveResult,
  BulkTagResult,
  Category,
  ItemListEntry,
  Tag,
} from "@/lib/types";
import { cn, locationPath, pluralize, roomPath } from "@/lib/utils";

function useRequestId(open: boolean) {
  const [requestId, setRequestId] = React.useState(() => crypto.randomUUID());
  React.useEffect(() => {
    if (open) setRequestId(crypto.randomUUID());
  }, [open]);
  return requestId;
}

function selectionSummary(items: ItemListEntry[]) {
  return {
    count: items.length,
    units: items.reduce((sum, item) => sum + item.quantity, 0),
    onLoan: items.reduce((sum, item) => sum + (item.on_loan_quantity ?? 0), 0),
    archived: items.some((item) => item.is_archived),
  };
}

function SelectionSummary({ items }: { items: ItemListEntry[] }) {
  const summary = selectionSummary(items);
  return (
    <div className="rounded-xl border border-border/60 bg-secondary/20 px-3.5 py-3 text-2xs leading-relaxed text-muted-foreground">
      <p>
        <strong className="font-medium text-foreground">
          {pluralize(summary.count, "item")}
        </strong>{" "}
        · {pluralize(summary.units, "recorded unit")}
        {summary.onLoan > 0 ? ` · ${summary.onLoan} on loan` : ""}
      </p>
      {summary.onLoan > 0 && (
        <p className="mt-1 text-brass">
          Moving the home place does not return the loaned units. Loan records and
          quantities stay unchanged.
        </p>
      )}
      {summary.archived && (
        <p className="mt-1 text-destructive">
          Archived items cannot be changed in bulk. Restore them or clear the selection.
        </p>
      )}
    </div>
  );
}

function useBulkInvalidation(kind: "move" | "tags" | "category" = "move") {
  const invalidate = useInvalidateInventory(
    kind === "move" ? undefined : [
      "items", "item", "overview", "financial", "stocktake", "inventory-review",
      "loans", kind === "tags" ? "tags" : "categories",
    ],
  );
  const client = useQueryClient();
  return () => {
    invalidate();
    if (kind === "move") void client.invalidateQueries({ queryKey: ["loans"] });
  };
}

export function BulkMoveDialog({
  open,
  onOpenChange,
  items,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ItemListEntry[];
  onCompleted: (result: BulkMoveResult) => void;
}) {
  const roomsQuery = useRooms(undefined, open);
  const locationsQuery = useLocations(undefined, open);
  const invalidate = useBulkInvalidation();
  const requestId = useRequestId(open);
  const [roomId, setRoomId] = React.useState("");
  const [locationId, setLocationId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const summary = selectionSummary(items);

  React.useEffect(() => {
    if (!open) return;
    setRoomId("");
    setLocationId("");
    setError(null);
  }, [open]);

  const roomLocations = (locationsQuery.data?.items ?? []).filter(
    (location) => location.room_id === roomId,
  );

  const move = useMutation({
    mutationFn: () =>
      api.post<BulkMoveResult>("/items/bulk/move", {
        item_ids: items.map((item) => item.id),
        room_id: roomId,
        storage_location_id: locationId || null,
        request_id: requestId,
      }),
    onSuccess: (result) => {
      invalidate();
      toast.success(
        `Moved ${pluralize(result.moved_count, "item")} to ${result.destination.room_name}${
          result.destination.storage_location_name
            ? ` / ${result.destination.storage_location_name}`
            : ""
        }${result.unchanged_count ? ` · ${result.unchanged_count} already there` : ""}`,
      );
      onCompleted(result);
      onOpenChange(false);
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const invalid = !roomId || items.length === 0 || summary.archived;
  const rooms = roomsQuery.data?.items ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MoveRight className="size-4 text-brass" />
            Move selected items
          </DialogTitle>
          <DialogDescription>
            This changes each record's home room/place. It does not change quantities,
            loans or create locations.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            move.mutate();
          }}
        >
          <SelectionSummary items={items} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Destination room" htmlFor="bulk-move-room">
              <Select
                id="bulk-move-room"
                value={roomId}
                onChange={(event) => {
                  setRoomId(event.target.value);
                  setLocationId("");
                }}
                required
              >
                <option value="">Choose a room</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {[
                      room.property?.name,
                      ...roomPath(rooms, room.id).map((entry) => entry.name),
                    ]
                      .filter(Boolean)
                      .join(" / ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Storage place or container" htmlFor="bulk-move-location" optional>
              <Select
                id="bulk-move-location"
                value={locationId}
                disabled={!roomId}
                onChange={(event) => setLocationId(event.target.value)}
              >
                <option value="">Room only</option>
                {roomLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {locationPath(locationsQuery.data?.items ?? [], location.id)
                      .map((entry) => entry.identifier ?? entry.name)
                      .join(" / ")}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="rounded-xl border border-border/60 bg-background/35 px-3.5 py-2.5 text-2xs leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground/80">Preview</p>
            <p className="mt-1">
              {summary.count} selected item(s), {summary.units} recorded unit(s). Moving
              the same total quantity to the chosen home; no quantity split is created.
            </p>
            <p className="mt-1">
              Individual move history is recorded and can be undone from each item's
              timeline.
            </p>
          </div>
          {error && <FormError message={error} />}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={invalid || move.isPending}
              title={summary.archived ? "Restore archived items first." : undefined}
            >
              {move.isPending ? <Spinner /> : <ArrowRight />}
              Move selected
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BulkTagDialog({
  open,
  onOpenChange,
  items,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ItemListEntry[];
  onCompleted: (result: BulkTagResult) => void;
}) {
  const tagsQuery = useTags(open);
  const invalidate = useBulkInvalidation("tags");
  const client = useQueryClient();
  const requestId = useRequestId(open);
  const [mode, setMode] = React.useState<"add" | "remove">("add");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [newTag, setNewTag] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const summary = selectionSummary(items);

  React.useEffect(() => {
    if (!open) return;
    setMode("add");
    setSelected(new Set());
    setNewTag("");
    setError(null);
  }, [open]);

  const createTag = useMutation({
    mutationFn: (name: string) => api.post<Tag>("/tags", { name }),
    onSuccess: (tag) => {
      void client.invalidateQueries({ queryKey: queryKeys.tags });
      setSelected((current) => new Set([...current, tag.id]));
      setNewTag("");
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const update = useMutation({
    mutationFn: () =>
      api.post<BulkTagResult>("/items/bulk/tags", {
        item_ids: items.map((item) => item.id),
        tag_ids: [...selected],
        mode,
        request_id: requestId,
      }),
    onSuccess: (result) => {
      invalidate();
      toast.success(
        `${mode === "add" ? "Added" : "Removed"} ${pluralize(
          result.tag_names.length,
          "tag",
        )} on ${pluralize(result.updated_count, "item")}`,
      );
      onCompleted(result);
      onOpenChange(false);
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const addTag = () => {
    const name = newTag.trim();
    if (!name) return;
    const existing = tagsQuery.data?.items.find(
      (tag) => tag.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      setSelected((current) => new Set([...current, existing.id]));
      setNewTag("");
      return;
    }
    createTag.mutate(name);
  };

  const tags = tagsQuery.data?.items ?? [];
  const invalid = selected.size === 0 || items.length === 0 || summary.archived;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tags className="size-4 text-brass" />
            Update tags
          </DialogTitle>
          <DialogDescription>
            Add or remove selected tags. Existing tags are preserved; this workflow does
            not replace all tags.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            update.mutate();
          }}
        >
          <SelectionSummary items={items} />
          <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Tag action">
            {(["add", "remove"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                className={cn(
                  "rounded-lg border px-3 py-2 text-xs font-medium transition-colors",
                  mode === value
                    ? "border-foreground/15 bg-foreground text-background"
                    : "border-border/70 bg-card/50 text-muted-foreground hover:text-foreground",
                )}
              >
                {value === "add" ? "Add tags" : "Remove tags"}
              </button>
            ))}
          </div>
          {tags.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/70 px-3.5 py-4 text-2xs text-muted-foreground">
              No tags exist yet. Create one below or from an item's edit form.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => {
                const active = selected.has(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(tag.id)) next.delete(tag.id);
                        else next.add(tag.id);
                        return next;
                      })
                    }
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-2xs transition-colors",
                      active
                        ? "border-sage/30 bg-sage-soft text-accent-foreground"
                        : "border-border/70 bg-card/45 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}
          {mode === "add" && (
            <div className="flex gap-2">
              <Input
                value={newTag}
                onChange={(event) => {
                  setNewTag(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addTag();
                  }
                }}
                placeholder="Create a tag"
                maxLength={60}
                aria-label="Create a tag"
              />
              <Button
                type="button"
                variant="outline"
                onClick={addTag}
                disabled={!newTag.trim() || createTag.isPending}
              >
                {createTag.isPending ? <Spinner /> : <Plus />}
                Add
              </Button>
            </div>
          )}
          <p className="text-2xs leading-relaxed text-muted-foreground">
            {mode === "add"
              ? "Selected tags are added; every other tag on each item stays in place."
              : "Selected tags are removed from the selected items. No replacement is applied."}
          </p>
          {error && <FormError message={error} />}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={invalid || update.isPending}>
              {update.isPending ? <Spinner /> : <Check />}
              {mode === "add" ? "Add selected tags" : "Remove selected tags"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BulkCategoryDialog({
  open,
  onOpenChange,
  items,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ItemListEntry[];
  onCompleted: (result: BulkCategoryResult) => void;
}) {
  const categoriesQuery = useCategories(open);
  const invalidate = useBulkInvalidation("category");
  const requestId = useRequestId(open);
  const [mode, setMode] = React.useState<"set" | "clear">("set");
  const [categoryId, setCategoryId] = React.useState("");
  const [categoryOpen, setCategoryOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const summary = selectionSummary(items);

  React.useEffect(() => {
    if (!open) return;
    setMode("set");
    setCategoryId("");
    setError(null);
  }, [open]);

  const update = useMutation({
    mutationFn: () =>
      api.post<BulkCategoryResult>("/items/bulk/category", {
        item_ids: items.map((item) => item.id),
        mode,
        category_id: mode === "set" ? categoryId : null,
        request_id: requestId,
      }),
    onSuccess: (result) => {
      invalidate();
      toast.success(
        result.mode === "set"
          ? `Set ${result.category_name ?? "category"} on ${pluralize(
              result.updated_count,
              "item",
            )}`
          : `Cleared category on ${pluralize(result.updated_count, "item")}`,
      );
      onCompleted(result);
      onOpenChange(false);
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const categories = categoriesQuery.data?.items ?? [];
  const invalid =
    items.length === 0 || summary.archived || (mode === "set" && !categoryId);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderTree className="size-4 text-brass" />
              Set category
            </DialogTitle>
            <DialogDescription>
              Assign one existing category, or explicitly clear the category. Other
              fields and relationships are unchanged.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              update.mutate();
            }}
          >
            <SelectionSummary items={items} />
            <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Category action">
              {(["set", "clear"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-xs font-medium transition-colors",
                    mode === value
                      ? value === "clear"
                        ? "border-destructive/20 bg-destructive/10 text-destructive"
                        : "border-foreground/15 bg-foreground text-background"
                      : "border-border/70 bg-card/50 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {value === "set" ? "Set category" : "Clear category"}
                </button>
              ))}
            </div>
            {mode === "set" ? (
              <div className="space-y-2">
                <Field label="Category" htmlFor="bulk-category">
                  <Select
                    id="bulk-category"
                    value={categoryId}
                    onChange={(event) => setCategoryId(event.target.value)}
                  >
                    <option value="">Choose a category</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setCategoryOpen(true)}
                >
                  <Plus />
                  New category
                </Button>
              </div>
            ) : (
              <p className="rounded-xl border border-destructive/20 bg-destructive/[0.06] px-3.5 py-2.5 text-2xs leading-relaxed text-muted-foreground">
                This explicitly removes the category from {summary.count} selected
                item(s). Items and tags are not deleted.
              </p>
            )}
            {error && <FormError message={error} />}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={invalid || update.isPending}
                variant={mode === "clear" ? "destructive" : "default"}
              >
                {update.isPending ? <Spinner /> : <Check />}
                {mode === "set" ? "Apply category" : "Clear selected category"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <CategoryDialog
        open={categoryOpen}
        onOpenChange={setCategoryOpen}
        onCreated={(category: Category) => {
          setMode("set");
          setCategoryId(category.id);
        }}
      />
    </>
  );
}
