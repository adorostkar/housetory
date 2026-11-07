import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Plus } from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { CategoryDialog } from "@/components/category-dialog";
import { Field, FormError } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import {
  queryKeys,
  useCategories,
  useDocuments,
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
  Tag,
} from "@/lib/types";
import {
  CURRENCIES,
  DOCUMENT_TYPE_LABELS,
} from "@/lib/labels";
import {
  addMonthsIso,
  cn,
  CONDITION_LABELS,
  flattenLocations,
  flattenRoomTree,
  formatCurrency,
  LOCATION_KIND_LABELS,
  locationLabel,
  locationPath,
  roomPath,
} from "@/lib/utils";
const CONDITIONS: ItemCondition[] = ["new", "excellent", "good", "fair", "poor", "unknown"];

function FormSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("surface p-5 sm:p-7", className)}>
      <div className="mb-6">
        <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">{title}</h2>
        {description && (
          <p className="mt-1 text-[0.78rem] leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

export function ItemForm({
  item,
  defaultPropertyId,
  defaultRoomId,
  defaultLocationId,
  defaultName,
  returnTo,
  cancelTo,
}: {
  item?: ItemDetail;
  defaultPropertyId?: string;
  defaultRoomId?: string;
  defaultLocationId?: string;
  defaultName?: string;
  returnTo?: string;
  cancelTo?: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateInventory();
  const propertiesQuery = useProperties();
  const properties = propertiesQuery.data?.items ?? [];
  const [propertyId, setPropertyId] = React.useState(
    item?.property?.id ?? defaultPropertyId ?? "",
  );
  const roomsQuery = useRooms(propertyId || undefined);
  const categoriesQuery = useCategories();
  const tagsQuery = useTags();
  const documentsQuery = useDocuments({}, 100);

  const [name, setName] = React.useState(item?.name ?? defaultName ?? "");
  const [description, setDescription] = React.useState(item?.description ?? "");
  const [brand, setBrand] = React.useState(item?.brand ?? "");
  const [model, setModel] = React.useState(item?.model ?? "");
  const [serialNumber, setSerialNumber] = React.useState(item?.serial_number ?? "");
  const [quantity, setQuantity] = React.useState(String(item?.quantity ?? 1));
  const [condition, setCondition] = React.useState<ItemCondition>(item?.condition ?? "good");
  const [roomId, setRoomId] = React.useState(item?.room?.id ?? defaultRoomId ?? "");
  const [locationId, setLocationId] = React.useState(
    item?.location?.id ?? defaultLocationId ?? "",
  );
  React.useEffect(() => {
    if (propertyId) return;
    const selectedRoom = roomsQuery.data?.items.find((room) => room.id === roomId);
    if (item?.property?.id) setPropertyId(item.property.id);
    else if (defaultPropertyId) setPropertyId(defaultPropertyId);
    else if (selectedRoom?.property_id) setPropertyId(selectedRoom.property_id);
    else if (properties.length === 1) setPropertyId(properties[0]!.id);
  }, [
    propertyId,
    item?.property?.id,
    defaultPropertyId,
    properties,
    roomId,
    roomsQuery.data?.items,
  ]);
  const [categoryId, setCategoryId] = React.useState(item?.category?.id ?? "");
  const [tagIds, setTagIds] = React.useState<string[]>(item?.tags.map((tag) => tag.id) ?? []);
  const [newTag, setNewTag] = React.useState("");
  const [tagError, setTagError] = React.useState<string | null>(null);
  const [categoryDialogOpen, setCategoryDialogOpen] = React.useState(false);

  const [vendor, setVendor] = React.useState(item?.purchase?.vendor ?? "");
  const [purchaseDate, setPurchaseDate] = React.useState(item?.purchase?.purchase_date ?? "");
  const [price, setPrice] = React.useState(
    item?.purchase?.price_cents != null ? (item.purchase.price_cents / 100).toFixed(2) : "",
  );
  const [currency, setCurrency] = React.useState(item?.purchase?.currency ?? "USD");
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
  const [currentValue, setCurrentValue] = React.useState(
    item?.current_value_cents != null
      ? (item.current_value_cents / 100).toFixed(2)
      : "",
  );
  const [currentValueCurrency, setCurrentValueCurrency] = React.useState(
    item?.current_value_currency ?? "USD",
  );
  const [currentValueBasis, setCurrentValueBasis] = React.useState<
    "per_unit" | "legacy_record_total"
  >(
    item?.current_value_basis ??
      (item?.current_value_cents != null ? "legacy_record_total" : "per_unit"),
  );

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

  const locationsQuery = useLocations(roomId || undefined);
  const locationOptions = flattenLocations(locationsQuery.data?.items ?? []);
  const roomOptions = flattenRoomTree(roomsQuery.data?.items ?? []);
  const selectedLocationPath = locationPath(
    locationsQuery.data?.items ?? [],
    locationId,
  );
  const localPriceCents = price.trim() ? Math.round(Number(price) * 100) : null;
  const priceInvalid =
    price.trim().length > 0 &&
    (localPriceCents === null || !Number.isFinite(localPriceCents) || localPriceCents < 0);
  const localCurrentValueCents = currentValue.trim()
    ? Math.round(Number(currentValue) * 100)
    : null;
  const currentValueInvalid =
    currentValue.trim().length > 0 &&
    (localCurrentValueCents === null ||
      !Number.isFinite(localCurrentValueCents) ||
      localCurrentValueCents < 0);
  const parsedQuantity = /^\d+$/.test(quantity) ? Number(quantity) : 0;
  const currentValueTotalCents =
    localCurrentValueCents == null
      ? null
      : currentValueBasis === "per_unit"
        ? localCurrentValueCents * parsedQuantity
        : localCurrentValueCents;
  const convertLegacyToPerUnit = () => {
    if (localCurrentValueCents == null || parsedQuantity <= 0) {
      setCurrentValueBasis("per_unit");
      return;
    }
    const unitCents = Math.round(localCurrentValueCents / parsedQuantity);
    setCurrentValue((unitCents / 100).toFixed(2));
    setCurrentValueBasis("per_unit");
  };
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
        item && returnTo ? returnTo : `/items/${response.item.id}`,
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

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (
      !name.trim() ||
      quantityInvalid ||
      priceInvalid ||
      currentValueInvalid ||
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
            price_cents: localPriceCents,
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
      current_value_cents: localCurrentValueCents,
      current_value_currency: currentValueCurrency,
      current_value_basis: currentValueBasis,
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

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-6">
            <FormSection title="The essentials">
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

              <div className="grid gap-5 sm:grid-cols-[130px_minmax(0,1fr)]">
                <Field
                  label="Quantity"
                  htmlFor="item-quantity"
                  error={quantityInvalid ? "Enter a whole number from 0 to 1,000,000." : undefined}
                >
                  <Input
                    id="item-quantity"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={1_000_000}
                    step={1}
                    value={quantity}
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

              <Field label="Description" htmlFor="item-description" optional>
                <Textarea
                  id="item-description"
                  maxLength={4000}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Colour, material, where it came from, anything worth remembering."
                />
              </Field>
            </FormSection>

            <FormSection
              title="Purchase"
              description="The original transaction total and receipt trail. This is not a per-unit price."
            >
              {item?.purchase?.is_shared && (
                <div className="rounded-xl border border-brass/20 bg-brass-soft/60 px-3.5 py-3 text-[0.74rem] leading-relaxed text-muted-foreground">
                  This purchase is shared by {item.purchase.item_count} items. The
                  amount is the purchase transaction total, not a per-unit price, and
                  is not multiplied by quantity. Editing it updates the single shared
                  record; reviewed item allocations remain separate.
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
                  label="Purchase total"
                  htmlFor="purchase-price"
                  optional
                  hint="Transaction total, including all linked units/items when shared."
                >
                  <Input
                    id="purchase-price"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={price}
                    onChange={(event) => setPrice(event.target.value)}
                    placeholder="0.00"
                  />
                </Field>
                <Field label="Currency" htmlFor="purchase-currency">
                  <Select
                    id="purchase-currency"
                    value={currency}
                    onChange={(event) => setCurrency(event.target.value)}
                  >
                    {CURRENCIES.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
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
            </FormSection>

            <FormSection
              title="Current value"
              description="An optional estimate of what one owned unit is worth today. It is kept separate from the original purchase transaction total."
            >
              {currentValueInvalid && (
                <FormError message="Enter a valid current value, such as 129.00." />
              )}
              {currentValueBasis === "legacy_record_total" && (
                <div className="rounded-xl border border-brass/25 bg-brass-soft/45 px-3.5 py-3 text-[0.74rem] leading-relaxed text-muted-foreground">
                  <p className="font-medium text-foreground/85">Legacy recorded total</p>
                  <p className="mt-1">
                    This older value was saved as one amount for the whole item record,
                    not as a per-unit estimate. It is reported once and is not
                    multiplied by quantity. Review it and convert to a per-unit
                    estimate when you are ready.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2.5"
                    onClick={convertLegacyToPerUnit}
                  >
                    Convert to per-unit
                  </Button>
                </div>
              )}
              <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_130px]">
                <Field
                  label={
                    currentValueBasis === "legacy_record_total"
                      ? "Legacy recorded total"
                      : "Estimated current value per unit"
                  }
                  htmlFor="current-value"
                  optional
                >
                  <Input
                    id="current-value"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={currentValue}
                    onChange={(event) => setCurrentValue(event.target.value)}
                    placeholder="0.00"
                  />
                </Field>
                <Field label="Currency" htmlFor="current-value-currency">
                  <Select
                    id="current-value-currency"
                    value={currentValueCurrency}
                    onChange={(event) => setCurrentValueCurrency(event.target.value)}
                  >
                    {CURRENCIES.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              {localCurrentValueCents != null && (
                <div
                  data-testid="current-value-preview"
                  className="rounded-lg border border-border/60 bg-secondary/20 px-3.5 py-3 text-[0.74rem] leading-relaxed"
                >
                  {currentValueBasis === "per_unit" ? (
                    <>
                      {quantityInvalid ? (
                        <p className="text-muted-foreground">
                          Enter a valid owned quantity to compute the extended total.
                        </p>
                      ) : (
                        <p className="font-medium">
                          {parsedQuantity} owned{" "}
                          {parsedQuantity === 1 ? "unit" : "units"} ×{" "}
                          {formatCurrency(localCurrentValueCents, currentValueCurrency)} ={" "}
                          {formatCurrency(currentValueTotalCents ?? 0, currentValueCurrency)}
                        </p>
                      )}
                      <p className="mt-1 text-muted-foreground">
                        Loaned owned units remain included. Borrowed items are not owned
                        and never enter this total. Leave blank if the value is unknown;
                        missing is not zero.
                      </p>
                    </>
                  ) : (
                    <p className="text-muted-foreground">
                      Reported as one legacy record total of{" "}
                      {formatCurrency(localCurrentValueCents, currentValueCurrency)}. It
                      does not change when quantity changes. Convert above to review a
                      per-unit estimate.
                    </p>
                  )}
                </div>
              )}
            </FormSection>

            <FormSection
              title="Warranty"
              description="Keep the end date in view so nothing slips past."
            >
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
            </FormSection>
          </div>

          <div className="space-y-6 xl:sticky xl:top-8">
            <FormSection
              title="Its place"
              description="Every item can belong to a room and a more specific place."
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

              <Field label="Room" htmlFor="item-room" error={fieldErrors?.room_id}>
                <Select
                  id="item-room"
                  value={roomId}
                  onChange={(event) => {
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
                {selectedLocationPath.length > 1 && (
                  <p className="mt-2 text-[0.7rem] leading-relaxed text-muted-foreground">
                    {selectedLocationPath
                      .map((location) => locationLabel(location))
                      .join(" / ")}
                  </p>
                )}
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
                    variant="outline"
                    size="icon"
                    aria-label="Create a category"
                    onClick={() => setCategoryDialogOpen(true)}
                  >
                    <Plus />
                  </Button>
                </div>
              </Field>
            </FormSection>

            <FormSection title="Tags" description="Loose labels that cut across rooms.">
              <div className="flex flex-wrap gap-2">
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
                        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[0.75rem] transition-colors",
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
                  <p className="text-[0.75rem] text-muted-foreground">
                    No tags yet. Create one below.
                  </p>
                )}
              </div>

              <div className="flex gap-2">
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
                  className="h-9 text-[0.8rem]"
                />
                <Button
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
              {tagError && <p className="text-[0.74rem] text-destructive">{tagError}</p>}
            </FormSection>
          </div>
        </div>

        <div className="flex flex-col-reverse items-stretch gap-3 border-t border-border/70 pt-6 sm:flex-row sm:items-center sm:justify-end">
          <Button
            variant="ghost"
            onClick={() =>
              navigate(
                item
                  ? cancelTo ?? `/items/${item.id}`
                  : cancelTo ?? "/items",
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
              currentValueInvalid ||
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
    </>
  );
}
