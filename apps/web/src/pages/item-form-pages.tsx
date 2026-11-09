import { useParams, useSearchParams } from "react-router-dom";

import { ErrorState } from "@/components/error-state";
import { appendOrigin, readOrigin } from "@/lib/navigation";
import { ItemForm } from "@/components/item-form";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useItem } from "@/lib/queries";

export function ItemNewPage() {
  const [searchParams] = useSearchParams();
  const roomId = searchParams.get("room_id") ?? undefined;
  const propertyId = searchParams.get("property_id") ?? undefined;
  const locationId = searchParams.get("location_id") ?? undefined;
  const defaultName = searchParams.get("name") ?? undefined;
  const duplicateOfId = searchParams.get("duplicate_of") ?? undefined;
  const duplicateQuery = useItem(duplicateOfId);
  const origin = readOrigin(searchParams);

  if (duplicateOfId && duplicateQuery.isPending) {
    return (
      <div>
        <Skeleton className="h-4 w-20" />
        <Skeleton className="mt-4 h-12 w-1/2 max-w-md" />
        <Skeleton className="mt-10 h-96 rounded-2xl" />
      </div>
    );
  }

  if (duplicateOfId && duplicateQuery.isError) {
    return (
      <ErrorState
        title="The item to duplicate is out of reach"
        message="It may have been deleted, or the link may be out of date."
        onRetry={() => void duplicateQuery.refetch()}
      />
    );
  }

  const duplicateOf = duplicateOfId ? duplicateQuery.data?.item : undefined;

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow={duplicateOf ? "Duplicate item" : "New item"}
        title={duplicateOf ? `Duplicate ${duplicateOf.name}` : "Add something to your home"}
        description={
          duplicateOf
            ? "Identity, category, tags and place are copied. Quantity starts at 1; serial, photos, purchase, warranty and value start empty."
            : "Start with the essentials. Photographs and documents can follow once the item is saved."
        }
        backTo={
          duplicateOf
            ? `/items/${duplicateOf.id}`
            : (origin?.path ?? (roomId ? `/rooms/${roomId}` : "/items"))
        }
        backLabel={
          duplicateOf
            ? "Back to original item"
            : origin
              ? `Back to ${origin.label}`
              : roomId
                ? "Back to room"
                : "All items"
        }
      />
      <ItemForm
        duplicateOf={duplicateOf}
        defaultPropertyId={propertyId}
        defaultRoomId={roomId}
        defaultLocationId={locationId}
        defaultName={defaultName}
        cancelTo={duplicateOf ? `/items/${duplicateOf.id}` : undefined}
        origin={origin}
      />
    </div>
  );
}

export function ItemEditPage() {
  const { itemId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const origin = readOrigin(searchParams);
  const itemDetailPath = appendOrigin(`/items/${itemId}`, origin);
  const itemQuery = useItem(itemId);

  if (itemQuery.isPending) {
    return (
      <div>
        <Skeleton className="h-4 w-20" />
        <Skeleton className="mt-4 h-12 w-1/2 max-w-md" />
        <Skeleton className="mt-10 h-96 rounded-2xl" />
      </div>
    );
  }

  if (itemQuery.isError) {
    return (
      <ErrorState
        title="This item is out of reach"
        message="It may have been deleted, or the link may be out of date."
        onRetry={() => void itemQuery.refetch()}
      />
    );
  }

  const item = itemQuery.data.item;

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Edit item"
        title={item.name}
        description="Update the essentials, then expand optional identity or financial details."
        backTo={itemDetailPath}
        backLabel="Back to item"
      />
      <ItemForm
        item={item}
        returnTo={itemDetailPath}
        cancelTo={itemDetailPath}
      />
    </div>
  );
}
