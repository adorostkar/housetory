import {
  AlertTriangle,
  ArrowUpRight,
  CircleHelp,
  FileText,
  GitMerge,
  Plus,
  Sparkles,
} from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/form-field";
import { Input } from "@/components/ui/input";
import { MoreDetails, ReviewRow, type ReviewValue } from "@/components/review-row";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type {
  Category,
  DuplicateCandidate,
  ImportDecision,
  ImportEntry,
  ImportMergeField,
  LocationProposal,
  ProposedItem,
  Room,
  StorageLocation,
} from "@/lib/types";
import { CURRENCIES } from "@/lib/labels";
import { useDefaultCurrency } from "@/lib/queries";
import { formatCurrency, locationPath } from "@/lib/utils";

const MERGE_FIELDS: Array<{ value: ImportMergeField; label: string }> = [
  { value: "serial_number", label: "Serial number" },
  { value: "brand", label: "Brand" },
  { value: "model", label: "Model" },
  { value: "description", label: "Description" },
  { value: "quantity", label: "Quantity" },
  { value: "purchase", label: "Purchase" },
  { value: "warranty", label: "Warranty" },
  { value: "room", label: "Room" },
  { value: "storage_location", label: "Storage place" },
  { value: "tags", label: "Tags" },
];

function sourceLabel(source: string | undefined): string {
  if (source === "explicit") return "Explicit";
  if (source === "inferred") return "AI suggested";
  return "Missing";
}

function SourceBadge({ source }: { source: string | undefined }) {
  return (
    <Badge
      variant={source === "explicit" ? "sage" : source === "inferred" ? "brass" : "outline"}
      className="text-2xs"
    >
      {sourceLabel(source)}
    </Badge>
  );
}

/** What must be right before a row can be accepted. Each message belongs to one field. */
export interface ImportEntryErrors {
  name?: string;
  quantity?: string;
  room?: string;
  storage_location?: string;
  merge?: string;
}

export function validateImportEntry(
  proposed: ProposedItem,
  decision: ImportDecision,
): ImportEntryErrors {
  const errors: ImportEntryErrors = {};
  if (decision.action === "merge") {
    if (!decision.mergeItemId) errors.merge = "Choose the existing item to update.";
    else if (decision.mergeFields.length === 0) errors.merge = "Choose at least one field to update.";
    return errors;
  }
  if (!proposed.name.trim()) errors.name = "Give this item a name.";
  if (!Number.isInteger(proposed.quantity) || proposed.quantity < 0) {
    errors.quantity = "Enter a whole number, 0 or more.";
  }
  if (proposed.room?.status === "ambiguous") {
    errors.room = "More than one room matches. Choose the room.";
  }
  if (proposed.storage_location?.status === "ambiguous") {
    errors.storage_location = "More than one place matches. Choose the place.";
  }
  return errors;
}

export function hasImportEntryErrors(errors: ImportEntryErrors | undefined): boolean {
  return Boolean(errors && Object.values(errors).some(Boolean));
}

// The fields of an existing item that a possible duplicate tells us about.
const CANDIDATE_VALUES: Partial<Record<ImportMergeField, (candidate: DuplicateCandidate) => string | null>> = {
  brand: (candidate) => candidate.brand,
  model: (candidate) => candidate.model,
  serial_number: (candidate) => candidate.serial_number,
  room: (candidate) => candidate.room_name,
  storage_location: (candidate) => candidate.location_name,
};

