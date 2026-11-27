import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, MapPin, Plus } from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { CategoryDialog } from "@/components/category-dialog";
import { ReceiptPicker } from "@/components/receipt-picker";
import { RoomDialog } from "@/components/room-dialog";
import { Field, FormError } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { appendOrigin, type ItemOrigin } from "@/lib/navigation";
import {
  queryKeys,
  useCategories,
  useDocuments,
  useDefaultCurrency,
  useInvalidateInventory,
  useLocations,
  useProperties,
  useRooms,
  useSession,
  useTags,
} from "@/lib/queries";
import type {
  Category,
  ItemCondition,
  ItemDetail,
  ItemDetailResponse,
  ItemInput,
  LocationKind,
  Room,
  Tag,
} from "@/lib/types";
import {
  CURRENCIES,
  DOCUMENT_TYPE_LABELS,
} from "@/lib/labels";
import {
  addMonthsIso,
  cn,
  collectDescendantIds,
  CONDITION_LABELS,
  flattenLocations,
  flattenRoomTree,
  formatCurrency,
  LOCATION_KIND_LABELS,
  locationLabel,
  locationPath,
  roomPath,
} from "@/lib/utils";
import { CONDITIONS, FormSection, OptionalFormSection } from "@/components/item-form-sections";
import { ItemDraftBanner, useItemFormProtection } from "@/components/item-form-draft";
import { itemDraftFormId } from "@/lib/item-drafts";

interface ItemFormProps {
  item?: ItemDetail;
  duplicateOf?: ItemDetail;
  defaultPropertyId?: string;
  defaultRoomId?: string;
  defaultLocationId?: string;
  defaultName?: string;
  returnTo?: string;
  cancelTo?: string;
  origin?: ItemOrigin | null;
  /** "panel" when the form is shown in the desktop side panel, which scrolls by itself. */
  presentation?: "page" | "panel";
}

/** Which form this is: one item's edit form, or a new-item form with its starting context. */
function itemFormId({
  item, duplicateOf, defaultPropertyId, defaultRoomId, defaultLocationId, defaultName,
}: ItemFormProps) {
  return itemDraftFormId(
    item
      ? { itemId: item.id }
      : {
          context: {
            duplicate_of: duplicateOf?.id,
            property_id: defaultPropertyId,
            room_id: defaultRoomId,
            location_id: defaultLocationId,
            name: defaultName,
          },
        },
  );
}

/**
 * The form's fields, dirty baseline, draft scope and navigation guard are all
 * set up when it mounts. Routes reuse this component when only the item id or
 * the new-item context changes, so it is remounted whenever the account,
 * household or form identity changes. A background refresh of the same item
 * keeps the identity, and with it the edits in progress.
 */
export function ItemForm(props: ItemFormProps) {
  const session = useSession().data;
  const identity = JSON.stringify([session?.user?.id, session?.household?.id, itemFormId(props)]);
  return <ItemFormFields key={identity} {...props} />;
}

