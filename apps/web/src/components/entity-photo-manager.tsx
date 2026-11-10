import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ImageOff, Star, Trash2 } from "lucide-react";
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

export function EntityPhotoManager({
  kind,
  entityId,
  name,
}: {
  kind: "room" | "location";
  entityId: string;
  name: string;
}) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const roomPhotos = useRoomPhotos(kind === "room" ? entityId : undefined);
  const locationPhotos = useLocationPhotos(kind === "location" ? entityId : undefined);
  const photos = (kind === "room" ? roomPhotos.data : locationPhotos.data)?.items ?? [];
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [photoToDelete, setPhotoToDelete] = React.useState<Photo | null>(null);
  const [lightboxOpen, setLightboxOpen] = React.useState(false);
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

  return (
    <section aria-label={`${name} photographs`}>
      <div
        data-testid="entity-photo-frame"
        className={cn(
          "group relative overflow-hidden rounded-2xl border border-border/75 bg-secondary/50",
          active ? "h-52 sm:h-64 lg:h-72" : "min-h-[176px]",
        )}
      >
        {active ? (
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
        ) : (
          <div className="flex min-h-[176px] flex-col items-center justify-center gap-3 px-4 py-5 text-center sm:min-h-[184px] sm:flex-row sm:justify-start sm:gap-4 sm:text-left">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-background/60 text-muted-foreground">
              <ImageOff className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-display text-lg tracking-[-0.02em] text-foreground/80">
                Add a photograph
              </p>
              <p className="mt-0.5 max-w-md text-2xs leading-relaxed text-muted-foreground">
                Take or choose a photo so this {kind === "room" ? "room" : "place"} is easier
                to recognise later.
              </p>
            </div>
            {canWrite ? (
              <div className="shrink-0">
                <CameraUpload
                  busy={upload.isPending}
                  onUpload={async (file) => {
                    await upload.mutateAsync(file);
                  }}
                />
              </div>
            ) : (
              <p className="text-2xs leading-relaxed text-muted-foreground">
                Viewers can browse photographs but cannot upload or change them.
              </p>
            )}
          </div>
        )}
        {active && activeIsCover && (
          <Badge variant="secondary" className="absolute left-3 top-3 gap-1 bg-background/80 backdrop-blur">
            <Star className="size-3 fill-current" /> Cover
          </Badge>
        )}
        {active && canWrite && (
          <div className="absolute right-3 top-3 flex gap-1.5">
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="size-9 bg-background/80 backdrop-blur"
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
              className="size-9 bg-background/80 backdrop-blur"
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
                className="size-9 bg-background/80 backdrop-blur"
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
              className="size-9 bg-background/80 backdrop-blur"
              onClick={() => setPhotoToDelete(active)}
              aria-label="Delete photograph"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        )}
        {canWrite && upload.isPending && (
          <div className="absolute inset-0 z-20 flex items-center justify-center gap-2 bg-background/65 text-xs backdrop-blur-sm">
            <Spinner /> Uploading photograph…
          </div>
        )}
      </div>
      {photos.length > 0 && (
        <div className="mt-3 flex items-center gap-2 overflow-x-auto overflow-y-hidden pb-1 no-scrollbar">
          {photos.map((photo, index) => (
            <button
              key={photo.id}
              type="button"
              onClick={() => setActiveId(photo.id)}
              className={cn(
                "relative size-16 shrink-0 overflow-hidden rounded-xl border-2",
                photo.id === active?.id
                  ? "border-foreground/70"
                  : "border-transparent opacity-70",
              )}
              aria-label={`View photograph ${index + 1}`}
              aria-pressed={photo.id === active?.id}
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
