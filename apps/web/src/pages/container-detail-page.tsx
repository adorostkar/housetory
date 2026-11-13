import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  FileText,
  MapPin,
  Pencil,
  Printer,
  QrCode,
  Download,
  PackageOpen,
  MoveRight,
  Search,
  Trash2,
  Truck,
} from "lucide-react";
import * as React from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { ActivityTimeline } from "@/components/activity-timeline";
import {
  AddItemsButton,
  useAddItems,
  useRegisterAddItemsContext,
} from "@/components/add-items";
import { BorrowedKeptHere } from "@/components/borrowed-kept-here";
import {
  BulkItemActionBar,
  BulkSelectionControls,
  BulkSelectionNotice,
  useBulkSelection,
} from "@/components/bulk-item-selection";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  ContainerMoveDialog,
  ContainerQrDialog,
} from "@/components/container-dialogs";
import { ContainerOwnershipDialog } from "@/components/ownership-dialogs";
import { EmptyState } from "@/components/empty-state";
import { EntityPhotoManager } from "@/components/entity-photo-manager";
import { ErrorState } from "@/components/error-state";
import { EvidenceExportDialog } from "@/components/evidence-export-dialog";
import { ItemCard } from "@/components/item-card";
import {
  PlaceTransferDialog,
  type PlaceTransferSource,
} from "@/components/place-transfer-dialog";
import { StocktakeEntry } from "@/components/stocktake-entry";
import { PageLayout, PageSkeleton } from "@/components/page-layout";
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { useRegisterAssistantPageContext } from "@/lib/assistant-page-context";
import {
  queryKeys,
  useCanWrite,
  useContainer,
  useContainerHistory,
  useInvalidateInventory,
  useItems,
  useLocations,
  useRooms,
} from "@/lib/queries";
import { itemOrigin, useRestoreListScroll } from "@/lib/navigation";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { Container, ContainerType } from "@/lib/types";
import {
  CONTAINER_TYPE_LABELS,
  formatDate,
  formatRelativeDate,
  itemContainer,
  pluralize,
} from "@/lib/utils";
import { WARRANTY_STATUS_LABELS, WARRANTY_STATUS_TONE } from "@/lib/labels";

const TYPES: ContainerType[] = ["box", "bin", "crate", "suitcase", "bag", "other"];
const ITEM_SORTS = {
  name_asc: "Name A–Z",
  created_desc: "Newest first",
  updated_desc: "Recently updated",
} as const;