export function ImportEntryCard({
  entry,
  proposed,
  decision,
  rooms,
  locations,
  categories,
  onProposedChange,
  onDecisionChange,
  onCreateRoom,
  onCreateLocation,
  disabled,
  errors,
  pending = false,
  onAdd,
  onSkip,
  onReject,
}: {
  entry: ImportEntry;
  proposed: ProposedItem;
  decision: ImportDecision;
  rooms: Room[];
  locations: StorageLocation[];
  categories: Category[];
  onProposedChange: (proposed: ProposedItem) => void;
  onDecisionChange: (decision: ImportDecision) => void;
  onCreateRoom: (entryId: string, name: string) => Promise<Room | null>;
  onCreateLocation: (
    entryId: string,
    roomId: string,
    name: string,
    parentId: string | null,
  ) => Promise<StorageLocation | null>;
  disabled: boolean;
  /** Messages from the last attempt to accept this row. Shown beside their fields. */
  errors?: ImportEntryErrors;
  /** This row is being saved right now. */
  pending?: boolean;
  /** Add this one row (or apply its update) without touching the others. */
  onAdd?: () => void;
  /** Skip removes the row from the list. Its edits are kept and it can be restored. */
  onSkip?: () => void;
  onReject?: () => void;
}) {
  const defaultCurrency = useDefaultCurrency();
  // Rows start closed. Only a field that must be corrected opens the editor by itself.
  const [open, setOpen] = React.useState(false);
  const needsEditor = Boolean(errors?.room || errors?.storage_location);
  React.useEffect(() => {
    if (needsEditor) setOpen(true);
  }, [needsEditor]);
  // Decided once, so a field does not jump out of "More details" while it is typed in.
  const [filled] = React.useState(() => ({
    identity: Boolean(
      proposed.brand || proposed.model || proposed.serial_number ||
      proposed.tags.length || proposed.description,
    ),
    purchase: Boolean(
      proposed.purchase && (proposed.purchase.merchant || proposed.purchase.purchase_date ||
        proposed.purchase.price_cents != null || proposed.purchase.order_number),
    ),
    warranty: Boolean(proposed.warranty && (proposed.warranty.provider || proposed.warranty.end_date)),
  }));
  const [creatingRoom, setCreatingRoom] = React.useState(false);
  const [creatingLocation, setCreatingLocation] = React.useState(false);
  const final = ["imported", "merged", "skipped", "rejected"].includes(entry.status);
  const highDuplicate = entry.duplicate_candidates.some((candidate) => candidate.score >= 70);
  const inferredFields = Object.entries(proposed.field_sources)
    .filter(([, source]) => source === "inferred")
    .map(([field]) => field);

  const update = (patch: Partial<ProposedItem>) => onProposedChange({ ...proposed, ...patch });
  const setDecision = (patch: Partial<ImportDecision>) =>
    onDecisionChange({ ...decision, ...patch });

  const roomOptions = [...rooms].sort((a, b) => a.name.localeCompare(b.name));
  const roomLocations = [...locations]
    .filter((location) => location.room_id === proposed.room?.matched_id)
    .sort((a, b) => a.name.localeCompare(b.name));

  const applyRoom = (room: Room) => {
    const roomProposal: LocationProposal = {
      text: room.name,
      entity_type: "room",
      status: "matched",
      matched_id: room.id,
      name: room.name,
      room_id: room.id,
      parent_id: room.parent_id,
      suggested_parent_id: null,
      candidates: [],
    };
    update({
      room: roomProposal,
      storage_location:
        proposed.storage_location?.room_id === room.id ? proposed.storage_location : null,
    });
  };

  const applyLocation = (location: StorageLocation) => {
    update({
      storage_location: {
        text: location.name,
        entity_type: "storage_location",
        status: "matched",
        matched_id: location.id,
        name: location.name,
        room_id: location.room_id,
        parent_id: location.parent_id,
        suggested_parent_id: null,
        candidates: [],
      },
    });
  };

  const setRoom = (roomId: string) => {
    const room = rooms.find((entryRoom) => entryRoom.id === roomId);
    if (!room) {
      update({ room: null, storage_location: null });
      return;
    }
    applyRoom(room);
  };

  const setLocation = (locationId: string) => {
    if (!locationId) {
      update({ storage_location: null });
      return;
    }
    const location = locations.find((entryLocation) => entryLocation.id === locationId);
    if (location) applyLocation(location);
  };

  const createRoom = async () => {
    if (!proposed.room?.name) return;
    setCreatingRoom(true);
    try {
      const room = await onCreateRoom(entry.id, proposed.room.name);
      if (room) applyRoom(room);
    } finally {
      setCreatingRoom(false);
    }
  };

  const createLocation = async () => {
    if (!proposed.storage_location?.name || !proposed.room?.matched_id) return;
    setCreatingLocation(true);
    try {
      const location = await onCreateLocation(
        entry.id,
        proposed.room.matched_id,
        proposed.storage_location.name,
        proposed.storage_location.suggested_parent_id ?? null,
      );
      if (location) applyLocation(location);
    } finally {
      setCreatingLocation(false);
    }
  };

  const showRoomSelect =
    proposed.room?.status === "matched" ||
    proposed.room?.status === "ambiguous" ||
    !proposed.room;
  const showLocationSelect =
    Boolean(proposed.room?.matched_id) &&
    (proposed.storage_location?.status === "matched" ||
      proposed.storage_location?.status === "ambiguous" ||
      !proposed.storage_location);

  const mergeCandidate = decision.action === "merge"
    ? entry.duplicate_candidates.find((candidate) => candidate.item_id === decision.mergeItemId)
    : undefined;
  const inferred = (field: string) => proposed.field_sources[field] === "inferred";
  const unsettled = (proposal: LocationProposal | null) =>
    proposal?.status === "missing" || proposal?.status === "ambiguous";
  const placeName = (proposal: LocationProposal) =>
    `${proposal.name ?? proposal.text}${proposal.status === "missing" ? " (new)" : ""}`;
  const placeText = [
    proposed.room ? placeName(proposed.room) : "No room",
    proposed.storage_location ? placeName(proposed.storage_location) : null,
  ].filter(Boolean).join(" / ");
  const proposedValue: Partial<Record<ImportMergeField, string | null>> = {
    brand: proposed.brand,
    model: proposed.model,
    serial_number: proposed.serial_number,
    room: proposed.room?.name ?? null,
    storage_location: proposed.storage_location?.name ?? null,
    description: proposed.description,
    quantity: String(proposed.quantity),
    tags: proposed.tags.join(", ") || null,
    purchase: proposed.purchase?.price_cents != null
      ? formatCurrency(proposed.purchase.price_cents, proposed.purchase.currency ?? defaultCurrency)
      : proposed.purchase?.merchant ?? null,
    warranty: proposed.warranty?.end_date ?? proposed.warranty?.provider ?? null,
  };
  // A new record shows the values that were read. An update shows old → proposed.
  const values: ReviewValue[] = mergeCandidate
    ? [
        { label: "Updates", value: mergeCandidate.name },
        ...MERGE_FIELDS.filter((field) => decision.mergeFields.includes(field.value)).map((field) => {
          const current = CANDIDATE_VALUES[field.value];
          return {
            label: field.label,
            before: current ? current(mergeCandidate) ?? "empty" : undefined,
            value: proposedValue[field.value] ?? "empty",
          };
        }),
      ]
    : [
        {
          label: "Place",
          value: placeText,
          uncertain: unsettled(proposed.room) || unsettled(proposed.storage_location) ||
            inferred("room") || inferred("storage_location"),
        },
        ...(proposed.category?.name
          ? [{ label: "Category", value: proposed.category.name, uncertain: inferred("category") }]
          : []),
        ...(proposed.brand || proposed.model
          ? [{
              label: "Make",
              value: [proposed.brand, proposed.model].filter(Boolean).join(" "),
              uncertain: inferred("brand") || inferred("model"),
            }]
          : []),
        ...(proposed.serial_number
          ? [{ label: "Serial", value: proposed.serial_number, uncertain: inferred("serial_number") }]
          : []),
        ...(proposed.purchase?.price_cents != null
          ? [{
              label: "Price",
              value: formatCurrency(proposed.purchase.price_cents, proposed.purchase.currency ?? defaultCurrency),
            }]
          : []),
      ];

  // What a person should see before pressing the row's button, while the row is closed.
  // A possible duplicate, a low confidence and a failed save have their own place in
  // the closed row already. The full texts are in the editor.
  const reviewReason = typeof proposed.relationships?.review_reason === "string"
    ? proposed.relationships.review_reason.trim() : "";
  const placeCheck = (proposal: LocationProposal | null, kind: string) =>
    proposal?.status === "ambiguous" ? [`More than one ${kind} matches`]
      : proposal?.status === "missing" ? [`${kind === "room" ? "Room" : "Place"} “${proposal.name ?? proposal.text}” is new`]
      : [];
  const guessed = ["name", "quantity"].filter((field) => inferred(field));
  const checks = final ? [] : [
    // For example a window or a radiator: part of the building, not a possession.
    ...(proposed.relationships?.review === true
      ? [reviewReason.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? (reviewReason || "This may not be something to add as an item")]
      : []),
    ...placeCheck(proposed.room, "room"),
    ...placeCheck(proposed.storage_location, "place"),
    ...(guessed.length ? [`Guessed, not read: ${guessed.join(", ")}`] : []),
  ];

  const identityBlock = (
    <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Brand" htmlFor={`brand-${entry.id}`} optional>
              <Input
                id={`brand-${entry.id}`}
                value={proposed.brand ?? ""}
                maxLength={120}
                disabled={disabled || final}
                onChange={(event) => update({ brand: event.target.value || null })}
              />
            </Field>
            <Field label="Model" htmlFor={`model-${entry.id}`} optional>
              <Input
                id={`model-${entry.id}`}
                value={proposed.model ?? ""}
                maxLength={120}
                disabled={disabled || final}
                onChange={(event) => update({ model: event.target.value || null })}
              />
            </Field>
            <Field label="Serial number" htmlFor={`serial-${entry.id}`} optional>
              <Input
                id={`serial-${entry.id}`}
                value={proposed.serial_number ?? ""}
                maxLength={200}
                disabled={disabled || final}
                onChange={(event) =>
                  update({ serial_number: event.target.value || null })
                }
              />
            </Field>
            <Field label="Tags" htmlFor={`tags-${entry.id}`} optional>
              <Input
                id={`tags-${entry.id}`}
                value={proposed.tags.join(", ")}
                disabled={disabled || final}
                placeholder="camping, kitchen"
                onChange={(event) =>
                  update({
                    tags: event.target.value
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Description" htmlFor={`description-${entry.id}`} optional>
                <Textarea
                  id={`description-${entry.id}`}
                  value={proposed.description ?? ""}
                  maxLength={4000}
                  disabled={disabled || final}
                  onChange={(event) =>
                    update({ description: event.target.value || null })
                  }
                />
              </Field>
            </div>
    </div>
  );
  const purchaseBlock = (
    <div className="rounded-xl border border-border/60 p-4">
            <p className="text-xs font-medium">Purchase</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Merchant" htmlFor={`merchant-${entry.id}`} optional>
                <Input
                  id={`merchant-${entry.id}`}
                  value={proposed.purchase?.merchant ?? ""}
                  maxLength={160}
                  disabled={disabled || final}
                  onChange={(event) =>
                    update({
                      purchase: {
                        purchase_date: proposed.purchase?.purchase_date ?? null,
                        price_cents: proposed.purchase?.price_cents ?? null,
                        currency: proposed.purchase?.currency ?? defaultCurrency,
                        order_number: proposed.purchase?.order_number ?? null,
                        notes: proposed.purchase?.notes ?? null,
                        merchant: event.target.value || null,
                      },
                    })
                  }
                />
              </Field>
              <Field label="Purchase date" htmlFor={`purchase-date-${entry.id}`} optional>
                <Input
                  id={`purchase-date-${entry.id}`}
                  type="date"
                  value={proposed.purchase?.purchase_date ?? ""}
                  disabled={disabled || final}
                  onChange={(event) =>
                    update({
                      purchase: {
                        merchant: proposed.purchase?.merchant ?? null,
                        purchase_date: event.target.value || null,
                        price_cents: proposed.purchase?.price_cents ?? null,
                        currency: proposed.purchase?.currency ?? defaultCurrency,
                        order_number: proposed.purchase?.order_number ?? null,
                        notes: proposed.purchase?.notes ?? null,
                      },
                    })
                  }
                />
              </Field>
              <Field label="Price" htmlFor={`price-${entry.id}`} optional>
                <Input
                  id={`price-${entry.id}`}
                  type="number"
                  min={0}
                  step="0.01"
                  value={
                    proposed.purchase?.price_cents != null
                      ? (proposed.purchase.price_cents / 100).toFixed(2)
                      : ""
                  }
                  disabled={disabled || final}
                  onChange={(event) =>
                    update({
                      purchase: {
                        merchant: proposed.purchase?.merchant ?? null,
                        purchase_date: proposed.purchase?.purchase_date ?? null,
                        price_cents: event.target.value
                          ? Math.round(Number(event.target.value) * 100)
                          : null,
                        currency: proposed.purchase?.currency ?? defaultCurrency,
                        order_number: proposed.purchase?.order_number ?? null,
                        notes: proposed.purchase?.notes ?? null,
                      },
                    })
                  }
                />
              </Field>
              <Field label="Currency" htmlFor={`currency-${entry.id}`}>
                <Select
                  id={`currency-${entry.id}`}
                  value={proposed.purchase?.currency ?? defaultCurrency}
                  disabled={disabled || final}
                  onChange={(event) =>
                    update({
                      purchase: {
                        merchant: proposed.purchase?.merchant ?? null,
                        purchase_date: proposed.purchase?.purchase_date ?? null,
                        price_cents: proposed.purchase?.price_cents ?? null,
                        currency: event.target.value || null,
                        order_number: proposed.purchase?.order_number ?? null,
                        notes: proposed.purchase?.notes ?? null,
                      },
                    })
                  }
                >
                  {CURRENCIES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Order number" htmlFor={`order-${entry.id}`} optional>
                <Input
                  id={`order-${entry.id}`}
                  value={proposed.purchase?.order_number ?? ""}
                  maxLength={120}
                  disabled={disabled || final}
                  onChange={(event) =>
                    update({
                      purchase: {
                        merchant: proposed.purchase?.merchant ?? null,
                        purchase_date: proposed.purchase?.purchase_date ?? null,
                        price_cents: proposed.purchase?.price_cents ?? null,
                        currency: proposed.purchase?.currency ?? defaultCurrency,
                        order_number: event.target.value || null,
                        notes: proposed.purchase?.notes ?? null,
                      },
                    })
                  }
                />
              </Field>
            </div>
    </div>
  );
  const warrantyBlock = (
    <div className="rounded-xl border border-border/60 p-4">
            <p className="text-xs font-medium">Warranty</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Provider" htmlFor={`warranty-provider-${entry.id}`} optional>
                <Input
                  id={`warranty-provider-${entry.id}`}
                  value={proposed.warranty?.provider ?? ""}
                  maxLength={160}
                  disabled={disabled || final}
                  onChange={(event) =>
                    update({
                      warranty: {
                        provider: event.target.value || null,
                        start_date: proposed.warranty?.start_date ?? null,
                        duration_months: proposed.warranty?.duration_months ?? null,
                        end_date: proposed.warranty?.end_date ?? null,
                        notes: proposed.warranty?.notes ?? null,
                      },
                    })
                  }
                />
              </Field>
              <Field label="Ends" htmlFor={`warranty-end-${entry.id}`} optional>
                <Input
                  id={`warranty-end-${entry.id}`}
                  type="date"
                  value={proposed.warranty?.end_date ?? ""}
                  disabled={disabled || final}
                  onChange={(event) =>
                    update({
                      warranty: {
                        provider: proposed.warranty?.provider ?? null,
                        start_date: proposed.warranty?.start_date ?? null,
                        duration_months: proposed.warranty?.duration_months ?? null,
                        end_date: event.target.value || null,
                        notes: proposed.warranty?.notes ?? null,
                      },
                    })
                  }
                />
              </Field>
            </div>
    </div>
  );

  // Shown only when a duplicate was found. Otherwise a row has no merge choices at all.
  const duplicates = entry.duplicate_candidates.length > 0 && !final && (
    <div className="rounded-xl border border-brass/25 bg-brass-soft/40 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-brass">
        <AlertTriangle className="size-3.5" /> You may already have this
      </p>
      <div className="mt-2 space-y-2">
        {entry.duplicate_candidates.map((candidate) => {
          const chosen = decision.action === "merge" && decision.mergeItemId === candidate.item_id;
          return (
            <div
              key={candidate.item_id}
              className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <Link
                  to={`/items/${candidate.item_id}`}
                  className="text-xs font-medium underline-offset-4 hover:underline"
                >
                  {candidate.name}
                </Link>
                <p className="text-2xs text-muted-foreground">
                  {[candidate.brand, candidate.model, candidate.room_name]
                    .filter(Boolean)
                    .join(" · ")}
                  {candidate.reasons.length > 0
                    ? ` · ${candidate.reasons.join(", ")}`
                    : ""}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <Badge variant="brass">{candidate.score}%</Badge>
                <Button
                  type="button"
                  size="sm"
                  variant={chosen ? "default" : "outline"}
                  className="min-h-11 lg:min-h-9"
                  aria-pressed={chosen}
                  disabled={disabled}
                  onClick={() =>
                    setDecision(chosen
                      ? { action: "import", mergeItemId: "" }
                      : {
                          action: "merge",
                          mergeItemId: candidate.item_id,
                          mergeFields: decision.mergeFields.length ? decision.mergeFields : ["serial_number"],
                        })
                  }
                >
                  <GitMerge />
                  {chosen ? "Updating this one" : "Update this one"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {decision.action === "merge" ? (
        <div className="mt-3 border-t border-border/60 pt-3">
          <p className="text-xs font-medium">Fields to update</p>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            Only checked fields are written into the existing item. No new item is added.
          </p>
          <div className="mt-2 grid gap-x-3 sm:grid-cols-2">
            {MERGE_FIELDS.map((field) => (
              <label
                key={field.value}
                className="flex min-h-11 items-center gap-2 text-xs lg:min-h-8"
              >
                <input
                  type="checkbox"
                  className="size-4 rounded-none accent-primary"
                  checked={decision.mergeFields.includes(field.value)}
                  disabled={disabled}
                  onChange={(event) =>
                    setDecision({
                      mergeFields: event.target.checked
                        ? [...decision.mergeFields, field.value]
                        : decision.mergeFields.filter(
                            (value) => value !== field.value,
                          ),
                    })
                  }
                />
                {field.label}
              </label>
            ))}
          </div>
          {errors?.merge && (
            <p role="alert" className="mt-2 text-xs text-destructive">{errors.merge}</p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-2xs text-muted-foreground">
          Add it as a new item, update the one you have, or skip it to keep things as they are.
        </p>
      )}
    </div>
  );

  const done = entry.status === "imported" || entry.status === "merged";
  const doneItemId = entry.imported_item_id ?? entry.matched_item_id;
  return (
    <ReviewRow
      title={proposed.name}
      titleLabel={`Name of ${entry.proposed.name || "this item"}`}
      onTitleChange={final ? undefined : (name) => update({ name })}
      titleError={open ? null : errors?.name}
      quantity={Number.isNaN(proposed.quantity) ? "" : proposed.quantity}
      onQuantityChange={final
        ? undefined
        : (value) => update({ quantity: value === "" ? Number.NaN : Number(value) })}
      quantityError={open ? null : errors?.quantity}
      values={values}
      // While the row is open the same warnings are explained in full below.
      checks={open ? [] : checks}
      disabled={disabled || final}
      selection={final || !onAdd
        ? undefined
        : {
            checked: decision.include,
            onChange: (include) => setDecision({ include }),
            label: `Select ${proposed.name || "this item"}`,
          }}
      badges={
        <>
          {proposed.confidence != null && proposed.confidence < 80 && (
            <Badge variant="brass">{proposed.confidence}% sure</Badge>
          )}
          {highDuplicate && !final && (
            <Badge variant="brass">
              <AlertTriangle className="size-3" />
              Possible duplicate
            </Badge>
          )}
          {proposed.relationships?.ai_assisted ? (
            <Badge variant="brass">
              <Sparkles className="size-3" />
              AI-assisted
            </Badge>
          ) : null}
        </>
      }
      error={entry.error}
      extra={highDuplicate || decision.action === "merge" ? duplicates : null}
      status={done ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{entry.status === "merged" ? "Updated" : "Added"}</span>
          {doneItemId && (
            <Link
              to={`/items/${doneItemId}`}
              className="inline-flex min-h-11 items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline lg:min-h-0"
            >
              Open item <ArrowUpRight className="size-3" />
            </Link>
          )}
        </p>
      ) : undefined}
      primary={onAdd ? {
        label: decision.action === "merge" ? "Apply changes" : "Add item",
        onClick: onAdd,
        pending,
      } : undefined}
      onSkip={onSkip}
      expand={final ? undefined : { open, onOpenChange: setOpen, label: "Edit" }}
    >
      {proposed.relationships?.review === true && reviewReason &&
        !(entry.source_excerpt ?? "").includes(reviewReason) && (
        <p className="flex items-start gap-1.5 rounded-lg border border-brass/20 bg-brass-soft/50 px-3 py-2 text-xs leading-relaxed">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-brass" />
          <span>{reviewReason}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
        <CircleHelp className="size-3.5" />
        <span>Field confidence:</span>
        {["name", "room", "storage_location", "serial_number", "brand", "model"].map(
          (field) => (
            <span key={field} className="inline-flex items-center gap-1">
              <span className="capitalize">{field.replace("_", " ")}</span>
              <SourceBadge source={proposed.field_sources[field]} />
            </span>
          ),
        )}
      </div>
      {inferredFields.length > 0 && (
        <p className="rounded-lg border border-brass/20 bg-brass-soft/50 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
          Inferred by AI/heuristics: {inferredFields.join(", ")}. Verify before
          importing.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Item name" htmlFor={`name-${entry.id}`} error={errors?.name}>
              <Input
                id={`name-${entry.id}`}
                value={proposed.name}
                maxLength={200}
                disabled={disabled || final}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Quantity" htmlFor={`quantity-${entry.id}`} error={errors?.quantity}>
                <Input
                  id={`quantity-${entry.id}`}
                  type="number"
                  min={0}
                  max={1_000_000}
                  value={proposed.quantity}
                  disabled={disabled || final}
                  onChange={(event) => update({ quantity: Number(event.target.value) })}
                />
              </Field>
              <Field label="Category" htmlFor={`category-${entry.id}`}>
                <Input
                  id={`category-${entry.id}`}
                  value={proposed.category?.name ?? ""}
                  maxLength={80}
                  disabled={disabled || final}
                  placeholder="No category"
                  onChange={(event) =>
                    update({
                      category: event.target.value.trim()
                        ? {
                            text: event.target.value,
                            status: "missing",
                            matched_id: null,
                            name: event.target.value,
                            candidates: categories
                              .filter((category) =>
                                category.name
                                  .toLowerCase()
                                  .includes(event.target.value.toLowerCase()),
                              )
                              .map((category) => ({
                                id: category.id,
                                name: category.name,
                                kind: "category",
                                room_id: null,
                                parent_id: null,
                                score: 0,
                              })),
                          }
                        : null,
                    })
                  }
                />
              </Field>
            </div>
      </div>

      <div className="rounded-xl border border-border/60 p-4">
            <p className="text-xs font-medium">Location</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Room" htmlFor={`room-${entry.id}`} error={errors?.room}>
                {showRoomSelect ? (
                  <Select
                    id={`room-${entry.id}`}
                    value={proposed.room?.matched_id ?? ""}
                    disabled={disabled || final}
                    onChange={(event) => setRoom(event.target.value)}
                  >
                    <option value="">No room</option>
                    {roomOptions.map((room) => (
                      <option key={room.id} value={room.id}>
                        {room.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <div className="rounded-lg border border-brass/30 bg-brass-soft/50 px-3 py-2 text-2xs">
                    <p className="font-medium">{proposed.room?.name}</p>
                    <p className="mt-0.5 text-2xs text-muted-foreground">
                      Suggested new room
                    </p>
                  </div>
                )}
              </Field>
              <Field label="Storage place" htmlFor={`location-${entry.id}`} error={errors?.storage_location}>
                {showLocationSelect ? (
                  <Select
                    id={`location-${entry.id}`}
                    value={proposed.storage_location?.matched_id ?? ""}
                    disabled={disabled || final || !proposed.room?.matched_id}
                    onChange={(event) => setLocation(event.target.value)}
                  >
                    <option value="">Room only</option>
                    {roomLocations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {locationPath(locations, location.id)
                          .map((entryLocation) => entryLocation.name)
                          .join(" / ")}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <div className="rounded-lg border border-brass/30 bg-brass-soft/50 px-3 py-2 text-2xs">
                    <p className="font-medium">{proposed.storage_location?.name}</p>
                    <p className="mt-0.5 text-2xs text-muted-foreground">
                      Suggested new storage place
                      {proposed.storage_location?.suggested_parent_id
                        ? " under the selected parent"
                        : ""}
                    </p>
                  </div>
                )}
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {proposed.room?.status === "missing" && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || final || creatingRoom || !proposed.room.name}
                  onClick={createRoom}
                >
                  {creatingRoom ? <Spinner /> : <Plus />}
                  Create room “{proposed.room.name}”
                </Button>
              )}
              {proposed.room?.status === "ambiguous" && proposed.room.candidates.length > 0 && (
                <p className="text-2xs text-brass">
                  Multiple rooms match. Choose the correct one before importing.
                </p>
              )}
              {proposed.room?.matched_id &&
                proposed.storage_location?.status === "missing" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      disabled ||
                      final ||
                      creatingLocation ||
                      !proposed.storage_location.name
                    }
                    onClick={createLocation}
                  >
                    {creatingLocation ? <Spinner /> : <Plus />}
                    Create place “{proposed.storage_location.name}”
                  </Button>
                )}
              {proposed.storage_location?.status === "ambiguous" &&
                proposed.storage_location.candidates.length > 0 && (
                  <p className="text-2xs text-brass">
                    Multiple storage places match. Choose one before importing.
                  </p>
                )}
            </div>
      </div>

      {filled.identity && identityBlock}
      {filled.purchase && purchaseBlock}
      {filled.warranty && warrantyBlock}
      {!(filled.identity && filled.purchase && filled.warranty) && (
        <MoreDetails>
          {!filled.identity && identityBlock}
          {!filled.purchase && purchaseBlock}
          {!filled.warranty && warrantyBlock}
        </MoreDetails>
      )}

      {!highDuplicate && decision.action !== "merge" && duplicates}

          {(entry.source_excerpt || entry.note_title) && (
            <div className="rounded-xl bg-secondary/35 p-4">
              <p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                <FileText className="size-3.5" />
                Source context
                {entry.note_title ? ` · ${entry.note_title}` : ""}
              </p>
              {entry.source_path && (
                <p className="mt-1 break-all text-2xs text-muted-foreground">
                  {entry.source_path}
                </p>
              )}
              {entry.source_excerpt && (
                <p className="mt-2 whitespace-pre-line text-2xs leading-relaxed text-foreground/75">
                  {entry.source_excerpt}
                </p>
              )}
            </div>
          )}

      {onReject && !final && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
          <p className="text-2xs text-muted-foreground">
            Reject marks this row as wrong. It moves to Skipped and can be restored.
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-11 lg:min-h-9"
            disabled={disabled}
            onClick={onReject}
          >
            Reject entry
          </Button>
        </div>
      )}
    </ReviewRow>
  );
}
