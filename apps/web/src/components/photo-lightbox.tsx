import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { Photo } from "@/lib/types";
import { cn } from "@/lib/utils";

export function PhotoLightbox({
  open,
  onOpenChange,
  photos,
  initialPhotoId,
  onPhotoChange,
  itemName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  photos: Photo[];
  initialPhotoId: string | null;
  onPhotoChange?: (photoId: string) => void;
  itemName: string;
}) {
  const initialIndex = useMemo(() => {
    const index = photos.findIndex((photo) => photo.id === initialPhotoId);
    return index === -1 ? 0 : index;
  }, [initialPhotoId, photos]);
  const [index, setIndex] = useState(initialIndex);

  useEffect(() => {
    if (open) setIndex(initialIndex);
  }, [open, initialIndex]);

  useEffect(() => {
    if (!open || photos.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        setIndex((current) => (current - 1 + photos.length) % photos.length);
      } else if (event.key === "ArrowRight") {
        setIndex((current) => (current + 1) % photos.length);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, photos.length]);

  useEffect(() => {
    const photo = photos[index];
    if (open && photo) onPhotoChange?.(photo.id);
  }, [index, onPhotoChange, open, photos]);

  if (photos.length === 0) return null;
  const photo = photos[index] ?? photos[0];
  if (!photo) return null;

  const move = (delta: number) => {
    setIndex((current) => (current + delta + photos.length) % photos.length);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        className="h-[100dvh] max-h-none w-screen max-w-none place-items-center gap-0 overflow-hidden rounded-none border-0 bg-[#0d0e0c]/95 p-0 text-white shadow-none"
      >
        <DialogTitle className="sr-only">Photographs of {itemName}</DialogTitle>

        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="absolute right-4 top-4 z-20 flex size-10 items-center justify-center rounded-full bg-white/10 text-white/80 backdrop-blur-md transition-colors hover:bg-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 sm:right-6 sm:top-6"
          aria-label="Close photograph viewer"
        >
          <X className="size-5" />
        </button>

        <div className="relative flex size-full items-center justify-center px-4 py-16 sm:px-16">
          <img
            src={photo.url}
            alt={`${itemName} photograph ${index + 1}`}
            className="max-h-[calc(100dvh-9rem)] max-w-full rounded-lg object-contain shadow-2xl"
          />

          {photos.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => move(-1)}
                className="absolute left-3 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/35 text-white/80 backdrop-blur-md transition-colors hover:bg-black/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 sm:left-6"
                aria-label="Previous photograph"
              >
                <ChevronLeft className="size-6" />
              </button>
              <button
                type="button"
                onClick={() => move(1)}
                className="absolute right-3 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/35 text-white/80 backdrop-blur-md transition-colors hover:bg-black/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 sm:right-6"
                aria-label="Next photograph"
              >
                <ChevronRight className="size-6" />
              </button>
            </>
          )}
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 bg-gradient-to-t from-black/60 to-transparent px-5 pb-6 pt-16 sm:px-8">
          <p className="min-w-0 truncate text-xs text-white/65">{itemName}</p>
          <p className="shrink-0 text-2xs tabular-nums text-white/55">
            {index + 1} / {photos.length}
          </p>
        </div>

        {photos.length > 1 && (
          <div className="absolute bottom-16 left-1/2 flex max-w-[calc(100%-2rem)] -translate-x-1/2 gap-2 overflow-x-auto rounded-2xl bg-black/20 p-2 no-scrollbar sm:bottom-20">
            {photos.map((entry, entryIndex) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setIndex(entryIndex)}
                aria-label={`View photograph ${entryIndex + 1}`}
                aria-current={entryIndex === index}
                className={cn(
                  "size-11 shrink-0 overflow-hidden rounded-lg border transition-opacity",
                  entryIndex === index
                    ? "border-white/80 opacity-100"
                    : "border-transparent opacity-50 hover:opacity-80",
                )}
              >
                <img src={entry.thumbnail_url} alt="" className="size-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
