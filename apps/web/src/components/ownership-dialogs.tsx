import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Check, PackageOpen, Search } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

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
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api, buildQuery, getApiErrorMessage } from "@/lib/api";
import { queryKeys, useInvalidateInventory, useItems } from "@/lib/queries";
import type {
  ContainerDetail,
  ContainerList,
  ItemDetail,
  ItemDetailResponse,
  ItemSummary,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export function ItemStorageDialog({
  item,
  open,
  onOpenChange,
  onEnabled,
}: {
  item: ItemDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnabled?: (updated: ItemDetail) => void;
}) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateInventory();
  const [existingLocationId, setExistingLocationId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const canUseExisting = item.quantity === 1 && Boolean(item.room);
  const containersQuery = useQuery({
    queryKey: [...queryKeys.containers, "storage-options", item.room?.id ?? ""],
    queryFn: () =>
      api.get<ContainerList>(
        `/containers${buildQuery({
          room_id: item.room?.id,
          include_fixed: true,
          limit: 200,
        })}`,
      ),
    enabled: open && canUseExisting,
  });
  const candidates = React.useMemo(() => {
    const parentId = item.location?.id ?? null;
    return (containersQuery.data?.items ?? []).filter(
      (container) =>
        container.parent_id === parentId &&
        !container.owner_item &&
        container.id !== item.storage?.location_id,
    );
  }, [containersQuery.data?.items, item.location?.id, item.storage?.location_id]);

  React.useEffect(() => {
    if (!open) return;
    setExistingLocationId("");
    setError(null);
  }, [open]);

  const enable = useMutation({
    mutationFn: () =>
      api.post<ItemDetailResponse>(`/items/${item.id}/storage`, {
        existing_location_id: existingLocationId || null,
      }),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.item(item.id) });
      void queryClient.invalidateQueries({ queryKey: ["locations"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.containers });
      invalidate();
      toast.success(
        existingLocationId
          ? "Existing container linked as this item's contents storage"
          : "Contents storage enabled",
      );
      onEnabled?.(response.item);
      onOpenChange(false);
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageOpen className="size-4 text-brass" />
            Store items inside {item.name}
          </DialogTitle>
          <DialogDescription>
            This creates one storage place with its own identifier and QR code. The owned
            item stays outside that place; its purchase, warranty, photos, documents and
            value are unchanged.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            enable.mutate();
          }}
        >
          <div className="rounded-xl border border-border/60 bg-secondary/20 px-3.5 py-3 text-2xs leading-relaxed text-muted-foreground">
            {item.quantity === 1 ? (
              <>
                A storage place will be created in{" "}
                <strong className="font-medium text-foreground">
                  {[item.room?.name, item.location?.name].filter(Boolean).join(" / ") ||
                    "the item's room"}
                </strong>
                . Add contents later with the ordinary item picker.
              </>
            ) : (
              <>
                This item has quantity {item.quantity}. A physical storage unit must be
                quantity 1 so its contents cannot be split ambiguously. Create a separate
                item for each box or piece of furniture.
              </>
            )}
          </div>
          {candidates.length > 0 && item.quantity === 1 && (
            <Field
              label="Existing container"
              htmlFor="item-storage-existing"
              optional
              hint="Use a deliberate link when a matching empty container already exists. No name matching is automatic."
            >
              <Select
                id="item-storage-existing"
                value={existingLocationId}
                onChange={(event) => setExistingLocationId(event.target.value)}
              >
                <option value="">Create a new storage place</option>
                {candidates.map((container) => (
                  <option key={container.id} value={container.id}>
                    {container.identifier
                      ? `${container.identifier} · ${container.name}`
                      : container.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {containersQuery.isError && (
            <p className="text-2xs text-destructive">
              Existing containers could not be checked. You can still create new storage.
            </p>
          )}
          {error && <FormError message={error} />}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={enable.isPending || item.quantity !== 1 || !item.room}>
              {enable.isPending ? <Spinner /> : <Check />}
              {existingLocationId ? "Link and enable contents" : "Create contents storage"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ContainerOwnershipDialog({
  container,
  open,
  onOpenChange,
  onLinked,
}: {
  container: ContainerDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLinked?: (itemId: string) => void;
}) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateInventory();
  const [mode, setMode] = React.useState<"create" | "link">("create");
  const [name, setName] = React.useState(container.name);
  const [search, setSearch] = React.useState("");
  const [selectedItemId, setSelectedItemId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const debounced = useDebouncedValue(search, 250);
  const itemsQuery = useItems(
    { q: debounced.trim() || undefined, room_id: container.room_id },
    30,
    open && mode === "link",
  );
  const parentId = container.parent_id;
  const candidates = (itemsQuery.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (item) =>
      item.quantity === 1 &&
      (item.location?.id ?? null) === parentId,
  );

  React.useEffect(() => {
    if (!open) return;
    setMode("create");
    setName(container.name);
    setSearch("");
    setSelectedItemId("");
    setError(null);
  }, [open, container.name]);

  const link = useMutation({
    mutationFn: () =>
      api.post<ContainerDetail>(`/containers/${container.id}/ownership`, {
        item_id: mode === "link" ? selectedItemId : null,
        name: mode === "create" ? name.trim() || container.name : null,
      }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.container(container.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.containers });
      void queryClient.invalidateQueries({ queryKey: ["locations"] });
      invalidate();
      toast.success("Ownership details added to the storage place");
      const ownerId = updated.owner_item?.id;
      onOpenChange(false);
      if (ownerId) onLinked?.(ownerId);
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const invalid =
    (mode === "create" && !name.trim()) || (mode === "link" && !selectedItemId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Boxes className="size-4 text-brass" />
            Ownership details for {container.identifier ?? container.name}
          </DialogTitle>
          <DialogDescription>
            Link this existing container to one owned item. The container keeps its
            identifier, QR code, contents and history; purchase, warranty, photos and
            documents live on the item.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            link.mutate();
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setMode("create")}
              className={cn(
                "rounded-xl border px-3.5 py-3 text-left text-xs",
                mode === "create"
                  ? "border-foreground/30 bg-secondary"
                  : "border-border/65 bg-background/40",
              )}
            >
              <span className="block font-medium">Create owned item</span>
              <span className="mt-0.5 block text-2xs text-muted-foreground">
                Keep the container name and add ownership fields afterwards.
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMode("link")}
              className={cn(
                "rounded-xl border px-3.5 py-3 text-left text-xs",
                mode === "link"
                  ? "border-foreground/30 bg-secondary"
                  : "border-border/65 bg-background/40",
              )}
            >
              <span className="block font-medium">Link existing item</span>
              <span className="mt-0.5 block text-2xs text-muted-foreground">
                Deliberately avoid a duplicate ownership record.
              </span>
            </button>
          </div>
          {mode === "create" ? (
            <Field label="Owned item name" htmlFor="ownership-name">
              <Input
                id="ownership-name"
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          ) : (
            <div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search items in the same room"
                  aria-label="Search items to link"
                  className="pl-10"
                />
              </div>
              <div className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-border/70 bg-background/35 p-1.5">
                {itemsQuery.isPending ? (
                  <div className="flex items-center justify-center gap-2 py-8 text-2xs text-muted-foreground">
                    <Spinner /> Loading items…
                  </div>
                ) : candidates.length === 0 ? (
                  <p className="px-3 py-8 text-center text-2xs text-muted-foreground">
                    No quantity-1 item is recorded directly outside this container. Create
                    a new owned item instead, or move the intended item here first.
                  </p>
                ) : (
                  candidates.map((item) => (
                    <ItemLinkRow
                      key={item.id}
                      item={item}
                      selected={selectedItemId === item.id}
                      onSelect={() => setSelectedItemId(item.id)}
                    />
                  ))
                )}
              </div>
            </div>
          )}
          {error && <FormError message={error} />}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={invalid || link.isPending}>
              {link.isPending ? <Spinner /> : <Check />}
              {mode === "create" ? "Create ownership details" : "Link owned item"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ItemLinkRow({
  item,
  selected,
  onSelect,
}: {
  item: ItemSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        selected ? "bg-secondary" : "hover:bg-secondary/60",
      )}
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-border",
        )}
      >
        {selected && <Check className="size-3" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{item.name}</span>
        <span className="block truncate text-2xs text-muted-foreground">
          {[item.room?.name, item.category?.name].filter(Boolean).join(" · ") ||
            "No place yet"}
        </span>
      </span>
    </button>
  );
}



