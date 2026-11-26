import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Star, Trash2, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { CameraUpload } from "@/components/camera-upload";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PhotoLightbox } from "@/components/photo-lightbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  queryKeys,
  useCanWrite,
  useLocationPhotos,
  useRoomPhotos,
} from "@/lib/queries";
import type { Photo, PhotoList } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Photographs of a room or a storage place, kept small.
 *
 * Without photographs nothing is shown until `addOpen` asks for the upload
 * row (the page offers "Add photo" in its menu). With photographs a strip of
 * thumbnails is shown; "Manage" opens the large frame with the edit controls.
 */
export function EntityPhotoManager({
  kind,
  entityId,
  name,
  addOpen = false,
  onAddOpenChange,
}: {
  kind: "room" | "location";
  entityId: string;
  name: string;
  addOpen?: boolean;
  onAddOpenChange?: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const roomPhotos = useRoomPhotos(kind === "room" ? entityId : undefined);
  const locationPhotos = useLocationPhotos(kind === "location" ? entityId : undefined);
  const photos = (kind === "room" ? roomPhotos.data : locationPhotos.data)?.items ?? [];
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [photoToDelete, setPhotoToDelete] = React.useState<Photo | null>(null);
  const [lightboxOpen, setLightboxOpen] = React.useState(false);
  const [managing, setManaging] = React.useState(false);
  const manageId = React.useId();
  const active = photos.find((photo) => photo.id === activeId) ?? photos[0] ?? null;
  const activeIsCover = active?.id === photos[0]?.id;
  const activeIndex = active ? photos.findIndex((photo) => photo.id === active.id) : -1;
  const moveActive = (direction: -1 | 1) => {
    if (activeIndex < 0) return;
    const target = activeIndex + direction;
    if (target < 0 || target >= photos.length) return;
    const ordered = [...photos];
    const current = ordered[activeIndex];
    const replacement = ordered[target];
    if (!current || !replacement) return;
    ordered[activeIndex] = replacement;
    ordered[target] = current;
    reorder.mutate(ordered.map((photo) => photo.id));
  };

  React.useEffect(() => {
    if (!active && photos[0]) setActiveId(photos[0].id);
    if (active && !photos.some((photo) => photo.id === active.id)) {
      setActiveId(photos[0]?.id ?? null);
    }
  }, [active, photos]);

  const key = kind === "room" ? queryKeys.roomPhotos(entityId) : queryKeys.locationPhotos(entityId);
  const setPhotos = (next: Photo[]) => {
    queryClient.setQueryData<PhotoList>(key, { items: next });
  };

  const upload = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append("files", file);
      const route = kind === "room" ? "rooms" : "locations";
      return api.postForm<PhotoList>(`/${route}/${entityId}/photos`, formData);
    },
    onSuccess: (response) => {
      queryClient.setQueryData<PhotoList>(key, (current) => ({
        items: [...(current?.items ?? []), ...response.items],
      }));
      if (response.items[0]) setActiveId(response.items[0].id);
      void queryClient.invalidateQueries({ queryKey: key });
      onAddOpenChange?.(false);
      toast.success("Photograph added");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const reorder = useMutation({
    mutationFn: (photoIds: string[]) => {
      const route = kind === "room" ? "rooms" : "locations";
      return api.put<PhotoList>(`/${route}/${entityId}/photos/order`, {
        photo_ids: photoIds,
      });
    },
    onSuccess: (response) => {
      setPhotos(response.items);
      void queryClient.invalidateQueries({ queryKey: key });
      toast.success("Photograph order updated");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const makeCover = useMutation({
    mutationFn: (photoId: string) =>
      api.post<PhotoList>(`/${kind === "room" ? "rooms" : "locations"}/${entityId}/photos/${photoId}/primary`),
    onSuccess: (response) => {
      setPhotos(response.items);
      void queryClient.invalidateQueries({ queryKey: key });
      toast.success("Cover photo updated");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (photoId: string) =>
      api.delete<void>(`/${kind}-photos/${photoId}`),
    onSuccess: (_data, photoId) => {
      setPhotos(photos.filter((photo) => photo.id !== photoId));
      void queryClient.invalidateQueries({ queryKey: key });
      toast.success("Photograph removed");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  if (photos.length === 0) {
    if (!addOpen || !canWrite) return null;
    return (
      <section
        aria-label={`${name} photographs`}
        className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-dashed border-border bg-secondary/30 px-3.5 py-3"
      >
        <p className="min-w-0 flex-1 basis-40 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Add a photo.</span> It makes this{" "}
          {kind === "room" ? "room" : "place"} easier to recognise.
        </p>
        <CameraUpload
          busy={upload.isPending}
          onUpload={async (file) => {
            await upload.mutateAsync(file);
          }}
        />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => onAddOpenChange?.(false)}
          aria-label="Close add photo"
        >
          <X />
        </Button>
        {upload.isPending && (
          <p className="flex w-full items-center gap-2 text-xs text-muted-foreground" role="status">
            <Spinner /> Uploading photograph…
          </p>
        )}
      </section>
    );
  }

  return (
    <section aria-label={`${name} photographs`}>
      <div className="flex items-center gap-2 overflow-x-auto overflow-y-hidden pb-1 no-scrollbar">
        {photos.map((photo, index) => (
          <button
            key={photo.id}
            type="button"
            onClick={() => {
              setActiveId(photo.id);
              if (!managing) setLightboxOpen(true);
            }}
            className={cn(
              "relative size-14 shrink-0 overflow-hidden rounded-xl border-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              managing && photo.id === active?.id
                ? "border-foreground/70"
                : "border-transparent",
              managing && photo.id !== active?.id && "opacity-70",
            )}
            aria-label={`View photograph ${index + 1}`}
            aria-pressed={managing ? photo.id === active?.id : undefined}
          >
            <img
              src={photo.thumbnail_url}
              alt=""
              className="size-full object-cover"
              loading="lazy"
            />
          </button>
        ))}
        {canWrite && photos.length < 20 && (
          <CameraUpload
            compact
            busy={upload.isPending}
            onUpload={async (file) => {
              await upload.mutateAsync(file);
            }}
          />
        )}
        {canWrite && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0"
            aria-expanded={managing}
            aria-controls={manageId}
            aria-label={managing ? "Done managing photographs" : "Manage photographs"}
            onClick={() => setManaging((open) => !open)}
          >
            {managing ? "Done" : "Manage"}
          </Button>
        )}
        {canWrite && upload.isPending && (
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground" role="status">
            <Spinner /> Uploading…
          </span>
        )}
      </div>
      {managing && active && (
        <div
          id={manageId}
          data-testid="entity-photo-frame"
          className="group relative mt-3 h-52 overflow-hidden rounded-2xl border border-border/75 bg-secondary/50 sm:h-64"
        >
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="size-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
            aria-label={`View ${name} photograph full screen`}
          >
            <img
              src={active.url}
              alt={`${name} photograph`}
              className="size-full object-cover"
            />
          </button>
          {activeIsCover && (
            <Badge variant="secondary" className="absolute left-3 top-3 gap-1 bg-background/80 backdrop-blur">
              <Star className="size-3 fill-current" /> Cover
            </Badge>
          )}
          <div className="absolute right-3 top-3 flex gap-1.5">
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="bg-background/80 backdrop-blur"
              disabled={activeIndex <= 0 || reorder.isPending}
              onClick={() => moveActive(-1)}
              aria-label="Move photograph earlier"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="bg-background/80 backdrop-blur"
              disabled={
                activeIndex < 0 || activeIndex >= photos.length - 1 || reorder.isPending
              }
              onClick={() => moveActive(1)}
              aria-label="Move photograph later"
            >
              <ChevronRight className="size-4" />
            </Button>
            {!activeIsCover && (
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="bg-background/80 backdrop-blur"
                disabled={makeCover.isPending}
                onClick={() => makeCover.mutate(active.id)}
                aria-label="Set as cover photograph"
              >
                {makeCover.isPending ? <Spinner className="size-4" /> : <Star className="size-4" />}
              </Button>
            )}
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="bg-background/80 backdrop-blur"
              onClick={() => setPhotoToDelete(active)}
              aria-label="Delete photograph"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
      )}
      <PhotoLightbox
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        photos={photos}
        initialPhotoId={active?.id ?? null}
        onPhotoChange={setActiveId}
        itemName={name}
      />
      <ConfirmDialog
        open={Boolean(photoToDelete)}
        onOpenChange={(open) => !open && setPhotoToDelete(null)}
        title="Remove this photograph?"
        description="The image will be deleted from this place. This cannot be undone."
        confirmLabel="Remove photograph"
        onConfirm={async () => {
          if (photoToDelete) await remove.mutateAsync(photoToDelete.id);
          setPhotoToDelete(null);
        }}
      />
    </section>
  );
}
