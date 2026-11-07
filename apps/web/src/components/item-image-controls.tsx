import { useQueryClient } from "@tanstack/react-query";
import { Globe2, ImageOff, Info, Trash2 } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import { queryKeys, useCanWrite, useItemImage } from "@/lib/queries";
import type { ItemImage, ItemImageState } from "@/lib/types";

function sourceNote(image: ItemImage) {
  if (image.source_type === "reference") {
    return image.exact_model_confirmed
      ? `Exact model reference${image.model_label ? ` · ${image.model_label}` : ""}`
      : "Reference image · exact model not confirmed";
  }
  return `AI illustration${image.provider_label ? ` · ${image.provider_label}` : ""} · not a photo`;
}

export function ItemImageControls({ itemId }: { itemId: string }) {
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const imageQuery = useItemImage(itemId);
  const state = imageQuery.data;
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [showSearchSetup, setShowSearchSetup] = React.useState(false);

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

  const remove = () =>
    run(
      "remove",
      () => api.delete<ItemImageState>(`/items/${itemId}/image`),
      "Selected image removed",
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
  const searchReady = state.search_configured;

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
        {actual && <Badge variant="sage">Actual photo is used</Badge>}
      </div>

      <p className="mt-1.5 text-[0.7rem] leading-relaxed text-muted-foreground">
        {actual
          ? "Your actual photograph always takes priority over reference images and existing AI illustrations."
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
          This existing AI illustration is not evidence of the item's condition or
          exact model. It remains viewable and removable; new illustrations are no
          longer generated.
        </p>
      )}

      {canWrite && !actual && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="inline-flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                title={searchReady ? undefined : state.search_reason ?? undefined}
                onClick={() => {
                  if (!searchReady) {
                    setShowSearchSetup((current) => !current);
                    return;
                  }
                  setShowSearchSetup(false);
                  void findImage();
                }}
              >
                {busyAction === "find" ? <Spinner /> : <Globe2 />}
                {state.selected?.source_type === "reference"
                  ? "Change online image"
                  : "Find online image"}
              </Button>
              {!searchReady && (
                <Badge variant="brass" className="text-[0.58rem]">
                  Setup required
                </Badge>
              )}
            </div>
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

          {showSearchSetup && !searchReady && (
            <div className="mt-3 rounded-xl border border-brass/25 bg-brass-soft/30 p-3.5 text-[0.7rem] leading-relaxed">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-foreground/85">
                  Online image lookup setup required
                </p>
                <Badge variant="brass">Owner settings</Badge>
              </div>
              <p className="mt-1 break-words text-muted-foreground">
                {state.search_reason ??
                  "Online reference-image lookup is not configured for this household."}
              </p>
              <p className="mt-1.5 text-muted-foreground">
                The household owner can enable reference-image lookup in Online
                search settings. It searches public websites by default and
                automatically selects one suitable image; an optional domain
                restriction can narrow sources.
              </p>
              <Button className="mt-2" size="sm" variant="outline" asChild>
                <Link to="/settings#online-search">Open online search settings</Link>
              </Button>
            </div>
          )}
        </>
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
    </section>
  );
}
