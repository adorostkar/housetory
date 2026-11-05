import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ImageOff, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { CameraUpload } from "@/components/camera-upload";
import { PhotoLightbox } from "@/components/photo-lightbox";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import { queryKeys, useInvalidateInventory } from "@/lib/queries";
import type { ItemDetail, ItemDetailResponse, Photo, PhotoList } from "@/lib/types";
import { useCanWrite } from "@/lib/queries";
import { cn } from "@/lib/utils";

export function PhotoGallery({ item }: { item: ItemDetail }) {
  const canWrite = useCanWrite();
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(item.photos[0]?.id ?? null);
  const [photoToDelete, setPhotoToDelete] = useState<Photo | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    if (activeId && !item.photos.some((photo) => photo.id === activeId)) {
      setActiveId(item.photos[0]?.id ?? null);
    }
    if (!activeId && item.photos[0]) {
      setActiveId(item.photos[0].id);
    }
  }, [item.photos, activeId]);

  const upload = useMutation({
    mutationFn: (files: File[]) => {
      const formData = new FormData();
      files.forEach((file) => formData.append("files", file));
      return api.postForm<PhotoList>(`/items/${item.id}/photos`, formData);
    },
    onSuccess: (response) => {
      queryClient.setQueryData<ItemDetailResponse>(queryKeys.item(item.id), (current) => {
        if (!current) return current;
        return {
          ...current,
          item: { ...current.item, photos: [...current.item.photos, ...response.items] },
        };
      });
      invalidate();
      const first = response.items[0];
      if (first) setActiveId(first.id);
      toast.success(
        response.items.length === 1
          ? "Photograph added"
          : `${response.items.length} photographs added`,
      );
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (photoId: string) => api.delete<void>(`/photos/${photoId}`),
    onSuccess: (_data, photoId) => {
      queryClient.setQueryData<ItemDetailResponse>(queryKeys.item(item.id), (current) => {
        if (!current) return current;
        return {
          ...current,
          item: {
            ...current.item,
            photos: current.item.photos.filter((photo) => photo.id !== photoId),
          },
        };
      });
      setActiveId((current) => {
        if (current !== photoId) return current;
        return item.photos.find((photo) => photo.id !== photoId)?.id ?? null;
      });
      invalidate();
      toast.success("Photograph removed");
    },
  });

  const reorder = useMutation({
    mutationFn: (photoIds: string[]) =>
      api.put<PhotoList>(`/items/${item.id}/photos/order`, { photo_ids: photoIds }),
    onSuccess: (response) => {
      queryClient.setQueryData<ItemDetailResponse>(queryKeys.item(item.id), (current) => {
        if (!current) return current;
        return { ...current, item: { ...current.item, photos: response.items } };
      });
      invalidate();
      toast.success("Photograph order updated");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const makeCover = useMutation({
    mutationFn: (photoId: string) =>
      api.post<PhotoList>(`/items/${item.id}/photos/${photoId}/primary`),
    onSuccess: (response) => {
      queryClient.setQueryData<ItemDetailResponse>(queryKeys.item(item.id), (current) => {
        if (!current) return current;
        return { ...current, item: { ...current.item, photos: response.items } };
      });
      invalidate();
      toast.success("Cover photograph updated");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const active = item.photos.find((photo) => photo.id === activeId) ?? item.photos[0] ?? null;
  const activeIndex = active ? item.photos.findIndex((photo) => photo.id === active.id) : -1;
  const moveActive = (direction: -1 | 1) => {
    if (activeIndex < 0) return;
    const target = activeIndex + direction;
    if (target < 0 || target >= item.photos.length) return;
    const ordered = [...item.photos];
    const current = ordered[activeIndex];
    const replacement = ordered[target];
    if (!current || !replacement) return;
    ordered[activeIndex] = replacement;
    ordered[target] = current;
    reorder.mutate(ordered.map((photo) => photo.id));
  };
  const cover = item.photos[0] ?? null;
  const activeIsCover = Boolean(active && cover && active.id === cover.id);
  const atLimit = item.photos.length >= 20;

  return (
    <section aria-label="Photographs">
      <div
        className={cn(
          "group relative overflow-hidden rounded-2xl border border-border/75 bg-secondary/50",
          active ? "aspect-[4/3]" : "min-h-[180px]",
        )}
      >
        {active ? (
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="size-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
            aria-label={`View ${item.name} photograph full screen`}
          >
            <img
              src={active.url}
              alt={`${item.name} photograph`}
              className="size-full object-cover"
            />
          </button>
        ) : (
          <div className="image-placeholder flex min-h-[180px] flex-col items-center justify-center px-5 py-6 text-center">
            <span className="flex size-10 items-center justify-center rounded-full border border-foreground/10 bg-background/25 text-foreground/30 backdrop-blur-sm">
              <ImageOff className="size-4" strokeWidth={1.5} />
            </span>
            <p className="mt-3 text-[0.82rem] font-medium text-foreground/75">
              No photograph yet
            </p>
            <p className="mt-1 max-w-xs text-[0.72rem] leading-relaxed text-muted-foreground">
              Take a photo or choose one so this item is easy to recognise.
            </p>
            {canWrite && (
              <div className="mt-4">
                <CameraUpload
                  label="Add item photograph"
                  busy={upload.isPending}
                  onUpload={async (file) => {
                    await upload.mutateAsync([file]);
                  }}
                />
              </div>
            )}
          </div>
        )}

        {active && (
          <>
            {activeIsCover && (
              <Badge
                variant="secondary"
                className="absolute left-3 top-3 z-10 gap-1 bg-background/80 backdrop-blur-md"
              >
                <Star className="size-3 fill-current" />
                Cover
              </Badge>
            )}
            {canWrite && <div className="absolute right-3 top-3 z-10 flex gap-1.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
              <button
                type="button"
                onClick={() => moveActive(-1)}
                disabled={activeIndex <= 0 || reorder.isPending}
                className="flex size-9 items-center justify-center rounded-full bg-background/80 text-foreground/70 backdrop-blur-md transition-colors hover:text-foreground disabled:opacity-30"
                aria-label="Move photograph earlier"
              >
                <ChevronLeft className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => moveActive(1)}
                disabled={activeIndex < 0 || activeIndex >= item.photos.length - 1 || reorder.isPending}
                className="flex size-9 items-center justify-center rounded-full bg-background/80 text-foreground/70 backdrop-blur-md transition-colors hover:text-foreground disabled:opacity-30"
                aria-label="Move photograph later"
              >
                <ChevronRight className="size-4" />
              </button>
              {!activeIsCover && (
                <button
                  type="button"
                  onClick={() => makeCover.mutate(active.id)}
                  disabled={makeCover.isPending}
                  className="flex size-9 items-center justify-center rounded-full bg-background/80 text-foreground/70 backdrop-blur-md transition-colors hover:text-brass disabled:opacity-50"
                  aria-label="Set as cover photograph"
                >
                  {makeCover.isPending ? (
                    <Spinner className="size-4" />
                  ) : (
                    <Star className="size-4" />
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => setPhotoToDelete(active)}
                className="flex size-9 items-center justify-center rounded-full bg-background/80 text-foreground/70 backdrop-blur-md transition-colors hover:text-destructive"
                aria-label="Delete photograph"
              >
                <Trash2 className="size-4" />
              </button>
            </div>}
          </>
        )}

        {canWrite && upload.isPending && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background/65 backdrop-blur-sm">
            <Spinner className="size-5" />
            <span className="text-[0.75rem] font-medium text-foreground">
              Adding photographs…
            </span>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
        {item.photos.map((photo, index) => (
          <button
            key={photo.id}
            type="button"
            onClick={() => setActiveId(photo.id)}
            className={cn(
              "relative size-16 shrink-0 overflow-hidden rounded-xl border-2 transition-[border-color,opacity] sm:size-20",
              photo.id === active?.id
                ? "border-foreground/70"
                : "border-transparent opacity-65 hover:opacity-100",
            )}
            aria-label={`View photograph ${index + 1}`}
            aria-pressed={photo.id === active?.id}
          >
            <img
              src={photo.thumbnail_url}
              alt=""
              loading="lazy"
              className="size-full object-cover"
            />
            {index === 0 && (
              <span className="absolute bottom-1 right-1 flex size-4 items-center justify-center rounded-full bg-background/85 text-brass backdrop-blur-sm">
                <Star className="size-2.5 fill-current" />
              </span>
            )}
          </button>
        ))}

        {canWrite && !atLimit && (
          <CameraUpload
            compact
            label="Add item photograph"
            busy={upload.isPending}
            onUpload={async (file) => {
              await upload.mutateAsync([file]);
            }}
          />
        )}
      </div>

      <PhotoLightbox
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        photos={item.photos}
        initialPhotoId={active?.id ?? null}
        onPhotoChange={setActiveId}
        itemName={item.name}
      />

      <ConfirmDialog
        open={Boolean(photoToDelete)}
        onOpenChange={(open) => {
          if (!open) setPhotoToDelete(null);
        }}
        title="Remove this photograph?"
        description="The image will be deleted from the item. This cannot be undone."
        confirmLabel="Remove photograph"
        onConfirm={async () => {
          if (!photoToDelete) return;
          await remove.mutateAsync(photoToDelete.id);
          setPhotoToDelete(null);
        }}
      />
    </section>
  );
}
