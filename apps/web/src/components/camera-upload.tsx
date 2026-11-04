import { Camera, Check, ImagePlus, RotateCcw, X } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

export function CameraUpload({
  onUpload,
  busy = false,
  compact = false,
  label = "Add photographs",
  showLibrary = true,
}: {
  onUpload: (file: File) => Promise<void>;
  busy?: boolean;
  compact?: boolean;
  label?: string;
  showLibrary?: boolean;
}) {
  const cameraRef = React.useRef<HTMLInputElement>(null);
  const libraryRef = React.useRef<HTMLInputElement>(null);
  const [pending, setPending] = React.useState<{ file: File; url: string } | null>(null);
  const [uploading, setUploading] = React.useState(false);

  React.useEffect(
    () => () => {
      if (pending) URL.revokeObjectURL(pending.url);
    },
    [pending],
  );

  const select = (file: File | undefined) => {
    if (!file) return;
    setPending({ file, url: URL.createObjectURL(file) });
  };

  const close = () => {
    if (pending) URL.revokeObjectURL(pending.url);
    setPending(null);
  };

  const upload = async () => {
    if (!pending) return;
    setUploading(true);
    try {
      await onUpload(pending.file);
      close();
    } finally {
      setUploading(false);
    }
  };

  const buttons = compact ? (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => cameraRef.current?.click()}
        className="flex size-10 items-center justify-center rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        aria-label="Take a photo"
        disabled={busy || uploading}
      >
        <Camera className="size-4" />
      </button>
      {showLibrary && (
        <button
          type="button"
          onClick={() => libraryRef.current?.click()}
          className="flex size-10 items-center justify-center rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="Choose a photo"
          disabled={busy || uploading}
        >
          <ImagePlus className="size-4" />
        </button>
      )}
    </div>
  ) : (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button type="button" size="sm" onClick={() => cameraRef.current?.click()} disabled={busy || uploading}>
        <Camera />
        Take photo
      </Button>
      {showLibrary && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => libraryRef.current?.click()}
          disabled={busy || uploading}
        >
          <ImagePlus />
          Choose photo
        </Button>
      )}
    </div>
  );

  return (
    <>
      {buttons}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(event) => {
          select(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <input
        ref={libraryRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        multiple
        className="sr-only"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length === 1) select(files[0]);
          else if (files.length > 1) {
            void Promise.all(files.map((file) => onUpload(file)));
          }
        }}
      />
      <Dialog open={Boolean(pending)} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              Preview the photograph, retake it, or upload it to Housetory. The image is
              orientated and stripped of metadata by the server.
            </DialogDescription>
          </DialogHeader>
          {pending && (
            <div className="overflow-hidden rounded-xl border border-border bg-secondary/30">
              <img
                src={pending.url}
                alt="Captured photograph preview"
                className="max-h-[55vh] w-full object-contain"
              />
            </div>
          )}
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button type="button" variant="ghost" onClick={close} disabled={uploading}>
              <X />
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                close();
                cameraRef.current?.click();
              }}
              disabled={uploading}
            >
              <RotateCcw />
              Retake
            </Button>
            <Button type="button" onClick={upload} disabled={uploading || !pending}>
              {uploading ? <Spinner /> : <Check />}
              Upload photograph
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
