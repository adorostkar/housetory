import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImageOff, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import { queryKeys, useInvalidateInventory } from "@/lib/queries";
import type { ItemDetail, ItemDetailResponse, Photo, PhotoList } from "@/lib/types";
import { cn } from "@/lib/utils";

export function PhotoGallery({ item }: { item: ItemDetail }) {
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeId, setActiveId] = useState<string | null>(item.photos[0]?.id ?? null);
  const [photoToDelete, setPhotoToDelete] = useState<Photo | null>(null);

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
        response.items.length === 1 ? "Photograph added" : `${response.items.length} photographs added`,
      );
      if (inputRef.current) inputRef.current.value = "";
    },
    onError: (error) => {
      toast.error(getApiErrorMessage(error));
      if (inputRef.current) inputRef.current.value = "";
    },
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

  const active = item.photos.find((photo) => photo.id === activeId) ?? item.photos[0] ?? null;

  return (
    <section aria-label="Photographs">
      <div className="group relative aspect-[4/3] overflow-hidden rounded-2xl border border-border/75 bg-secondary/50">
        {active ? (
          <img
            src={active.url}
            alt={`${item.name} photograph`}
            className="size-full object-cover"
          />
        ) : (
          <div className="image-placeholder flex size-full flex-col items-center justify-center px-6 text-center">
            <span className="flex size-14 items-center justify-center rounded-full border border-foreground/10 bg-background/25 text-foreground/30 backdrop-blur-sm">
              <ImageOff className="size-5" strokeWidth={1.5} />
            </span>
            <p className="mt-4 font-display text-xl tracking-[-0.02em] text-foreground/70">
              A photograph tells the story
            </p>
            <p className="mt-1 max-w-xs text-[0.78rem] leading-relaxed text-muted-foreground">
              Add one or more images so this item is easy to recognise at a glance.
            </p>
            <label
              htmlFor="photo-upload-empty"
              className={cn(buttonVariants({ size: "sm" }), "mt-5 cursor-pointer")}
            >
              <Plus />
              Add photographs
            </label>
            <input
              ref={inputRef}
              id="photo-upload-empty"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              multiple
              className="sr-only"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length) upload.mutate(files);
              }}
            />
          </div>
        )}

        {upload.isPending && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/65 backdrop-blur-sm">
            <Spinner className="size-5" />
            <span className="text-[0.75rem] font-medium text-foreground">Adding photographs…</span>
          </div>
        )}

        {active && (
          <button
            type="button"
            onClick={() => setPhotoToDelete(active)}
            className="absolute right-3 top-3 flex size-9 items-center justify-center rounded-full bg-background/80 text-foreground/70 opacity-100 backdrop-blur-md transition-opacity hover:text-destructive focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
            aria-label="Delete photograph"
          >
            <Trash2 className="size-4" />
          </button>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
        {item.photos.map((photo) => (
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
            aria-label={`View photograph ${photo.sort_order + 1}`}
            aria-pressed={photo.id === active?.id}
          >
            <img src={photo.thumbnail_url} alt="" loading="lazy" className="size-full object-cover" />
          </button>
        ))}

        <label
          htmlFor="photo-upload"
          className={cn(
            buttonVariants({ variant: "outline", size: "icon" }),
            "shrink-0 cursor-pointer border-dashed text-muted-foreground hover:text-foreground",
          )}
          aria-label="Add photographs"
        >
          {upload.isPending ? <Spinner /> : <Plus />}
        </label>
        <input
          id="photo-upload"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          multiple
          className="sr-only"
          disabled={upload.isPending || item.photos.length >= 20}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length) upload.mutate(files);
          }}
        />
      </div>

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
