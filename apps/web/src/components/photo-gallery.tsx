import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, Star, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";

import { CategoryIcon } from "@/components/category-icon";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CameraUpload } from "@/components/camera-upload";
import { PhotoLightbox } from "@/components/photo-lightbox";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import { queryKeys, useInvalidateInventory } from "@/lib/queries";
import type {
  ItemDetail,
  ItemDetailResponse,
  ItemImage,
  Photo,
  PhotoList,
} from "@/lib/types";
import { useCanWrite } from "@/lib/queries";
import { cn } from "@/lib/utils";

const manageButton =
  "flex size-11 items-center justify-center rounded-full border border-border/70 text-foreground/70 transition-colors hover:text-foreground disabled:opacity-30";

/**
 * Small photo thumbnails with an add tile. A thumbnail opens the photograph
 * full screen. Reordering, the cover, deleting and anything passed as
 * `children` (the image source) sit behind "Manage photos".
 */
export function PhotoGallery({
  item,
  representative,
  children,
}: {
  item: ItemDetail;
  representative?: ItemImage | null;
  children?: React.ReactNode;
}) {
  const manageId = useId();
  const [managing, setManaging] = useState(false);
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

  // The image keeps its own shape inside the square, so nothing is cropped.
  const thumbnail =
    "relative flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-secondary/40 p-1";
  const thumbnailImage = "max-h-full max-w-full object-contain";

  return (
    <section aria-label="Photographs">
      <div
        data-testid="photo-strip"
        className="no-scrollbar flex items-stretch gap-2 overflow-x-auto overflow-y-hidden pb-1"
      >
        {item.photos.map((photo, index) => (
          <button
            key={photo.id}
            type="button"
            onClick={() => {
              setActiveId(photo.id);
              if (!managing) setLightboxOpen(true);
            }}
            className={cn(
              thumbnail,
              "transition-[border-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              managing ? "cursor-pointer" : "cursor-zoom-in",
              managing && photo.id === active?.id
                ? "border-2 border-foreground/70"
                : "border-border/75",
            )}
            aria-label={
              managing ? `Choose photograph ${index + 1}` : `View photograph ${index + 1}`
            }
            aria-pressed={managing ? photo.id === active?.id : undefined}
          >
            <img
              src={photo.thumbnail_url}
              alt=""
              loading="lazy"
              className={thumbnailImage}
            />
            {index === 0 && (
              <span
                className="absolute bottom-1 right-1 flex size-4 items-center justify-center rounded-full bg-background/85 text-brass backdrop-blur-sm"
                title="Cover"
              >
                <Star className="size-2.5 fill-current" />
                <span className="sr-only">Cover</span>
              </span>
            )}
          </button>
        ))}

        {item.photos.length === 0 &&
          (representative?.url ? (
            <div
              className={cn(
                thumbnail,
                "border-border/75",
                representative.source_type === "reference" && "bg-white",
              )}
            >
              <img
                src={representative.thumbnail_url ?? representative.url}
                alt={`${item.name} ${representative.label.toLowerCase()}`}
                className={thumbnailImage}
              />
              <span className="absolute inset-x-0 bottom-0 truncate bg-background/85 px-1.5 py-0.5 text-center text-2xs text-muted-foreground backdrop-blur-sm">
                {representative.label}
              </span>
            </div>
          ) : (
            <div
              className={cn(
                thumbnail,
                "image-placeholder flex-col gap-1.5 border-border/75 px-2 text-center",
              )}
            >
              <CategoryIcon category={item.category?.name} className="size-5 text-foreground/35" />
              <span className="text-2xs leading-tight text-muted-foreground">
                No photograph yet
              </span>
            </div>
          ))}

        {canWrite && !atLimit && (
          <div
            className={cn(
              thumbnail,
              "flex-col gap-1.5 border-dashed border-border bg-transparent",
            )}
          >
            {upload.isPending ? (
              <>
                <Spinner className="size-5" />
                <span className="text-2xs text-muted-foreground">Adding…</span>
              </>
            ) : (
              <>
                <CameraUpload
                  compact
                  label="Add item photograph"
                  busy={upload.isPending}
                  onUpload={async (file) => {
                    await upload.mutateAsync([file]);
                  }}
                />
                <span className="text-2xs text-muted-foreground">Add photo</span>
              </>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        aria-expanded={managing}
        aria-controls={manageId}
        onClick={() => setManaging((open) => !open)}
        className="mt-1 inline-flex min-h-11 items-center gap-1 rounded-lg text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {canWrite ? "Manage photos" : "About the image"}
        <ChevronDown
          aria-hidden="true"
          className={cn("size-3.5 transition-transform", managing && "rotate-180")}
        />
      </button>

      {managing && (
        <div id={manageId} className="mt-1 space-y-3">
          {canWrite && active && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-border/65 bg-card/45 px-3.5 py-2">
              <p className="mr-auto text-2xs text-muted-foreground">
                Photograph {activeIndex + 1} of {item.photos.length}
                {activeIsCover ? " · cover" : ""}
                {item.photos.length > 1 ? ". Tap a photo to choose it." : ""}
              </p>
              <button
                type="button"
                onClick={() => moveActive(-1)}
                disabled={activeIndex <= 0 || reorder.isPending}
                className={manageButton}
                aria-label="Move photograph earlier"
              >
                <ChevronLeft className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => moveActive(1)}
                disabled={
                  activeIndex < 0 || activeIndex >= item.photos.length - 1 || reorder.isPending
                }
                className={manageButton}
                aria-label="Move photograph later"
              >
                <ChevronRight className="size-4" />
              </button>
              {!activeIsCover && (
                <button
                  type="button"
                  onClick={() => makeCover.mutate(active.id)}
                  disabled={makeCover.isPending}
                  className={manageButton}
                  aria-label="Set as cover photograph"
                >
                  {makeCover.isPending ? <Spinner className="size-4" /> : <Star className="size-4" />}
                </button>
              )}
              <button
                type="button"
                onClick={() => setPhotoToDelete(active)}
                className={cn(manageButton, "hover:text-destructive")}
                aria-label="Delete photograph"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          )}
          {children}
        </div>
      )}

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
