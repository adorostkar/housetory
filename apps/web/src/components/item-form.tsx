import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Plus } from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { CategoryDialog } from "@/components/category-dialog";
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

export function ItemForm({
  item,
  duplicateOf,
  defaultPropertyId,
  defaultRoomId,
  defaultLocationId,
  defaultName,
  returnTo,
  cancelTo,
  origin,
}: {
  item?: ItemDetail;
  duplicateOf?: ItemDetail;
  defaultPropertyId?: string;
  defaultRoomId?: string;
  defaultLocationId?: string;
  defaultName?: string;
  returnTo?: string;
  cancelTo?: string;
  origin?: ItemOrigin | null;
}) {
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
  const parsedQuantity = /^\d+$/.test(quantity) ? Number(quantity) : 0;
  const hasReviewedAllocation = Boolean(
    item?.purchase?.allocations.some((allocation) => allocation.item_id === item?.id),
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

  const save = useMutation({
    mutationFn: (payload: ItemInput) =>
      item
        ? api.patch<ItemDetailResponse>(`/items/${item.id}`, payload)
        : api.post<ItemDetailResponse>("/items", payload),
    onSuccess: (response) => {
      invalidate();
      toast.success(item ? "Item updated" : "Item added");
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

  return (
    <>
      <form onSubmit={submit} className="space-y-6" noValidate>
        {generalError && <FormError message={generalError} />}

        <FormSection
          title="The essentials"
          description="Name, quantity and place come first. Optional identity and financial details stay collapsed below."
        >
              <Field label="Item name" htmlFor="item-name" error={fieldErrors?.name}>
                <Input
                  id="item-name"
                  autoFocus
                  required
                  maxLength={200}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Espresso machine"
                />
              </Field>

              <div className="grid gap-5 sm:grid-cols-[130px_minmax(0,1fr)]">
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

              <div className="rounded-xl border border-border/60 bg-background/30 p-3.5">
                <p className="mb-3 text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  Place
                </p>
                <div className="space-y-4">
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

                  <div className="grid gap-4 sm:grid-cols-2">
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
                  {selectedLocationPath.length > 1 && (
                    <p className="text-2xs leading-relaxed text-muted-foreground">
                      {selectedLocationPath
                        .map((location) => locationLabel(location))
                        .join(" / ")}
                    </p>
                  )}
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
              <div className="grid gap-5 sm:grid-cols-2">
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
                          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-2xs transition-colors",
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
                    className="h-9 text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="size-9"
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
              <div className="grid gap-5 sm:grid-cols-2">
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
              <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_130px]">
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
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Order number" htmlFor="purchase-order" optional>
                  <Input
                    id="purchase-order"
                    maxLength={120}
                    value={orderNumber}
                    onChange={(event) => setOrderNumber(event.target.value)}
                    placeholder="Order or receipt reference"
                  />
                </Field>
                <Field label="Receipt document" htmlFor="purchase-receipt" optional>
                  <Select
                    id="purchase-receipt"
                    value={receiptDocumentId}
                    onChange={(event) => setReceiptDocumentId(event.target.value)}
                  >
                    <option value="">No receipt linked</option>
                    {(documentsQuery.data?.items ?? []).map((document) => (
                      <option key={document.id} value={document.id}>
                        {document.title} · {DOCUMENT_TYPE_LABELS[document.document_type]}
                      </option>
                    ))}
                  </Select>
                </Field>
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
              <div className="grid gap-5 sm:grid-cols-3">
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
              <div className="grid gap-5 sm:grid-cols-2">
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

        <div className="flex flex-col-reverse items-stretch gap-3 border-t border-border/70 pt-6 sm:flex-row sm:items-center sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              navigate(
                item
                  ? cancelTo ?? `/items/${item.id}`
                  : cancelTo ?? origin?.path ?? "/items",
              )
            }
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="lg"
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
