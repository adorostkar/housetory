import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  FileText,
  MapPin,
  Pencil,
  Printer,
  QrCode,
  Sparkles,
  Truck,
} from "lucide-react";
import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";

import {
  AddItemsButton,
  useAddItems,
  useRegisterAddItemsContext,
} from "@/components/add-items";
import {
  ContainerMoveDialog,
  ContainerQrDialog,
} from "@/components/container-dialogs";
import { EmptyState } from "@/components/empty-state";
import { EntityPhotoManager } from "@/components/entity-photo-manager";
import { ErrorState } from "@/components/error-state";
import { ItemCard } from "@/components/item-card";
import { PageHeader } from "@/components/page-header";
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
import { api, getApiErrorMessage } from "@/lib/api";
import {
  queryKeys,
  useContainer,
  useInvalidateInventory,
  useLocations,
  useRooms,
} from "@/lib/queries";
import type { Container, ContainerType } from "@/lib/types";
import {
  CONTAINER_TYPE_LABELS,
  formatDate,
  formatRelativeDate,
  itemContainer,
  pluralize,
} from "@/lib/utils";

const TYPES: ContainerType[] = ["box", "bin", "crate", "suitcase", "bag", "other"];

export function ContainerDetailPage() {
  const { containerId = "" } = useParams();
  const containerQuery = useContainer(containerId);
  const roomsQuery = useRooms();
  const locationsQuery = useLocations();
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const [qrOpen, setQrOpen] = React.useState(false);
  const [moveOpen, setMoveOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [summaryEditing, setSummaryEditing] = React.useState(false);
  const [editName, setEditName] = React.useState("");
  const [editDescription, setEditDescription] = React.useState("");
  const [editType, setEditType] = React.useState<ContainerType>("box");
  const [headline, setHeadline] = React.useState("");
  const [short, setShort] = React.useState("");
  const [detailed, setDetailed] = React.useState("");
  const container = containerQuery.data;
  const rooms = roomsQuery.data?.items ?? [];
  const locations = locationsQuery.data?.items ?? [];
  const { openAddItems } = useAddItems();
  const addItemsContext = React.useMemo(
    () =>
      container
        ? {
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
    if (!container) return;
    setEditName(container.name);
    setEditDescription(container.description ?? "");
    setEditType(container.container_type ?? "box");
    setHeadline(container.summary.headline ?? "");
    setShort(container.summary.short);
    setDetailed(container.summary.detailed);
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

  const regenerate = useMutation({
    mutationFn: () => api.post<{ summary: unknown }>(`/containers/${containerId}/summary`),
    onSuccess: () => {
      refreshContainer();
      toast.success("Deterministic summary regenerated");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const aiSummary = useMutation({
    mutationFn: () =>
      api.post<{ used_ai: boolean; notice: string | null }>(
        `/containers/${containerId}/summary/ai`,
      ),
    onSuccess: (result) => {
      refreshContainer();
      toast.success(result.notice ?? "Summary updated");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const saveSummary = useMutation({
    mutationFn: () =>
      api.patch(`/containers/${containerId}/summary`, {
        headline: headline.trim() || null,
        short: short.trim() || null,
        detailed: detailed.trim() || null,
      }),
    onSuccess: () => {
      refreshContainer();
      setSummaryEditing(false);
      toast.success("Summary saved");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  if (containerQuery.isPending) return <ContainerDetailSkeleton />;
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
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Container"
        title={identifier}
        description={
          detail.name !== identifier
            ? detail.name
            : detail.is_container
              ? "Unnamed container"
              : "Fixed storage place"
        }
        backTo="/containers"
        backLabel="Containers"
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to={`/labels?ids=${detail.id}`}>
                <Printer />
                Print label
              </Link>
            </Button>
            <Button variant="outline" onClick={() => setQrOpen(true)}>
              <QrCode />
              QR
            </Button>
            {detail.is_container && (
              <Button variant="outline" onClick={() => setMoveOpen(true)}>
                <Truck />
                Move
              </Button>
            )}
            <AddItemsButton context={addItemsContext} />
          </>
        }
      />

      <section className="surface mb-4 p-4 sm:p-5">
        <EntityPhotoManager kind="location" entityId={detail.id} name={identifier} />
      </section>

      <section className="surface p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={detail.is_container ? "sage" : "outline"}>
                {detail.is_container
                  ? CONTAINER_TYPE_LABELS[detail.container_type ?? "other"]
                  : "Fixed place"}
              </Badge>
              <span className="text-[0.75rem] text-muted-foreground">
                {pluralize(detail.total_item_count, "item")} · {detail.total_quantity} units ·{" "}
                {pluralize(detail.child_count, "nested place")}
              </span>
            </div>
            <p className="mt-3 flex flex-wrap items-center gap-1.5 text-[0.82rem] text-muted-foreground">
              <MapPin className="size-3.5" />
              <span className="font-medium text-foreground/80">{roomLabel}</span>
              {insideLabel && (
                <>
                  <ChevronRight className="size-3" />
                  <span>{insideLabel}</span>
                </>
              )}
            </p>
            <p className="mt-1 text-[0.7rem] text-muted-foreground">
              Updated {formatRelativeDate(detail.updated_at)}
              {detail.label_generated_at
                ? ` · label generated ${formatDate(detail.label_generated_at)}`
                : ""}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil />
            Edit
          </Button>
        </div>
        {detail.description && (
          <p className="mt-4 max-w-3xl whitespace-pre-line text-[0.82rem] leading-relaxed text-foreground/75">
            {detail.description}
          </p>
        )}
      </section>

      <section className="surface mt-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 font-display text-[1.45rem] tracking-[-0.025em]">
              <Sparkles className="size-4 text-brass" />
              Contents summary
            </h2>
            <p className="mt-1 text-[0.72rem] text-muted-foreground">
              {detail.summary.source === "ai"
                ? "AI headline with deterministic item lines"
                : detail.summary.source === "manual"
                  ? "Manually edited snapshot"
                  : "Generated only from actual inventory records"}
              {detail.summary.generated_at
                ? ` · ${formatDate(detail.summary.generated_at)}`
                : " · not generated yet"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={regenerate.isPending}
              onClick={() => regenerate.mutate()}
            >
              {regenerate.isPending ? <Spinner /> : <Sparkles />}
              Regenerate
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={aiSummary.isPending}
              onClick={() => aiSummary.mutate()}
            >
              {aiSummary.isPending ? <Spinner /> : <Sparkles />}
              AI headline
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSummaryEditing(true)}>
              <Pencil />
              Edit summary
            </Button>
          </div>
        </div>

        {(detail.summary.stale || detail.summary.label_stale) && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-brass/25 bg-brass-soft/45 px-3.5 py-2.5 text-[0.73rem] leading-relaxed text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-brass" />
            <span>
              {detail.summary.label_stale
                ? "Contents changed after the last label was generated. The QR still opens live data; reprint the label if you want fresh printed text."
                : "The saved summary no longer matches the current contents. Regenerate before printing."}
            </span>
          </div>
        )}

        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(260px,0.7fr)]">
          <div className="rounded-xl border border-border/60 bg-background/35 p-4">
            {detail.summary.headline && (
              <p className="font-display text-[1.28rem] tracking-[-0.02em]">
                {detail.summary.headline}
              </p>
            )}
            <p className="mt-1 whitespace-pre-line text-[0.84rem] leading-[1.75] text-foreground/80">
              {detail.summary.short}
            </p>
          </div>
          <div className="rounded-xl border border-border/60 bg-secondary/25 p-4">
            <p className="eyebrow">Detailed</p>
            <p className="mt-2 whitespace-pre-line text-[0.74rem] leading-[1.7] text-muted-foreground">
              {detail.summary.detailed}
            </p>
          </div>
        </div>
      </section>

      <section className="mt-8">
        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-[1.55rem] tracking-[-0.025em]">
              Inside {identifier}
            </h2>
            <p className="mt-1 text-[0.75rem] text-muted-foreground">
              Direct and nested items, including quantities and photos.
            </p>
          </div>
          <AddItemsButton
            context={addItemsContext}
            variant="outline"
            size="sm"
          />
        </div>
        {detail.items.length === 0 ? (
          <EmptyState
            title="This container is empty."
            description="Add an item and assign it here, or move an existing item into this container from its detail page."
            actionLabel="Add items"
            onAction={() => openAddItems(addItemsContext)}
          />
        ) : (
          <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {detail.items.map((item) => (
              <div key={item.id} className="min-w-0">
                <ItemCard item={item} />
                {item.location?.id !== detail.id && item.location && (
                  <p className="mt-1.5 flex items-center gap-1 px-1 text-[0.66rem] text-muted-foreground">
                    <MapPin className="size-3" />
                    {itemContainer(item)?.identifier ?? item.location.name}
                  </p>
                )}
              </div>
            ))}
          </div>
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
                  <p className="truncate text-[0.72rem] text-muted-foreground">
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
                className="surface flex items-center justify-between gap-3 p-3.5 text-[0.8rem] transition-colors hover:bg-secondary/30"
              >
                <span className="truncate">{document.title}</span>
                <Badge variant="outline">{document.document_type.replace("_", " ")}</Badge>
              </Link>
            ))}
          </div>
        </section>
      )}

      <ContainerQrDialog container={detail} open={qrOpen} onOpenChange={setQrOpen} />
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
                <label htmlFor="container-edit-name" className="text-[0.78rem] font-medium">
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
                <label htmlFor="container-edit-type" className="text-[0.78rem] font-medium">
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
              <label htmlFor="container-edit-notes" className="text-[0.78rem] font-medium">
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
      <Dialog open={summaryEditing} onOpenChange={setSummaryEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit summary snapshot</DialogTitle>
            <DialogDescription>
              This text is printed on labels until the contents change. The QR always
              opens current inventory.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              saveSummary.mutate();
            }}
          >
            <div>
              <label htmlFor="summary-headline" className="text-[0.78rem] font-medium">
                Headline
              </label>
              <Input
                id="summary-headline"
                value={headline}
                maxLength={240}
                onChange={(event) => setHeadline(event.target.value)}
                className="mt-1.5"
                placeholder="Winter clothing"
              />
            </div>
            <div>
              <label htmlFor="summary-short" className="text-[0.78rem] font-medium">
                Short contents
              </label>
              <Textarea
                id="summary-short"
                value={short}
                maxLength={4000}
                onChange={(event) => setShort(event.target.value)}
                className="mt-1.5 min-h-24"
              />
            </div>
            <div>
              <label htmlFor="summary-detailed" className="text-[0.78rem] font-medium">
                Detailed contents
              </label>
              <Textarea
                id="summary-detailed"
                value={detailed}
                maxLength={4000}
                onChange={(event) => setDetailed(event.target.value)}
                className="mt-1.5 min-h-28"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setSummaryEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saveSummary.isPending}>
                {saveSummary.isPending ? <Spinner /> : <Check />}
                Save summary
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ContainerDetailSkeleton() {
  return (
    <div>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-14 w-64" />
      <Skeleton className="mt-8 h-36 rounded-2xl" />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-44 rounded-2xl" />
        <Skeleton className="h-44 rounded-2xl" />
      </div>
    </div>
  );
}
