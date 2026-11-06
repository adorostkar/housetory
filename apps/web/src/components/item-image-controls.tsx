import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ImageOff,
  ImagePlus,
  Info,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  queryKeys,
  useCanWrite,
  useItemImage,
} from "@/lib/queries";
import type { ItemImage, ItemImageState } from "@/lib/types";

function sourceNote(image: ItemImage) {
  if (image.source_type === "reference") {
    return image.exact_model_confirmed
      ? `Exact model reference${image.model_label ? ` · ${image.model_label}` : ""}`
      : "Reference image · exact model not confirmed";
  }
  return `AI illustration${image.provider_label ? ` · ${image.provider_label}` : ""} · not a photo`;
}

function PendingPreview({
  image,
  busy,
  onAccept,
  onReject,
}: {
  image: ItemImage;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/65 bg-background/45 p-2.5">
      {image.thumbnail_url ? (
        <img
          src={image.thumbnail_url}
          alt="Pending AI illustration preview"
          className="size-16 rounded-lg border border-border/60 object-cover"
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="text-[0.74rem] font-medium">AI illustration preview</p>
        <p className="text-[0.66rem] text-muted-foreground">
          Generated from product text only. Review before using it on cards.
        </p>
      </div>
      <div className="flex gap-1.5">
        <Button type="button" size="sm" disabled={busy} onClick={onAccept}>
          {busy ? <Spinner /> : <Check />}
          Use
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onReject}>
          Reject
        </Button>
      </div>
    </div>
  );
}

export function ItemImageControls({ itemId }: { itemId: string }) {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const imageQuery = useItemImage(itemId);
  const state = imageQuery.data;
  const [busyAction, setBusyAction] = React.useState<string | null>(null);

  const setState = (next: ItemImageState) => {
    queryClient.setQueryData(queryKeys.itemImage(itemId), next);
    void queryClient.invalidateQueries({ queryKey: queryKeys.item(itemId) });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.items,
      predicate: (query) => query.queryKey[2] !== "image",
    });
  };

  const run = (name: string, action: () => Promise<ItemImageState>, success: string) => {
    setBusyAction(name);
    action()
      .then((next) => {
        setState(next);
        toast.success(success);
      })
      .catch((error) => toast.error(getApiErrorMessage(error)))
      .finally(() => setBusyAction(null));
  };

  const findImage = () =>
    run(
      "find",
      () =>
        api.post<ItemImageState>(`/items/${itemId}/image/find`, {
          force: Boolean(state?.selected),
        }),
      state?.selected?.source_type === "reference"
        ? "Reference image updated"
        : "Reference image added",
    );

  const generate = () =>
    run(
      "generate",
      () => api.post<ItemImageState>(`/items/${itemId}/illustration`),
      "Illustration generated for review",
    );

  const remove = () =>
    run(
      "remove",
      () => api.delete<ItemImageState>(`/items/${itemId}/image`),
      "Selected image removed",
    );

  const accept = (imageId: string) =>
    run(
      "accept",
      () => api.post<ItemImageState>(`/items/${itemId}/images/${imageId}/accept`),
      "AI illustration accepted",
    );

  const reject = (imageId: string) =>
    run(
      "reject",
      () => api.delete<ItemImageState>(`/items/${itemId}/images/${imageId}`),
      "Pending illustration discarded",
    );

  if (imageQuery.isPending) return null;
  if (imageQuery.isError || !state) return null;

  const image = state.image;
  const actual = state.actual_photo_count > 0;
  const busy = busyAction !== null;
  const sourceLink =
    image?.source_page_url && image.source_page_url.startsWith("http")
      ? image.source_page_url
      : null;

  return (
    <section
      aria-label="Item image source"
      className="rounded-2xl border border-border/65 bg-card/45 px-3.5 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.66rem] font-semibold uppercase tracking-[0.11em] text-muted-foreground">
          Image source
        </span>
        {image ? (
          <Badge variant={image.source_type === "reference" ? "brass" : "outline"}>
            {image.label}
          </Badge>
        ) : (
          <Badge variant="outline">Category icon</Badge>
        )}
        {actual && (
          <Badge variant="sage">Actual photo is used</Badge>
        )}
      </div>

      <p className="mt-1.5 text-[0.7rem] leading-relaxed text-muted-foreground">
        {actual
          ? "Your actual photograph always takes priority over reference images and illustrations."
          : image
            ? sourceNote(image)
            : "No photograph or selected reference/AI image. A category icon is shown."}
      </p>

      {!actual && image?.source_type === "reference" && sourceLink && (
        <p className="mt-1 text-[0.66rem] text-muted-foreground">
          Source:{" "}
          <a
            href={sourceLink}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            {image.source_name ?? "product page"}
          </a>
          {image.retrieved_at ? ` · retrieved ${image.retrieved_at.slice(0, 10)}` : ""}
          {!image.exact_model_confirmed ? " · exact model not confirmed" : ""}
        </p>
      )}
      {!actual &&
        image?.source_type === "reference" &&
        (image.license_name || image.license_note) && (
          <p className="mt-1 text-[0.63rem] leading-relaxed text-muted-foreground">
            {image.license_name ? (
              <>
                License evidence:{" "}
                {image.license_url ? (
                  <a
                    href={image.license_url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-4 hover:text-foreground"
                  >
                    {image.license_name}
                  </a>
                ) : (
                  image.license_name
                )}
                .{" "}
              </>
            ) : null}
            {image.license_note}
          </p>
        )}
      {!actual && image?.source_type === "ai" && (
        <p className="mt-1 text-[0.66rem] text-muted-foreground">
          Generated image; it is not evidence of the item's condition or exact model.
        </p>
      )}

      {!actual && state.pending.length > 0 && (
        <div className="mt-3 space-y-2">
          {state.pending.slice(0, 2).map((pending) => (
            <PendingPreview
              key={pending.id ?? pending.created_at ?? "pending"}
              image={pending}
              busy={busy}
              onAccept={() => pending.id && accept(pending.id)}
              onReject={() => pending.id && reject(pending.id)}
            />
          ))}
        </div>
      )}

      {canWrite && !actual && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !state.search_configured}
            title={state.search_reason ?? undefined}
            onClick={findImage}
          >
            {busyAction === "find" ? <Spinner /> : <RefreshCw />}
            {state.selected?.source_type === "reference" ? "Change image" : "Find image"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !state.generation_configured}
            title={state.generation_reason ?? undefined}
            onClick={generate}
          >
            {busyAction === "generate" ? <Spinner /> : <Sparkles />}
            Generate
          </Button>
          {state.selected && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={remove}
            >
              {busyAction === "remove" ? <Spinner /> : <ImageOff />}
              Use icon
            </Button>
          )}
        </div>
      )}

      {!canWrite && image && (
        <p className="mt-2 flex items-center gap-1.5 text-[0.66rem] text-muted-foreground">
          <Info className="size-3" />
          Viewers can see the source label but cannot change item images.
        </p>
      )}
      {canWrite && actual && state.selected && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-2"
          disabled={busy}
          onClick={remove}
        >
          {busyAction === "remove" ? <Spinner /> : <Trash2 />}
          Remove stored image
        </Button>
      )}
      {canWrite && !actual && !state.search_configured && state.search_reason && (
        <p className="mt-2 flex items-start gap-1.5 text-[0.66rem] leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-3 shrink-0" />
          {state.search_reason}
        </p>
      )}
      {canWrite && !actual && !state.generation_configured && state.generation_reason && (
        <p className="mt-1 flex items-start gap-1.5 text-[0.66rem] leading-relaxed text-muted-foreground">
          <ImagePlus className="mt-0.5 size-3 shrink-0" />
          {state.generation_reason}
        </p>
      )}
    </section>
  );
}