function ItemFormFields(props: ItemFormProps) {
  const {
    item,
    duplicateOf,
    defaultPropertyId,
    defaultRoomId,
    defaultLocationId,
    defaultName,
    returnTo,
    cancelTo,
    origin,
    presentation = "page",
  } = props;
  const navigate = useNavigate();
  const template = item ?? duplicateOf;
  const queryClient = useQueryClient();
  const invalidate = useInvalidateInventory();
  const defaultCurrency = useDefaultCurrency();
  const propertiesQuery = useProperties();
  const properties = propertiesQuery.data?.items ?? [];
  const [propertyId, setPropertyId] = React.useState(
    template?.property?.id ?? defaultPropertyId ?? "",
  );
  const roomsQuery = useRooms(propertyId || undefined);
  const categoriesQuery = useCategories();
  const tagsQuery = useTags();
  const documentsQuery = useDocuments({}, 100);

  const [name, setName] = React.useState(template?.name ?? defaultName ?? "");
  const [description, setDescription] = React.useState(template?.description ?? "");
  const [brand, setBrand] = React.useState(template?.brand ?? "");
  const [model, setModel] = React.useState(template?.model ?? "");
  const [serialNumber, setSerialNumber] = React.useState(item?.serial_number ?? "");
  const [quantity, setQuantity] = React.useState(String(item?.quantity ?? 1));
  const storageLocked = Boolean(item?.storage?.active);
  const [condition, setCondition] = React.useState<ItemCondition>(
    template?.condition ?? "good",
  );
  const [roomId, setRoomId] = React.useState(template?.room?.id ?? defaultRoomId ?? "");
  const [locationId, setLocationId] = React.useState(
    template?.location?.id ?? defaultLocationId ?? "",
  );
  React.useEffect(() => {
    if (propertyId) return;
    const selectedRoom = roomsQuery.data?.items.find((room) => room.id === roomId);
    if (template?.property?.id) setPropertyId(template.property.id);
    else if (defaultPropertyId) setPropertyId(defaultPropertyId);
    else if (selectedRoom?.property_id) setPropertyId(selectedRoom.property_id);
    else if (properties.length === 1) setPropertyId(properties[0]!.id);
  }, [
    propertyId,
    template?.property?.id,
    defaultPropertyId,
    properties,
    roomId,
    roomsQuery.data?.items,
  ]);
  const [categoryId, setCategoryId] = React.useState(template?.category?.id ?? "");
  const [tagIds, setTagIds] = React.useState<string[]>(
    template?.tags.map((tag) => tag.id) ?? [],
  );
  const [newTag, setNewTag] = React.useState("");
  const [tagError, setTagError] = React.useState<string | null>(null);
  const [categoryDialogOpen, setCategoryDialogOpen] = React.useState(false);
  const [roomDialogOpen, setRoomDialogOpen] = React.useState(false);

  const [vendor, setVendor] = React.useState(item?.purchase?.vendor ?? "");
  const [purchaseDate, setPurchaseDate] = React.useState(item?.purchase?.purchase_date ?? "");
  const [totalPrice, setTotalPrice] = React.useState(
    item?.purchase?.price_cents != null ? (item.purchase.price_cents / 100).toFixed(2) : "",
  );
  const [editedUnitPrice, setEditedUnitPrice] = React.useState<string | null>(null);
  const [currency, setCurrency] = React.useState(
    item?.purchase?.currency ?? defaultCurrency,
  );
  const [currencyTouched, setCurrencyTouched] = React.useState(false);
  const [priceBasis, setPriceBasis] = React.useState<"total" | "unit">("total");
  const [orderNumber, setOrderNumber] = React.useState(item?.purchase?.order_number ?? "");
  const [purchaseNotes, setPurchaseNotes] = React.useState(item?.purchase?.notes ?? "");
  const [receiptDocumentId, setReceiptDocumentId] = React.useState(
    item?.purchase?.receipt_document_id ?? "",
  );
  const initialPurchaseInfoStatus: "auto" | "unknown" | "not_applicable" =
    item?.purchase_info_status === "not_applicable"
      ? "not_applicable"
      : item?.purchase_info_status === "unknown"
        ? "unknown"
        : "auto";
  const [purchaseInfoStatus, setPurchaseInfoStatus] = React.useState<
    "auto" | "unknown" | "not_applicable"
  >(initialPurchaseInfoStatus);
  const [warrantyProvider, setWarrantyProvider] = React.useState(item?.warranty?.provider ?? "");
  const [warrantyStart, setWarrantyStart] = React.useState(item?.warranty?.start_date ?? "");
  const [warrantyDuration, setWarrantyDuration] = React.useState(
    item?.warranty?.duration_months != null ? String(item.warranty.duration_months) : "",
  );
  const [warrantyEnd, setWarrantyEnd] = React.useState(item?.warranty?.end_date ?? "");
  const [warrantyReminder, setWarrantyReminder] = React.useState(
    item?.warranty?.reminder_days != null ? String(item.warranty.reminder_days) : "",
  );
  const [warrantyDocumentId, setWarrantyDocumentId] = React.useState(
    item?.warranty?.document_id ?? "",
  );
  const [warrantyNotes, setWarrantyNotes] = React.useState(item?.warranty?.notes ?? "");
  React.useEffect(() => {
    if (!item?.purchase?.currency && !currencyTouched) setCurrency(defaultCurrency);
  }, [currencyTouched, defaultCurrency, item?.purchase?.currency]);
  const [placeOpen, setPlaceOpen] = React.useState(
    !(template?.room?.id ?? defaultRoomId),
  );
  const [identityOpen, setIdentityOpen] = React.useState(false);
  const [purchaseOpen, setPurchaseOpen] = React.useState(false);
  const [legacyEstimateOpen, setLegacyEstimateOpen] = React.useState(false);
  const [warrantyOpen, setWarrantyOpen] = React.useState(false);

  const locationsQuery = useLocations(roomId || undefined);
  const locationRecords = locationsQuery.data?.items ?? [];
  const excludedLocations = item?.storage?.active
    ? new Set([
        item.storage.location_id,
        ...collectDescendantIds(locationRecords, item.storage.location_id),
      ])
    : new Set<string>();
  const locationOptions = flattenLocations(
    locationRecords.filter((entry) => !excludedLocations.has(entry.id)),
  );
  const roomOptions = flattenRoomTree(roomsQuery.data?.items ?? []);
  const selectedLocationPath = locationPath(
    locationsQuery.data?.items ?? [],
    locationId,
  );
  // The place is one line (home, room, storage place) until it is opened to change it.
  const placeSummary = [
    properties.length > 1
      ? properties.find((property) => property.id === propertyId)?.name
      : null,
    ...(roomId ? roomPath(roomsQuery.data?.items ?? [], roomId).map((entry) => entry.name) : []),
    ...selectedLocationPath.map((location) => locationLabel(location)),
  ]
    .filter(Boolean)
    .join(" › ");
  const parsedQuantity = /^\d+$/.test(quantity) ? Number(quantity) : 0;
  // The "single-item" allocation is written by the server for a purchase with one
  // item. It follows the price, so it is not a reviewed document line.
  const hasReviewedAllocation = Boolean(
    item?.purchase?.allocations.some(
      (allocation) =>
        allocation.item_id === item?.id && allocation.source_line_id !== "single-item",
    ),
  );
  const canUseUnitPrice =
    parsedQuantity > 1 &&
    !item?.purchase?.is_shared &&
    !hasReviewedAllocation;
  const priceBasisActive = canUseUnitPrice ? priceBasis : "total";
  const totalPriceCents = totalPrice.trim() ? Math.round(Number(totalPrice) * 100) : null;
  const derivedUnitPrice =
    totalPriceCents != null && Number.isFinite(totalPriceCents) && parsedQuantity > 0
      ? (totalPriceCents / parsedQuantity / 100).toFixed(2)
      : "";
  const price =
    priceBasisActive === "unit" ? (editedUnitPrice ?? derivedUnitPrice) : totalPrice;
  const enteredPriceCents = price.trim() ? Math.round(Number(price) * 100) : null;
  const validationPrice =
    priceBasisActive === "unit" && editedUnitPrice === null ? totalPrice : price;
  const validationPriceCents =
    priceBasisActive === "unit" && editedUnitPrice === null
      ? totalPriceCents
      : enteredPriceCents;
  const priceInvalid =
    validationPrice.trim().length > 0 &&
    (validationPriceCents === null ||
      !Number.isFinite(validationPriceCents) ||
      validationPriceCents < 0);
  const editedUnitPriceCents = editedUnitPrice?.trim()
    ? Math.round(Number(editedUnitPrice) * 100)
    : null;
  const editedUnitTotalCents =
    editedUnitPriceCents == null || parsedQuantity <= 0
      ? editedUnitPriceCents
      : editedUnitPriceCents * parsedQuantity;
  const packagePriceCents =
    priceBasis === "unit" && editedUnitPrice !== null
      ? editedUnitTotalCents
      : totalPriceCents;
  const calculatedTotalPrice =
    packagePriceCents == null
      ? ""
      : Number.isFinite(packagePriceCents)
        ? (packagePriceCents / 100).toFixed(2)
        : (editedUnitPrice ?? totalPrice);
  const effectiveUnitPriceCents =
    packagePriceCents == null || parsedQuantity <= 0
      ? null
      : Math.round(packagePriceCents / parsedQuantity);
  const effectiveUnitIsRounded =
    packagePriceCents != null &&
    parsedQuantity > 0 &&
    packagePriceCents % parsedQuantity !== 0;
  const changePriceBasis = (next: "total" | "unit") => {
    if (next === priceBasisActive) return;
    if (next === "total" && editedUnitPrice !== null) {
      setTotalPrice(calculatedTotalPrice);
    }
    setEditedUnitPrice(null);
    setPriceBasis(next);
  };
  React.useEffect(() => {
    if (canUseUnitPrice || priceBasis !== "unit") return;
    if (editedUnitPrice !== null) setTotalPrice(calculatedTotalPrice);
    setEditedUnitPrice(null);
    setPriceBasis("total");
  }, [canUseUnitPrice, priceBasis, editedUnitPrice, calculatedTotalPrice]);
  const durationNumber = warrantyDuration.trim() ? Number(warrantyDuration) : null;
  const durationInvalid =
    warrantyDuration.trim().length > 0 &&
    (durationNumber === null ||
      !Number.isInteger(durationNumber) ||
      durationNumber < 1 ||
      durationNumber > 1200);
  const computedWarrantyEnd =
    (warrantyStart && durationNumber && !durationInvalid
      ? addMonthsIso(warrantyStart, durationNumber)
      : warrantyEnd) ?? "";
  const warrantyDatesInvalid =
    warrantyStart.length > 0 &&
    computedWarrantyEnd.length > 0 &&
    computedWarrantyEnd < warrantyStart;
  const quantityInvalid =
    quantity.trim().length === 0 ||
    !/^\d+$/.test(quantity) ||
    Number(quantity) > 1_000_000;

  const protection = useItemFormProtection({
    formId: itemFormId(props),
    itemUpdatedAt: item?.updated_at ?? null,
    values: {
      name,
      description,
      brand,
      model,
      serialNumber,
      quantity,
      condition,
      propertyId,
      roomId,
      locationId,
      categoryId,
      tagIds,
      vendor,
      purchaseDate,
      totalPrice,
      editedUnitPrice,
      currency,
      currencyTouched,
      priceBasis,
      orderNumber,
      purchaseNotes,
      receiptDocumentId,
      purchaseInfoStatus,
      warrantyProvider,
      warrantyStart,
      warrantyDuration,
      warrantyEnd,
      warrantyReminder,
      warrantyDocumentId,
      warrantyNotes,
    },
  });
  const restoreDraft = () => {
    const draft = protection.restoreDraft();
    if (!draft) return;
    setName(draft.name);
    setDescription(draft.description);
    setBrand(draft.brand);
    setModel(draft.model);
    setSerialNumber(draft.serialNumber);
    if (!storageLocked) setQuantity(draft.quantity);
    const draftCondition = CONDITIONS.find((value) => value === draft.condition);
    if (draftCondition) setCondition(draftCondition);
    setPropertyId(draft.propertyId);
    setRoomId(draft.roomId);
    setLocationId(draft.locationId);
    setCategoryId(draft.categoryId);
    setTagIds(draft.tagIds);
    setVendor(draft.vendor);
    setPurchaseDate(draft.purchaseDate);
    setTotalPrice(draft.totalPrice);
    setEditedUnitPrice(draft.editedUnitPrice);
    setCurrency(draft.currency);
    setCurrencyTouched(draft.currencyTouched);
    setPriceBasis(draft.priceBasis);
    setOrderNumber(draft.orderNumber);
    setPurchaseNotes(draft.purchaseNotes);
    setReceiptDocumentId(draft.receiptDocumentId);
    if (
      draft.purchaseInfoStatus === "auto" ||
      draft.purchaseInfoStatus === "unknown" ||
      draft.purchaseInfoStatus === "not_applicable"
    ) {
      setPurchaseInfoStatus(draft.purchaseInfoStatus);
    }
    setWarrantyProvider(draft.warrantyProvider);
    setWarrantyStart(draft.warrantyStart);
    setWarrantyDuration(draft.warrantyDuration);
    setWarrantyEnd(draft.warrantyEnd);
    setWarrantyReminder(draft.warrantyReminder);
    setWarrantyDocumentId(draft.warrantyDocumentId);
    setWarrantyNotes(draft.warrantyNotes);
  };

  const save = useMutation({
    mutationFn: (payload: ItemInput) =>
      item
        ? api.patch<ItemDetailResponse>(`/items/${item.id}`, payload)
        : api.post<ItemDetailResponse>("/items", payload),
    onSuccess: (response) => {
      invalidate();
      toast.success(item ? "Item updated" : "Item added");
      protection.markSaved();
      navigate(
        item && returnTo
          ? returnTo
          : appendOrigin(`/items/${response.item.id}`, origin),
        { replace: !item },
      );
    },
  });

  const createTag = useMutation({
    mutationFn: (tagName: string) => api.post<Tag>("/tags", { name: tagName }),
    onSuccess: (tag) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tags });
      setTagIds((current) => [...new Set([...current, tag.id])]);
      setNewTag("");
      setTagError(null);
    },
    onError: (error) => {
      setTagError(getApiErrorMessage(error));
    },
  });

  const hasPurchase = Boolean(
    vendor.trim() ||
      purchaseDate ||
      price.trim() ||
      orderNumber.trim() ||
      purchaseNotes.trim() ||
      receiptDocumentId,
  );
  const hasWarranty = Boolean(
    warrantyProvider.trim() ||
      warrantyStart ||
      warrantyEnd ||
      warrantyDuration ||
      warrantyReminder ||
      warrantyDocumentId ||
      warrantyNotes.trim(),
  );

  const selectedCategory = categoriesQuery.data?.items.find(
    (category) => category.id === categoryId,
  );
  const selectedTagNames = (tagsQuery.data?.items ?? [])
    .filter((tag) => tagIds.includes(tag.id))
    .map((tag) => tag.name);
  const receiptDocument = (documentsQuery.data?.items ?? []).find(
    (document) => document.id === receiptDocumentId,
  );
  const warrantyDocument = (documentsQuery.data?.items ?? []).find(
    (document) => document.id === warrantyDocumentId,
  );
  const identityParts = [
    [brand.trim(), model.trim()].filter(Boolean).join(" "),
    serialNumber.trim() ? `Serial ${serialNumber.trim()}` : "",
    selectedCategory?.name ?? "",
    selectedTagNames.length > 0
      ? `${selectedTagNames.length} tag${selectedTagNames.length === 1 ? "" : "s"}`
      : "",
    description.trim() ? "Description saved" : "",
  ].filter(Boolean);
  const identitySummary =
    identityParts.length > 0
      ? identityParts.join(" · ")
      : "Brand, model, serial, description, category and tags are optional.";

  const purchaseStatusLabel =
    purchaseInfoStatus === "unknown"
      ? "Purchase information unknown"
      : purchaseInfoStatus === "not_applicable"
        ? "Purchase information not applicable"
        : "";
  const purchaseTotalLabel = item?.purchase?.is_shared ? "transaction total" : "package total";
  const purchaseParts = [
    item?.purchase?.is_shared ? "Shared purchase" : "",
    packagePriceCents != null && Number.isFinite(packagePriceCents)
      ? `${formatCurrency(packagePriceCents, currency)} ${purchaseTotalLabel}`
      : "",
    canUseUnitPrice && effectiveUnitPriceCents != null
      ? `${effectiveUnitIsRounded ? "≈ " : ""}${formatCurrency(
          effectiveUnitPriceCents,
          currency,
        )} per unit`
      : "",
    vendor.trim(),
    purchaseStatusLabel,
    receiptDocument ? `Receipt: ${receiptDocument.title}` : "",
    purchaseNotes.trim() ? "Notes saved" : "",
  ].filter(Boolean);
  const purchaseSummary = priceInvalid
    ? "Check the purchase amount before saving."
    : purchaseParts.length > 0
      ? purchaseParts.join(" · ")
      : "No purchase information recorded.";

  const legacyEstimateSummary =
    item?.current_value_cents != null
      ? `${
          item.current_value_basis === "legacy_record_total"
            ? "Earlier record total"
            : "Earlier estimate · per unit ·"
        } ${formatCurrency(item.current_value_cents, item.current_value_currency)}`
      : "";

  const warrantyParts = [
    warrantyProvider.trim(),
    warrantyDocument ? `Document: ${warrantyDocument.title}` : "",
    computedWarrantyEnd ? `Ends ${computedWarrantyEnd}` : "",
    warrantyDuration.trim() ? `${warrantyDuration.trim()} months` : "",
    warrantyReminder.trim() ? `Reminder ${warrantyReminder.trim()} days` : "",
    warrantyNotes.trim() ? "Notes saved" : "",
  ].filter(Boolean);
  const warrantySummary = durationInvalid || warrantyDatesInvalid
    ? "Check the warranty dates and duration before saving."
    : warrantyParts.length > 0
      ? warrantyParts.join(" · ")
      : "No warranty recorded.";

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (
      !name.trim() ||
      quantityInvalid ||
      priceInvalid ||
      durationInvalid ||
      warrantyDatesInvalid
    ) {
      return;
    }
    const payload: ItemInput = {
      name: name.trim(),
      description: description.trim() || null,
      brand: brand.trim() || null,
      model: model.trim() || null,
      serial_number: serialNumber.trim() || null,
      quantity: Number(quantity),
      condition,
      room_id: roomId || null,
      storage_location_id: locationId || null,
      category_id: categoryId || null,
      tag_ids: tagIds,
      purchase: hasPurchase
        ? {
            merchant: vendor.trim() || null,
            purchase_date: purchaseDate || null,
            price_cents: packagePriceCents,
            currency,
            order_number: orderNumber.trim() || null,
            notes: purchaseNotes.trim() || null,
            receipt_document_id: receiptDocumentId || null,
          }
        : null,
      ...(!item || purchaseInfoStatus !== initialPurchaseInfoStatus
        ? { purchase_info_status: purchaseInfoStatus }
        : {}),
      warranty: hasWarranty
        ? {
            provider: warrantyProvider.trim() || null,
            start_date: warrantyStart || null,
            duration_months: durationNumber,
            end_date: durationNumber ? null : warrantyEnd || null,
            reminder_days: warrantyReminder.trim() ? Number(warrantyReminder) : null,
            document_id: warrantyDocumentId || null,
            notes: warrantyNotes.trim() || null,
          }
        : null,
    };
    save.mutate(payload);
  };

  const fieldErrors = save.error instanceof ApiError ? save.error.fields : undefined;
  const generalError = save.error && !fieldErrors ? getApiErrorMessage(save.error) : null;

  const addTagFromInput = () => {
    const tagName = newTag.trim();
    if (!tagName) return;
    const existing = tagsQuery.data?.items.find(
      (tag) => tag.name.toLowerCase() === tagName.toLowerCase(),
    );
    if (existing) {
      setTagIds((current) => [...new Set([...current, existing.id])]);
      setNewTag("");
      setTagError(null);
      return;
    }
    createTag.mutate(tagName);
  };

  // A place error must be seen, so it opens the place even when it was closed.
  const placeExpanded = placeOpen || Boolean(fieldErrors?.room_id);

  return (
    <>
      <form onSubmit={submit} className="space-y-5" noValidate>
        {generalError && <FormError message={generalError} />}
        {protection.draftOffer && (
          <ItemDraftBanner
            savedAt={protection.draftOffer.savedAt}
            itemChanged={protection.draftOffer.itemChanged}
            onRestore={restoreDraft}
            onDiscard={protection.discardDraft}
          />
        )}

        <FormSection
          title="The essentials"
          description="Name, quantity and place come first. Optional identity and financial details stay collapsed below."
        >
              <Field label="Item name" htmlFor="item-name" error={fieldErrors?.name}>
                <Input
                  id="item-name"
                  // A new item starts with its name. When an item is edited on a touch
                  // screen, the keyboard must not cover the form before a field is chosen.
                  autoFocus={!item || !window.matchMedia?.("(pointer: coarse)").matches}
                  required
                  maxLength={200}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Espresso machine"
                />
              </Field>

              <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-4">
                <Field
                  label="Quantity"
                  htmlFor="item-quantity"
                  error={quantityInvalid ? "Enter a whole number from 0 to 1,000,000." : undefined}
                  hint={
                    storageLocked
                      ? "Quantity stays 1 while this item provides storage. Create a separate item for each physical unit."
                      : undefined
                  }
                >
                  <Input
                    id="item-quantity"
                    type="number"
                    inputMode="numeric"
                    min={storageLocked ? 1 : 0}
                    max={1_000_000}
                    step={1}
                    value={quantity}
                    disabled={storageLocked}
                    onChange={(event) => setQuantity(event.target.value)}
                  />
                </Field>
                <Field label="Condition" htmlFor="item-condition">
                  <Select
                    id="item-condition"
                    value={condition}
                    onChange={(event) => setCondition(event.target.value as ItemCondition)}
                  >
                    {CONDITIONS.map((value) => (
                      <option key={value} value={value}>
                        {CONDITION_LABELS[value]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <div className="rounded-xl border border-border/60 bg-background/30">
                <button
                  type="button"
                  aria-expanded={placeExpanded}
                  aria-controls="item-place-panel"
                  onClick={() => setPlaceOpen(!placeExpanded)}
                  className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                      Place
                    </span>
                    <span
                      data-testid="item-place-summary"
                      className={cn(
                        "block text-sm leading-snug [overflow-wrap:anywhere]",
                        !placeSummary && "text-muted-foreground",
                      )}
                    >
                      {placeSummary || "No place yet"}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-2xs font-medium text-muted-foreground">
                    {placeExpanded ? "Done" : placeSummary ? "Change" : "Choose"}
                    <ChevronDown
                      aria-hidden="true"
                      className={cn("size-3.5 transition-transform", placeExpanded && "rotate-180")}
                    />
                  </span>
                </button>
                <div
                  id="item-place-panel"
                  hidden={!placeExpanded}
                  className="space-y-4 border-t border-border/60 px-3.5 py-3.5"
                >
                  {properties.length > 0 && (
                    <Field label="Property" htmlFor="item-property">
                      <Select
                        id="item-property"
                        value={propertyId}
                        onChange={(event) => {
                          setPropertyId(event.target.value);
                          setRoomId("");
                          setLocationId("");
                        }}
                      >
                        <option value="">No property / unlocated</option>
                        {properties.map((property) => (
                          <option key={property.id} value={property.id}>
                            {property.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}

                  <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4">
                    <Field label="Room" htmlFor="item-room" error={fieldErrors?.room_id}>
                      <Select
                        id="item-room"
                        value={roomId}
                        onChange={(event) => {
                          if (event.target.value === "__new_room__") {
                            setRoomDialogOpen(true);
                            return;
                          }
                          setRoomId(event.target.value);
                          setLocationId("");
                        }}
                      >
                        <option value="">No room yet</option>
                        {roomOptions.map(({ room }) => (
                          <option key={room.id} value={room.id}>
                            {[
                              propertyId ? null : room.property?.name,
                              ...roomPath(roomsQuery.data?.items ?? [], room.id).map(
                                (entry) => entry.name,
                              ),
                            ]
                              .filter(Boolean)
                              .join(" / ")}
                          </option>
                        ))}
                        <option value="__new_room__">＋ New room or sub-room…</option>
                      </Select>
                    </Field>

                    <Field
                      label="Storage location"
                      htmlFor="item-location"
                      hint={!roomId ? "Choose a room first" : undefined}
                    >
                      <Select
                        id="item-location"
                        value={locationId}
                        disabled={!roomId}
                        onChange={(event) => setLocationId(event.target.value)}
                      >
                        <option value="">Room only</option>
                        {locationOptions.map(({ location, depth }) => (
                          <option key={location.id} value={location.id}>
                            {depth > 0 ? `${"— ".repeat(depth)}` : ""}
                            {location.identifier
                              ? `${location.identifier} · ${location.name}`
                              : location.name}{" "}
                            · {LOCATION_KIND_LABELS[location.kind as LocationKind]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                </div>
              </div>
            </FormSection>

        <div className="space-y-6" data-testid="optional-form-sections">
            <OptionalFormSection
              id="optional-identity"
              title="Identity & organisation"
              summary={identitySummary}
              open={identityOpen}
              onToggle={() => setIdentityOpen((current) => !current)}
            >
              <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-5">
                <Field label="Brand" htmlFor="item-brand" optional>
                  <Input
                    id="item-brand"
                    maxLength={120}
                    value={brand}
                    onChange={(event) => setBrand(event.target.value)}
                    placeholder="La Marzocco"
                  />
                </Field>
                <Field label="Model" htmlFor="item-model" optional>
                  <Input
                    id="item-model"
                    maxLength={120}
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="Linea Mini"
                  />
                </Field>
              </div>

              <Field label="Serial number" htmlFor="item-serial" optional>
                <Input
                  id="item-serial"
                  maxLength={200}
                  value={serialNumber}
                  onChange={(event) => setSerialNumber(event.target.value)}
                  placeholder="Where to find it if you ever need it"
                />
              </Field>

              <Field label="Description" htmlFor="item-description" optional>
                <Textarea
                  id="item-description"
                  maxLength={4000}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Colour, material, where it came from, anything worth remembering."
                />
              </Field>

              <Field label="Category" htmlFor="item-category" error={fieldErrors?.category_id}>
                <div className="flex gap-2">
                  <div className="min-w-0 flex-1">
                    <Select
                      id="item-category"
                      value={categoryId}
                      onChange={(event) => setCategoryId(event.target.value)}
                    >
                      <option value="">No category</option>
                      {(categoriesQuery.data?.items ?? []).map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Create a category"
                    onClick={() => setCategoryDialogOpen(true)}
                  >
                    <Plus />
                  </Button>
                </div>
              </Field>

              <div>
                <p className="text-xs font-medium">Tags</p>
                <p className="mt-0.5 text-2xs text-muted-foreground">
                  Loose labels that cut across rooms.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(tagsQuery.data?.items ?? []).map((tag) => {
                    const selected = tagIds.includes(tag.id);
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() =>
                          setTagIds((current) =>
                            selected
                              ? current.filter((id) => id !== tag.id)
                              : [...current, tag.id],
                          )
                        }
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-2xs transition-colors coarse:min-h-11",
                          selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-card/60 text-muted-foreground hover:border-foreground/25 hover:text-foreground",
                        )}
                      >
                        {selected && <Check className="size-3" />}
                        {tag.name}
                      </button>
                    );
                  })}
                  {tagsQuery.data?.items.length === 0 && (
                    <p className="text-2xs text-muted-foreground">
                      No tags yet. Create one below.
                    </p>
                  )}
                </div>
                <div className="mt-2 flex gap-2">
                  <Input
                    aria-label="New tag name"
                    maxLength={60}
                    value={newTag}
                    onChange={(event) => {
                      setNewTag(event.target.value);
                      setTagError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addTagFromInput();
                      }
                    }}
                    placeholder="Add a tag"
                    className="h-9 text-xs coarse:h-11"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="size-9 coarse:size-11"
                    aria-label="Create tag"
                    disabled={createTag.isPending || !newTag.trim()}
                    onClick={addTagFromInput}
                  >
                    {createTag.isPending ? <Spinner /> : <Plus />}
                  </Button>
                </div>
                {tagError && <p className="text-2xs text-destructive">{tagError}</p>}
              </div>
            </OptionalFormSection>

            <OptionalFormSection
              id="optional-purchase"
              title="Purchase"
              summary={purchaseSummary}
              open={purchaseOpen}
              onToggle={() => setPurchaseOpen((current) => !current)}
            >
              <p className="text-2xs leading-relaxed text-muted-foreground">
                The original transaction or package total and receipt trail. Current
                value is recorded separately per owned unit.
              </p>
              {item?.purchase?.is_shared && (
                <div className="rounded-xl border border-brass/20 bg-brass-soft/60 px-3.5 py-3 text-2xs leading-relaxed text-muted-foreground">
                  This purchase is shared by {item.purchase.item_count} items. The
                  amount is the purchase transaction total, not a per-unit price, and
                  is not multiplied by quantity. Editing it updates the single shared
                  record; reviewed item allocations remain separate.
                </div>
              )}
              {canUseUnitPrice && (
                <div className="space-y-2">
                  <p className="text-xs font-medium">Amount entered</p>
                  <div
                    className="flex flex-wrap gap-2"
                    role="group"
                    aria-label="Purchase price basis"
                  >
                    <Button
                      type="button"
                      size="sm"
                      variant={priceBasisActive === "total" ? "default" : "outline"}
                      aria-pressed={priceBasisActive === "total"}
                      onClick={() => changePriceBasis("total")}
                    >
                      Total paid for package
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={priceBasisActive === "unit" ? "default" : "outline"}
                      aria-pressed={priceBasisActive === "unit"}
                      onClick={() => changePriceBasis("unit")}
                    >
                      Price per unit
                    </Button>
                  </div>
                  <p className="text-2xs leading-relaxed text-muted-foreground">
                    This item has quantity {parsedQuantity}. Enter the package total or
                    the price for one unit; the other value is calculated.
                  </p>
                </div>
              )}
              <Field
                label="Purchase information status"
                htmlFor="purchase-info-status"
                hint="Choose Unknown while details are unresolved. Not applicable removes this item from missing-purchase tasks without deleting any recorded details or amounts."
              >
                <Select
                  id="purchase-info-status"
                  value={purchaseInfoStatus}
                  onChange={(event) =>
                    setPurchaseInfoStatus(
                      event.target.value as
                        | "auto"
                        | "unknown"
                        | "not_applicable",
                    )
                  }
                >
                  <option value="auto">Use the purchase details above</option>
                  <option value="unknown">Unknown — still unresolved</option>
                  <option value="not_applicable">
                    Not applicable — no purchase tracking needed
                  </option>
                </Select>
              </Field>
              {priceInvalid && (
                <FormError message="Enter a valid price, such as 129.00." />
              )}
              <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-5">
                <Field label="Merchant" htmlFor="purchase-vendor" optional>
                  <Input
                    id="purchase-vendor"
                    maxLength={160}
                    value={vendor}
                    onChange={(event) => setVendor(event.target.value)}
                    placeholder="Where it came from"
                  />
                </Field>
                <Field label="Purchase date" htmlFor="purchase-date" optional>
                  <Input
                    id="purchase-date"
                    type="date"
                    value={purchaseDate}
                    onChange={(event) => setPurchaseDate(event.target.value)}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,7rem)] gap-4">
                <Field
                  label={
                    priceBasisActive === "unit"
                      ? "Price per unit"
                      : item?.purchase?.is_shared
                        ? "Shared purchase total"
                        : "Purchase total"
                  }
                  htmlFor="purchase-price"
                  optional
                >
                  <Input
                    id="purchase-price"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={price}
                    onChange={(event) => {
                      if (priceBasisActive === "unit") {
                        setEditedUnitPrice(event.target.value);
                      } else {
                        setTotalPrice(event.target.value);
                      }
                    }}
                    placeholder="0.00"
                  />
                </Field>
                <Field label="Currency" htmlFor="purchase-currency">
                  <Select
                    id="purchase-currency"
                    value={currency}
                    onChange={(event) => {
                      setCurrency(event.target.value);
                      setCurrencyTouched(true);
                    }}
                  >
                    {CURRENCIES.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <p className="text-2xs leading-relaxed text-muted-foreground">
                {priceBasisActive === "unit"
                  ? "Enter the price for one unit. The package total is calculated from the item quantity shown above."
                  : item?.purchase?.is_shared
                    ? "Total paid for all items linked to this shared purchase."
                    : "Total paid for the whole purchase or pack. A per-unit estimate is calculated when quantity is greater than one."}
              </p>
              {packagePriceCents != null && Number.isFinite(packagePriceCents) && (
                <div
                  data-testid="purchase-price-preview"
                  className="rounded-xl border border-border/60 bg-secondary/20 px-3.5 py-3 text-2xs leading-relaxed"
                >
                  <p className="font-medium">
                    {formatCurrency(packagePriceCents, currency)} {purchaseTotalLabel}
                  </p>
                  {canUseUnitPrice && effectiveUnitPriceCents != null && (
                    <p className="mt-1 text-muted-foreground">
                      {effectiveUnitIsRounded ? "≈ " : ""}
                      {formatCurrency(effectiveUnitPriceCents, currency)} per unit for{" "}
                      {parsedQuantity} units.
                    </p>
                  )}
                  {priceBasisActive === "unit" &&
                    enteredPriceCents != null &&
                    Number.isFinite(enteredPriceCents) &&
                    parsedQuantity > 0 &&
                    enteredPriceCents * parsedQuantity === packagePriceCents && (
                      <p className="mt-1 text-muted-foreground">
                        {parsedQuantity} units ×{" "}
                        {formatCurrency(enteredPriceCents, currency)} ={" "}
                        {formatCurrency(packagePriceCents, currency)}.
                      </p>
                    )}
                </div>
              )}
              <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-5">
                <Field label="Order number" htmlFor="purchase-order" optional>
                  <Input
                    id="purchase-order"
                    maxLength={120}
                    value={orderNumber}
                    onChange={(event) => setOrderNumber(event.target.value)}
                    placeholder="Order or receipt reference"
                  />
                </Field>
                <ReceiptPicker
                  id="purchase-receipt"
                  value={receiptDocumentId}
                  onChange={setReceiptDocumentId}
                />
              </div>
              <Field label="Purchase notes" htmlFor="purchase-notes" optional>
                <Textarea
                  id="purchase-notes"
                  maxLength={4000}
                  value={purchaseNotes}
                  onChange={(event) => setPurchaseNotes(event.target.value)}
                  placeholder="Return window, delivery details, who paid."
                />
              </Field>
            </OptionalFormSection>

            {item?.current_value_cents != null && (
              <OptionalFormSection
                id="optional-earlier-estimate"
                title="Earlier estimate"
                summary={legacyEstimateSummary}
                open={legacyEstimateOpen}
                onToggle={() => setLegacyEstimateOpen((current) => !current)}
              >
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  This older value is read-only and is preserved when you edit the item.
                  Create a fresh replacement estimate only when you need an insurance list.
                </p>
                <Button variant="outline" size="sm" asChild>
                  <Link to={`/insurance?item_ids=${item.id}`}>Create insurance list</Link>
                </Button>
              </OptionalFormSection>
            )}

            <OptionalFormSection
              id="optional-warranty"
              title="Warranty"
              summary={warrantySummary}
              open={warrantyOpen}
              onToggle={() => setWarrantyOpen((current) => !current)}
            >
              <p className="text-2xs leading-relaxed text-muted-foreground">
                Keep the end date in view so nothing slips past.
              </p>
              {warrantyDatesInvalid && (
                <FormError message="The warranty end date must come after its start date." />
              )}
              <Field label="Provider" htmlFor="warranty-provider" optional>
                <Input
                  id="warranty-provider"
                  maxLength={160}
                  value={warrantyProvider}
                  onChange={(event) => setWarrantyProvider(event.target.value)}
                  placeholder="Manufacturer or retailer"
                />
              </Field>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-5">
                <Field label="Starts" htmlFor="warranty-start" optional>
                  <Input
                    id="warranty-start"
                    type="date"
                    value={warrantyStart}
                    onChange={(event) => setWarrantyStart(event.target.value)}
                  />
                </Field>
                <Field
                  label="Duration (months)"
                  htmlFor="warranty-duration"
                  optional
                  error={
                    durationInvalid
                      ? "Enter a whole number from 1 to 1,200."
                      : undefined
                  }
                >
                  <Input
                    id="warranty-duration"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={1200}
                    step={1}
                    value={warrantyDuration}
                    onChange={(event) => setWarrantyDuration(event.target.value)}
                    placeholder="24"
                  />
                </Field>
                <Field
                  label="Ends"
                  htmlFor="warranty-end"
                  optional
                  hint={durationNumber ? "Calculated from start + duration" : undefined}
                >
                  <Input
                    id="warranty-end"
                    type="date"
                    min={warrantyStart || undefined}
                    value={computedWarrantyEnd}
                    disabled={Boolean(durationNumber)}
                    onChange={(event) => setWarrantyEnd(event.target.value)}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-5">
                <Field label="Reminder (days)" htmlFor="warranty-reminder" optional>
                  <Input
                    id="warranty-reminder"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={3650}
                    step={1}
                    value={warrantyReminder}
                    onChange={(event) => setWarrantyReminder(event.target.value)}
                    placeholder="Uses household setting"
                  />
                </Field>
                <Field label="Warranty document" htmlFor="warranty-document" optional>
                  <Select
                    id="warranty-document"
                    value={warrantyDocumentId}
                    onChange={(event) => setWarrantyDocumentId(event.target.value)}
                  >
                    <option value="">No document linked</option>
                    {(documentsQuery.data?.items ?? []).map((document) => (
                      <option key={document.id} value={document.id}>
                        {document.title} · {DOCUMENT_TYPE_LABELS[document.document_type]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Coverage notes" htmlFor="warranty-notes" optional>
                <Textarea
                  id="warranty-notes"
                  maxLength={4000}
                  value={warrantyNotes}
                  onChange={(event) => setWarrantyNotes(event.target.value)}
                  placeholder="What the warranty covers, exclusions, claim phone number."
                />
              </Field>
            </OptionalFormSection>
        </div>

        {/* Save stays in reach: the footer sticks to the bottom of whatever scrolls the form. */}
        <div
          data-testid="item-form-footer"
          className={cn(
            "sticky z-20 -mx-1 flex items-center justify-end gap-3 border-t border-border/70 bg-background/95 px-1 py-3 backdrop-blur-xl",
            // A phone held sideways with the keyboard open: the footer would cover the field.
            "[[data-keyboard-tiny]_&]:static",
            // In the side panel (a tablet held sideways) the footer does not stick while a
            // touch keyboard is open. The panel is short then, and the footer would lie
            // on the field that is typed in. It sticks again when the keyboard closes.
            presentation === "panel"
              ? "bottom-0 [[data-keyboard]_&]:static"
              : "bottom-[calc(var(--shell-bar-height,0px)+var(--keyboard-inset,0px))]",
          )}
        >
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              protection.discardChanges();
              navigate(
                item
                  ? cancelTo ?? `/items/${item.id}`
                  : cancelTo ?? origin?.path ?? "/items",
              );
            }}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="lg"
            className="min-w-0"
            disabled={
              save.isPending ||
              !name.trim() ||
              quantityInvalid ||
              priceInvalid ||
              durationInvalid ||
              warrantyDatesInvalid
            }
          >
            {save.isPending && <Spinner />}
            {item ? "Save changes" : "Add to your home"}
          </Button>
        </div>
      </form>

      <CategoryDialog
        open={categoryDialogOpen}
        onOpenChange={setCategoryDialogOpen}
        onCreated={(category: Category) => setCategoryId(category.id)}
      />
      <RoomDialog
        open={roomDialogOpen}
        onOpenChange={setRoomDialogOpen}
        rooms={roomsQuery.data?.items ?? []}
        defaultParentId={roomId || undefined}
        defaultPropertyId={propertyId || undefined}
        onCreated={(room: Room) => {
          setPropertyId(room.property_id ?? "");
          setRoomId(room.id);
          setLocationId("");
        }}
      />
    </>
  );
}