export function ContainerDetailPage() {
  const canWrite = useCanWrite();
  const { containerId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const containerQuery = useContainer(containerId);
  const historyQuery = useContainerHistory(containerId);
  const roomsQuery = useRooms();
  const locationsQuery = useLocations();
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const [qrOpen, setQrOpen] = React.useState(false);
  const [moveOpen, setMoveOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [ownershipOpen, setOwnershipOpen] = React.useState(false);
  const [unlinkOpen, setUnlinkOpen] = React.useState(false);
  const [evidenceOpen, setEvidenceOpen] = React.useState(false);
  const [emptyDeleteOpen, setEmptyDeleteOpen] = React.useState(false);
  const [transferMode, setTransferMode] = React.useState<"move" | "delete" | null>(null);
  const scope = searchParams.get("scope") === "direct" ? "direct" : "nested";
  const sort = searchParams.get("sort") === "created_desc"
    ? "created_desc"
    : searchParams.get("sort") === "updated_desc"
      ? "updated_desc"
      : "name_asc";
  const qParam = searchParams.get("q") ?? "";
  const [search, setSearch] = React.useState(qParam);
  const debouncedSearch = useDebouncedValue(search, 300);
  const [editName, setEditName] = React.useState("");
  const [editDescription, setEditDescription] = React.useState("");
  const [editType, setEditType] = React.useState<ContainerType>("box");
  const container = containerQuery.data;
  const rooms = roomsQuery.data?.items ?? [];
  const locations = locationsQuery.data?.items ?? [];
  const itemsQuery = useItems(
    {
      q: qParam || undefined,
      location_id: containerId || undefined,
      include_descendants: scope === "nested",
      sort,
    },
    24,
    Boolean(containerId),
  );
  const items = itemsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const totalItems = itemsQuery.data?.pages[0]?.total ?? 0;
  const filterSignature = JSON.stringify([containerId, scope, qParam, sort]);
  const selection = useBulkSelection({
    items,
    enabled: canWrite,
    scopeKey: filterSignature,
  });
  useRegisterAssistantPageContext(
    selection.selectedItems.length
      ? selection.selectedItems.map((item) => ({ kind: "item", id: item.id, name: item.name }))
      : container && !containerQuery.isError
        ? [{ kind: "location", id: container.id, name: container.name }]
        : [],
  );
  const origin = itemOrigin(
    `${location.pathname}${location.search}`,
    container?.identifier ?? container?.name ?? "container",
  );
  useRestoreListScroll(items.length > 0, origin);
  const transferSource: PlaceTransferSource | null = container
    ? {
        kind: "location",
        id: container.id,
        label: container.identifier ?? container.name,
        roomId: container.room_id,
        propertyId: container.property?.id ?? "",
      }
    : null;
  const { openAddItems } = useAddItems();
  const addItemsContext = React.useMemo(
    () =>
      container
        ? {
            propertyId: container.property?.id,
            roomId: container.room_id,
            locationId: container.id,
            roomName: container.room.name,
            locationName: container.identifier ?? container.name,
          }
        : undefined,
    [container],
  );
  useRegisterAddItemsContext(addItemsContext ?? null);

  React.useEffect(() => {
    const trimmed = debouncedSearch.trim();
    if (trimmed === qParam) return;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (trimmed) next.set("q", trimmed);
        else next.delete("q");
        return next;
      },
      { replace: true },
    );
  }, [debouncedSearch, qParam, setSearchParams]);

  React.useEffect(() => {
    if (!container) return;
    setEditName(container.name);
    setEditDescription(container.description ?? "");
    setEditType(container.container_type ?? "box");
  }, [container]);

  const refreshContainer = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.container(containerId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers });
  };

  const update = useMutation({
    mutationFn: () =>
      api.patch<Container>(`/containers/${containerId}`, {
        name: editName.trim() || null,
        description: editDescription.trim() || null,
        container_type: container?.is_container ? editType : undefined,
      }),
    onSuccess: () => {
      refreshContainer();
      invalidate();
      setEditOpen(false);
      toast.success("Container updated");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const deleteEmpty = useMutation({
    mutationFn: () => api.delete<void>(`/containers/${containerId}`),
    onSuccess: () => {
      invalidate();
      toast.success("Container deleted");
      navigate("/containers", { replace: true });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "location_not_empty") {
        setEmptyDeleteOpen(false);
        setTransferMode("delete");
        return;
      }
      toast.error(getApiErrorMessage(error));
    },
  });

  const unlinkOwnership = useMutation({
    mutationFn: () => api.delete<Container>(`/containers/${containerId}/ownership`),
    onSuccess: () => {
      refreshContainer();
      invalidate();
      setUnlinkOpen(false);
      toast.success("Ownership unlinked; the container remains a storage place");
    },
    onError: (error) => {
      setUnlinkOpen(false);
      toast.error(getApiErrorMessage(error));
    },
  });

  if (containerQuery.isPending) return <PageSkeleton variant="detail" />;
  if (containerQuery.isError) {
    return (
      <ErrorState
        title="This container is out of reach"
        message="It may have been deleted, or the link may be out of date."
        onRetry={() => void containerQuery.refetch()}
      />
    );
  }
  const detail = containerQuery.data;
  const identifier = detail.identifier ?? detail.name;
  const roomLabel = detail.room.name;
  const insideLabel = detail.path
    .slice(0, -1)
    .map((entry) => entry.name)
    .join(" / ");

  return (
    <PageLayout
      header={{
        eyebrow: "Container",
        title: identifier,
        description:
          detail.name !== identifier
            ? detail.name
            : detail.is_container
              ? "Unnamed container"
              : "Fixed storage place",
        backTo: "/containers",
        backLabel: "Containers",
        actions: (
          <>
            {canWrite && (
              <Button variant="outline" asChild>
                <Link to={`/labels?ids=${detail.id}`}>
                  <Printer />
                  Print label
                </Link>
              </Button>
            )}
            <Button variant="outline" onClick={() => setQrOpen(true)}>
              <QrCode />
              QR
            </Button>
            <Button variant="outline" onClick={() => setEvidenceOpen(true)}>
              <Download />
              Export evidence
            </Button>
            {canWrite && detail.is_container && !detail.owner_item && (
              <Button variant="outline" onClick={() => setMoveOpen(true)}>
                <Truck />
                Move
              </Button>
            )}
            {canWrite &&
              (detail.total_item_count > 0 || detail.child_count > 0) && (
                <Button variant="outline" onClick={() => setTransferMode("move")}>
                  <MoveRight />
                  Move contents
                </Button>
              )}
            {canWrite && !detail.owner_item && (
              <Button
                variant="outline"
                onClick={() => {
                  if (detail.total_item_count === 0 && detail.child_count === 0) {
                    setEmptyDeleteOpen(true);
                  } else {
                    setTransferMode("delete");
                  }
                }}
              >
                <Trash2 />
                Delete
              </Button>
            )}
          </>
        ),
      }}
    >
      <StocktakeEntry containerId={detail.id} />

      <BorrowedKeptHere locationId={detail.id} />

      <section className="surface mb-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={detail.is_container ? "sage" : "outline"}>
                {detail.is_container
                  ? CONTAINER_TYPE_LABELS[detail.container_type ?? "other"]
                  : "Fixed place"}
              </Badge>
              <span className="text-2xs text-muted-foreground">
                {pluralize(detail.total_item_count, "item")} · {detail.total_quantity} units ·{" "}
                {pluralize(detail.child_count, "nested place")}
              </span>
            </div>
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <MapPin className="size-3.5" />
              {detail.property && (
                <>
                  <span className="font-medium text-foreground/80">{detail.property.name}</span>
                  <ChevronRight className="size-3" />
                </>
              )}
              <span className="font-medium text-foreground/80">{roomLabel}</span>
              {insideLabel && (
                <>
                  <ChevronRight className="size-3" />
                  <span>{insideLabel}</span>
                </>
              )}
            </p>
            <p className="mt-1 text-2xs text-muted-foreground">
              Updated {formatRelativeDate(detail.updated_at)}
              {detail.label_generated_at
                ? ` · label generated ${formatDate(detail.label_generated_at)}`
                : ""}
            </p>
          </div>
          {canWrite && (
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil />
              Edit
            </Button>
          )}
        </div>
        {detail.description && (
          <p className="mt-3 max-w-3xl whitespace-pre-line text-xs leading-relaxed text-foreground/75">
            {detail.description}
          </p>
        )}
      </section>

      <section className="surface mb-4 p-4 sm:p-5">
        <EntityPhotoManager kind="location" entityId={detail.id} name={identifier} />
      </section>

      <section className="surface mb-4 p-3.5 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.13em] text-muted-foreground">
                <PackageOpen className="size-4" />
                Ownership details
              </h2>
              {detail.owner_item ? (
                <Badge variant="sage">Owned item</Badge>
              ) : (
                <Badge variant="outline">Storage only</Badge>
              )}
            </div>
            {detail.owner_item ? (
              <>
                <Link
                  to={`/items/${detail.owner_item.id}`}
                  className="mt-2 block font-display text-[1.25rem] tracking-[-0.02em] underline-offset-4 hover:underline"
                >
                  {detail.owner_item.name}
                </Link>
                <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
                  Purchase, warranty, photos, documents, value, tags and history are kept on
                  this owned item. The container keeps its identifier, QR code and contents.
                </p>
                {detail.owner_item_detail && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {detail.owner_item_detail.purchase && (
                      <Badge variant="outline">Purchase recorded</Badge>
                    )}
                    {detail.owner_item_detail.warranty && (
                      <Badge
                        variant={
                          WARRANTY_STATUS_TONE[detail.owner_item_detail.warranty.status]
                        }
                      >
                        {WARRANTY_STATUS_LABELS[detail.owner_item_detail.warranty.status]}
                      </Badge>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="mt-2 max-w-2xl text-2xs leading-relaxed text-muted-foreground">
                Link an owned item to add purchase, warranty, photos, documents and value.
              </p>
            )}
          </div>
          {canWrite && detail.owner_item && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to={`/items/${detail.owner_item.id}`}>Open owned item</Link>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setUnlinkOpen(true)}>
                Unlink
              </Button>
            </div>
          )}
          {canWrite && !detail.owner_item && (
            <Button variant="outline" size="sm" onClick={() => setOwnershipOpen(true)}>
              <PackageOpen />
              Add ownership details
            </Button>
          )}
        </div>
      </section>

      <section className="mt-8">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-[1.55rem] tracking-[-0.025em]">
              Inside {identifier}
            </h2>
            <p className="mt-1 text-2xs text-muted-foreground">
              {scope === "direct"
                ? "Only items assigned directly to this place."
                : "Direct and nested items, including quantities and photos."}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
              <span>
                {pluralize(detail.summary.item_count, "item")} ·{" "}
                {detail.summary.total_quantity} units total
              </span>
              <span>·</span>
              <span>
                {pluralize(detail.summary.direct_item_count, "item")} ·{" "}
                {detail.summary.direct_total_quantity} directly here
              </span>
              {detail.summary.categories.slice(0, 6).map((category) => (
                <Badge key={category.name} variant="outline">
                  {category.name} · {category.item_count}
                </Badge>
              ))}
            </div>
          </div>
          <AddItemsButton context={addItemsContext} variant="outline" size="sm" />
        </div>

        <div className="surface mb-4 p-3.5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  selection.clearSelection(
                    "Selection cleared because the search changed.",
                  );
                }}
                placeholder="Search inside this place"
                aria-label="Search inside this place"
                className="pl-10"
              />
            </div>
            <div
              className="inline-flex rounded-full border border-border/70 bg-background/50 p-1"
              role="group"
              aria-label="Contents scope"
            >
              {(["nested", "direct"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={scope === value}
                  onClick={() => {
                    selection.clearSelection("Selection cleared because the scope changed.");
                    setSearchParams(
                      (previous) => {
                        const next = new URLSearchParams(previous);
                        if (value === "direct") next.set("scope", "direct");
                        else next.delete("scope");
                        return next;
                      },
                      { replace: true },
                    );
                  }}
                  className={
                    scope === value
                      ? "rounded-full bg-primary px-3 py-1.5 text-2xs font-medium text-primary-foreground"
                      : "rounded-full px-3 py-1.5 text-2xs font-medium text-muted-foreground"
                  }
                >
                  {value === "nested" ? "Include nested" : "Direct only"}
                </button>
              ))}
            </div>
            <Select
              aria-label="Sort items inside this place"
              value={sort}
              onChange={(event) => {
                selection.clearSelection("Selection cleared because the sort changed.");
                setSearchParams(
                  (previous) => {
                    const next = new URLSearchParams(previous);
                    if (event.target.value === "name_asc") next.delete("sort");
                    else next.set("sort", event.target.value);
                    return next;
                  },
                  { replace: true },
                );
              }}
              className="h-9 rounded-lg text-xs lg:max-w-44"
            >
              {Object.entries(ITEM_SORTS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <div className="mt-3 border-t border-border/60 pt-3">
            <BulkSelectionControls
              selection={selection}
              showing={items.length}
              total={totalItems}
            />
          </div>
        </div>

        <BulkSelectionNotice selection={selection} />
        <BulkItemActionBar
          items={selection.selectedItems}
          onClear={() => selection.clearSelection()}
          onNotice={selection.showNotice}
        />

        {itemsQuery.isPending ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-52 rounded-2xl" />
            <Skeleton className="h-52 rounded-2xl" />
          </div>
        ) : itemsQuery.isError ? (
          <ErrorState
            message="We couldn't load the items in this place."
            onRetry={() => void itemsQuery.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title={
              scope === "direct" ? "No direct items here." : "This container is empty."
            }
            description={
              scope === "direct"
                ? "Nested places may still contain items. Switch to Include nested to see them."
                : "Add an item and assign it here, or move an existing item into this place."
            }
            actionLabel="Add items"
            onAction={() => openAddItems(addItemsContext)}
          />
        ) : (
          <>
            <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((item) => (
                <div key={item.id} className="min-w-0">
                  <ItemCard
                    item={item}
                    origin={origin}
                    selection={
                      canWrite
                        ? {
                            selected: selection.selected.has(item.id),
                            onToggle: () => selection.toggleItem(item.id),
                            disabled: item.is_archived,
                          }
                        : undefined
                    }
                  />
                  {scope === "nested" &&
                    item.location?.id !== detail.id &&
                    item.location && (
                      <p className="mt-1.5 flex items-center gap-1 px-1 text-2xs text-muted-foreground">
                        <MapPin className="size-3" />
                        {itemContainer(item)?.identifier ?? item.location.name}
                      </p>
                    )}
                </div>
              ))}
            </div>
            {itemsQuery.hasNextPage && (
              <div className="mt-6 flex justify-center">
                <Button
                  variant="outline"
                  onClick={() => void itemsQuery.fetchNextPage()}
                  disabled={itemsQuery.isFetchingNextPage}
                >
                  {itemsQuery.isFetchingNextPage ? "Loading…" : "Load more items"}
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      {detail.children.length > 0 && (
        <section className="mt-8">
          <h2 className="font-display text-[1.55rem] tracking-[-0.025em]">Nested places</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {detail.children.map((child) => (
              <Link
                key={child.id}
                to={`/containers/${child.id}`}
                className="surface flex items-center justify-between gap-3 p-4 transition-colors hover:bg-secondary/30"
              >
                <div className="min-w-0">
                  <p className="font-display text-[1.2rem] tracking-[-0.02em]">
                    {child.identifier ?? child.name}
                  </p>
                  <p className="truncate text-2xs text-muted-foreground">
                    {child.identifier ? child.name : child.kind} ·{" "}
                    {pluralize(child.total_item_count, "item")}
                  </p>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="surface mt-8 p-5 sm:p-6">
        <h2 className="font-display text-[1.55rem] tracking-[-0.025em]">
          Movement history
        </h2>
        <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
          Container moves describe the contents that moved with it. Items are not given
          duplicate individual move events for an inherited container move.
        </p>
        <div className="mt-4">
          <ActivityTimeline
            events={historyQuery.data?.items ?? []}
            emptyText="No container moves recorded yet."
            onChanged={() => {
              void historyQuery.refetch();
              refreshContainer();
            }}
          />
        </div>
      </section>

      {detail.documents.length > 0 && (
        <section className="mt-8">
          <h2 className="flex items-center gap-2 font-display text-[1.55rem] tracking-[-0.025em]">
            <FileText className="size-4 text-muted-foreground" />
            Related documents
          </h2>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {detail.documents.map((document) => (
              <Link
                key={document.id}
                to={`/documents/${document.id}`}
                className="surface flex items-center justify-between gap-3 p-3.5 text-xs transition-colors hover:bg-secondary/30"
              >
                <span className="truncate">{document.title}</span>
                <Badge variant="outline">{document.document_type.replace("_", " ")}</Badge>
              </Link>
            ))}
          </div>
        </section>
      )}

      <ContainerQrDialog container={detail} open={qrOpen} onOpenChange={setQrOpen} />
      <ContainerOwnershipDialog
        container={detail}
        open={ownershipOpen}
        onOpenChange={setOwnershipOpen}
        onLinked={() => refreshContainer()}
      />
      {detail.is_container && (
        <ContainerMoveDialog
          container={detail}
          open={moveOpen}
          onOpenChange={setMoveOpen}
          rooms={rooms}
          locations={locations}
          onMoved={() => refreshContainer()}
        />
      )}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {identifier}</DialogTitle>
            <DialogDescription>
              The identifier never changes. Moving is separate so its QR code and contents
              stay authoritative.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="container-edit-name" className="text-xs font-medium">
                  Display name
                </label>
                <Input
                  id="container-edit-name"
                  value={editName}
                  maxLength={120}
                  onChange={(event) => setEditName(event.target.value)}
                  className="mt-1.5"
                />
              </div>
              <div>
                <label htmlFor="container-edit-type" className="text-xs font-medium">
                  Type
                </label>
                <Select
                  id="container-edit-type"
                  value={editType}
                  disabled={!detail.is_container}
                  onChange={(event) => setEditType(event.target.value as ContainerType)}
                  className="mt-1.5"
                >
                  {TYPES.map((type) => (
                    <option key={type} value={type}>
                      {CONTAINER_TYPE_LABELS[type]}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div>
              <label htmlFor="container-edit-notes" className="text-xs font-medium">
                Notes
              </label>
              <Textarea
                id="container-edit-notes"
                value={editDescription}
                maxLength={4000}
                onChange={(event) => setEditDescription(event.target.value)}
                className="mt-1.5 min-h-28"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={update.isPending}>
                {update.isPending ? <Spinner /> : <Check />}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <EvidenceExportDialog
        open={evidenceOpen}
        onOpenChange={setEvidenceOpen}
        scope={{ container_ids: [detail.id] }}
        title={`Export ${identifier} with evidence`}
      />

      <ConfirmDialog
        open={unlinkOpen}
        onOpenChange={setUnlinkOpen}
        title={`Unlink ownership from ${identifier}?`}
        description="The container and its contents stay unchanged. The owned item remains in inventory at its current place. Open loans must be returned first."
        confirmLabel="Unlink ownership"
        onConfirm={async () => {
          await unlinkOwnership.mutateAsync();
        }}
      />

      <ConfirmDialog
        open={emptyDeleteOpen}
        onOpenChange={setEmptyDeleteOpen}
        title={`Delete ${identifier}?`}
        description={
          (detail.recoverable_deleted_child_count ?? 0) > 0
            ? `This place has ${detail.recoverable_deleted_child_count} recoverable-deleted nested place(s). Deleting it leaves them without a live parent, so their item-move restoration becomes unavailable. Its own identity and photos are retained. This cannot be undone.`
            : "This place is empty and can be removed. Its identity and photos are retained for eligible item-move restoration. This cannot be undone."
        }
        confirmLabel="Delete place"
        onConfirm={async () => {
          await deleteEmpty.mutateAsync();
        }}
      />

      <PlaceTransferDialog
        open={transferMode !== null}
        onOpenChange={(open) => {
          if (!open) setTransferMode(null);
        }}
        source={transferSource}
        mode={transferMode ?? "move"}
        onCompleted={(result) => {
          if (result.deleted) {
            navigate("/containers", { replace: true });
          } else {
            refreshContainer();
          }
        }}
      />
    </PageLayout>
  );
}
