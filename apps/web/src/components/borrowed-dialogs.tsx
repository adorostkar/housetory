import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  HandCoins,
  ImageOff,
  Package,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { CameraUpload } from "@/components/camera-upload";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Disclosure } from "@/components/disclosure";
import { Field, FormError } from "@/components/form-field";
import { LendLoanForm } from "@/components/loan-dialogs";
import { LoanItemPicker } from "@/components/loan-item-picker";
import { PersonNameInput } from "@/components/person-name-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, getApiErrorMessage } from "@/lib/api";
import { useCanWrite } from "@/lib/queries";
import type { BorrowedDetail, BorrowedRecord, ItemListEntry, LoanDetail } from "@/lib/types";
import { cn, formatDate, localDateISO } from "@/lib/utils";
import {
  KeepingPlaceFields,
  invalidateBorrowed,
  useKeepingPlace,
  useRequestId,
} from "@/components/borrowed-dialog-shared";

export type NewLoanDirection = "lend" | "borrow";

const NEW_LOAN_DIRECTIONS: Array<{
  value: NewLoanDirection;
  label: string;
  icon: typeof Package;
  note: string;
}> = [
  {
    value: "lend",
    label: "Lend out",
    icon: Package,
    note: "Something the household owns goes to someone. It keeps its home place.",
  },
  {
    value: "borrow",
    label: "Borrow",
    icon: HandCoins,
    note: "Something that belongs to someone else is kept here. It never becomes owned stock.",
  },
];

/**
 * One surface for a new loan in either direction. It starts with the item, the
 * person and the quantity. Everything else is under "More options".
 */
export function NewLoanDialog({
  open,
  onOpenChange,
  initialDirection = "lend",
  onLent,
  onBorrowed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialDirection?: NewLoanDirection;
  onLent?: (loan: LoanDetail) => void;
  onBorrowed?: (record: BorrowedDetail) => void;
}) {
  const [direction, setDirection] = React.useState<NewLoanDirection>(initialDirection);
  const [item, setItem] = React.useState<ItemListEntry | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setDirection(initialDirection);
    setItem(null);
  }, [open, initialDirection]);

  const lendItem = React.useMemo(
    () =>
      item
        ? {
            id: item.id,
            name: item.name,
            available: Math.max(0, item.quantity - (item.on_loan_quantity ?? 0)),
          }
        : null,
    [item],
  );
  const current = NEW_LOAN_DIRECTIONS.find((entry) => entry.value === direction);
  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="size-4 text-brass" />
            New loan
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Loan direction">
            {NEW_LOAN_DIRECTIONS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                aria-pressed={direction === entry.value}
                onClick={() => setDirection(entry.value)}
                className={cn(
                  "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring coarse:min-h-11",
                  direction === entry.value
                    ? entry.value === "borrow"
                      ? "border-brass/30 bg-brass-soft text-brass"
                      : "border-sage/30 bg-sage-soft text-accent-foreground"
                    : "border-border/70 bg-card/50 text-muted-foreground hover:text-foreground",
                )}
              >
                <entry.icon className="size-3.5" aria-hidden="true" />
                {entry.label}
              </button>
            ))}
          </div>
          <DialogDescription className="text-xs">{current?.note}</DialogDescription>
        </div>
        {direction === "lend" ? (
          <LendLoanForm
            open={open}
            item={lendItem}
            itemField={
              <Field label="Item" htmlFor="new-loan-item">
                <LoanItemPicker
                  inputId="new-loan-item"
                  active={open}
                  selected={item}
                  onSelect={setItem}
                  onClear={() => setItem(null)}
                />
              </Field>
            }
            onCancel={close}
            onCreated={onLent}
            onDone={close}
          />
        ) : (
          <BorrowRecordForm open={open} onCancel={close} onCreated={onBorrowed} onDone={close} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BorrowRecordForm({
  open,
  onCancel,
  onCreated,
  onDone,
}: {
  open: boolean;
  onCancel: () => void;
  onCreated?: (record: BorrowedDetail) => void;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const requestId = useRequestId(open);
  const place = useKeepingPlace(open);
  const [itemName, setItemName] = React.useState("");
  const [brand, setBrand] = React.useState("");
  const [model, setModel] = React.useState("");
  const [ownerName, setOwnerName] = React.useState("");
  const [quantity, setQuantity] = React.useState("1");
  const [borrowedOn, setBorrowedOn] = React.useState(localDateISO());
  const [dueOn, setDueOn] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [photo, setPhoto] = React.useState<File | null>(null);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setItemName("");
    setBrand("");
    setModel("");
    setOwnerName("");
    setQuantity("1");
    setBorrowedOn(localDateISO());
    setDueOn("");
    setNotes("");
    setPhoto(null);
    setMoreOpen(false);
    setError(null);
  }, [open]);

  const create = useMutation({
    mutationFn: async () => {
      const created = await api.post<BorrowedDetail>("/borrowed", {
        item_name: itemName.trim(),
        brand: brand.trim() || null,
        model: model.trim() || null,
        owner_name: ownerName.trim(),
        quantity: Number(quantity),
        borrowed_on: borrowedOn,
        due_on: dueOn || null,
        property_id: place.propertyId || null,
        room_id: place.roomId || null,
        storage_location_id: place.locationId || null,
        notes: notes.trim() || null,
        request_id: requestId,
      });
      if (!photo) return created;
      const form = new FormData();
      form.append("file", photo);
      try {
        return await api.postForm<BorrowedDetail>(
          `/borrowed/${created.id}/photo`,
          form,
        );
      } catch (caught) {
        toast.error(
          `Record saved, but the photo was not uploaded: ${getApiErrorMessage(caught)}`,
        );
        return created;
      }
    },
    onSuccess: (record) => {
      invalidateBorrowed(client);
      toast.success(
        `Recorded ${record.quantity} × ${record.item_name} borrowed from ${record.owner_name}`,
      );
      onCreated?.(record);
      onDone();
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const datesInvalid = !borrowedOn || Boolean(dueOn && dueOn < borrowedOn);
  const invalid =
    !itemName.trim() ||
    !ownerName.trim() ||
    !Number.isInteger(Number(quantity)) ||
    Number(quantity) < 1 ||
    datesInvalid;
  const extras = [
    borrowedOn === localDateISO() ? "today" : formatDate(borrowedOn),
    dueOn ? `due ${formatDate(dueOn)}` : "no due date",
    ...(brand.trim() || model.trim() ? ["brand or model added"] : []),
    ...(photo ? ["photo chosen"] : []),
    ...(place.roomId || place.propertyId ? ["place chosen"] : []),
    ...(notes.trim() ? ["notes added"] : []),
  ].join(", ");

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (invalid) return;
        setError(null);
        create.mutate();
      }}
    >
      <Field label="Item name" htmlFor="borrowed-item">
        <Input
          id="borrowed-item"
          value={itemName}
          maxLength={200}
          onChange={(event) => setItemName(event.target.value)}
          placeholder="e.g. Tile cutter"
          autoFocus
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
        <Field label="Owner display name" htmlFor="borrowed-owner">
          <PersonNameInput
            id="borrowed-owner"
            value={ownerName}
            onChange={setOwnerName}
            placeholder="Who owns it"
          />
        </Field>
        <Field label="Quantity" htmlFor="borrowed-quantity">
          <Input
            id="borrowed-quantity"
            type="number"
            inputMode="numeric"
            min={1}
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </Field>
      </div>
      <Disclosure
        label="More options"
        hint={moreOpen ? undefined : extras}
        open={moreOpen || datesInvalid}
        onOpenChange={setMoreOpen}
        contentClassName="space-y-4 pt-2"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Borrowed on" htmlFor="borrowed-on">
            <Input
              id="borrowed-on"
              type="date"
              value={borrowedOn}
              onChange={(event) => setBorrowedOn(event.target.value)}
            />
          </Field>
          <Field
            label="Due back"
            htmlFor="borrowed-due"
            optional
            error={
              dueOn && dueOn < borrowedOn ? "Due back cannot be before Borrowed on." : undefined
            }
          >
            <Input
              id="borrowed-due"
              type="date"
              min={borrowedOn}
              value={dueOn}
              onChange={(event) => setDueOn(event.target.value)}
            />
          </Field>
          <Field label="Brand" htmlFor="borrowed-brand" optional>
            <Input
              id="borrowed-brand"
              value={brand}
              maxLength={120}
              onChange={(event) => setBrand(event.target.value)}
            />
          </Field>
          <Field label="Model" htmlFor="borrowed-model" optional>
            <Input
              id="borrowed-model"
              value={model}
              maxLength={120}
              onChange={(event) => setModel(event.target.value)}
            />
          </Field>
          <Field label="Actual photo" htmlFor="borrowed-photo" optional className="sm:col-span-2">
            <div id="borrowed-photo">
              <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-2xs text-muted-foreground transition-colors hover:bg-secondary/60">
                <ImageOff className="size-4" />
                <span className="min-w-0 flex-1 truncate">
                  {photo ? photo.name : "Choose a photo of the borrowed item"}
                </span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                  className="sr-only"
                  onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
                />
              </label>
            </div>
          </Field>
        </div>
        <KeepingPlaceFields
          propertyId={place.propertyId}
          roomId={place.roomId}
          locationId={place.locationId}
          onPropertyChange={place.setPropertyId}
          onRoomChange={place.setRoomId}
          onLocationChange={place.setLocationId}
        />
        <Field label="Private notes" htmlFor="borrowed-notes" optional>
          <Textarea
            id="borrowed-notes"
            className="min-h-20"
            maxLength={4000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Only visible to household members with access."
          />
        </Field>
      </Disclosure>
      {error && <FormError message={error} />}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={invalid || create.isPending}>
          {create.isPending ? <Spinner /> : <HandCoins />}
          Record borrowed item
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ReturnBorrowedDialog({
  open,
  onOpenChange,
  record,
  onReturned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: BorrowedRecord;
  onReturned?: (record: BorrowedDetail) => void;
}) {
  const client = useQueryClient();
  const requestId = useRequestId(open);
  const [quantity, setQuantity] = React.useState(String(record.outstanding_quantity));
  const [returnedOn, setReturnedOn] = React.useState(localDateISO());
  const [notes, setNotes] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setQuantity(String(record.outstanding_quantity));
    setReturnedOn(localDateISO());
    setNotes("");
    setError(null);
  }, [open, record.id, record.outstanding_quantity]);

  const create = useMutation({
    mutationFn: () =>
      api.post<BorrowedDetail>(`/borrowed/${record.id}/returns`, {
        quantity: Number(quantity),
        returned_on: returnedOn,
        notes: notes.trim() || null,
        request_id: requestId,
      }),
    onSuccess: (updated) => {
      invalidateBorrowed(client);
      toast.success(
        updated.outstanding_quantity === 0
          ? `Returned everything to ${updated.owner_name}`
          : `${updated.outstanding_quantity} unit(s) still held from ${updated.owner_name}`,
      );
      onReturned?.(updated);
      onOpenChange(false);
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const invalid =
    !Number.isInteger(Number(quantity)) ||
    Number(quantity) < 1 ||
    Number(quantity) > record.outstanding_quantity ||
    !returnedOn;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Return to {record.owner_name}</DialogTitle>
          <DialogDescription>
            {record.outstanding_quantity} unit(s) are still held. Partial returns are
            recorded separately and remain in the history.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            create.mutate();
          }}
        >
          <div className="rounded-xl border border-brass/20 bg-brass-soft/35 px-3.5 py-2.5 text-2xs leading-relaxed text-muted-foreground">
            <strong className="font-medium text-foreground">{record.item_name}</strong>{" "}
            belongs to {record.owner_name}. This return changes borrowed quantities only;
            owned inventory is unaffected.
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Quantity" htmlFor="borrowed-return-quantity">
              <Input
                id="borrowed-return-quantity"
                type="number"
                min={1}
                max={record.outstanding_quantity}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                autoFocus
              />
            </Field>
            <Field label="Returned on" htmlFor="borrowed-return-date">
              <Input
                id="borrowed-return-date"
                type="date"
                min={record.borrowed_on}
                value={returnedOn}
                onChange={(event) => setReturnedOn(event.target.value)}
              />
            </Field>
          </div>
          <Field label="Private notes" htmlFor="borrowed-return-notes" optional>
            <Textarea
              id="borrowed-return-notes"
              className="min-h-20"
              maxLength={4000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="e.g. returned with the case"
            />
          </Field>
          {error && <FormError message={error} />}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={invalid || create.isPending}>
              {create.isPending ? <Spinner /> : <RotateCcw />}
              Return to owner
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CorrectBorrowedDialog({
  open,
  onOpenChange,
  record,
  onCorrected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: BorrowedRecord;
  onCorrected?: (record: BorrowedDetail) => void;
}) {
  const client = useQueryClient();
  const requestId = useRequestId(open);
  const place = useKeepingPlace(open, record);
  const [itemName, setItemName] = React.useState(record.item_name);
  const [brand, setBrand] = React.useState(record.brand ?? "");
  const [model, setModel] = React.useState(record.model ?? "");
  const [ownerName, setOwnerName] = React.useState(record.owner_name);
  const [quantity, setQuantity] = React.useState(String(record.quantity));
  const [borrowedOn, setBorrowedOn] = React.useState(record.borrowed_on);
  const [dueOn, setDueOn] = React.useState(record.due_on ?? "");
  const [notes, setNotes] = React.useState(record.notes ?? "");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setItemName(record.item_name);
    setBrand(record.brand ?? "");
    setModel(record.model ?? "");
    setOwnerName(record.owner_name);
    setQuantity(String(record.quantity));
    setBorrowedOn(record.borrowed_on);
    setDueOn(record.due_on ?? "");
    setNotes(record.notes ?? "");
    setError(null);
  }, [
    open,
    record.id,
    record.item_name,
    record.brand,
    record.model,
    record.owner_name,
    record.quantity,
    record.borrowed_on,
    record.due_on,
    record.notes,
  ]);

  const correct = useMutation({
    mutationFn: () =>
      api.patch<BorrowedDetail>(`/borrowed/${record.id}`, {
        item_name: itemName.trim(),
        brand: brand.trim() || null,
        model: model.trim() || null,
        owner_name: ownerName.trim(),
        quantity: Number(quantity),
        borrowed_on: borrowedOn,
        due_on: dueOn || null,
        property_id: place.propertyId || null,
        room_id: place.roomId || null,
        storage_location_id: place.locationId || null,
        notes: notes.trim() || null,
        request_id: requestId,
      }),
    onSuccess: (updated) => {
      invalidateBorrowed(client);
      toast.success("Borrowed record corrected and added to history");
      onCorrected?.(updated);
      onOpenChange(false);
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const invalid =
    !itemName.trim() ||
    !ownerName.trim() ||
    !Number.isInteger(Number(quantity)) ||
    Number(quantity) < Math.max(1, record.returned_quantity) ||
    !borrowedOn ||
    Boolean(dueOn && dueOn < borrowedOn);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Correct borrowed record</DialogTitle>
          <DialogDescription>
            Corrections create a new history event. Reducing the quantity cannot go below
            what has already been returned to the owner.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            correct.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Item name" htmlFor="borrowed-correct-item">
              <Input
                id="borrowed-correct-item"
                value={itemName}
                maxLength={200}
                onChange={(event) => setItemName(event.target.value)}
              />
            </Field>
            <Field label="Owner display name" htmlFor="borrowed-correct-owner">
              <PersonNameInput
                id="borrowed-correct-owner"
                value={ownerName}
                onChange={setOwnerName}
              />
            </Field>
            <Field label="Brand" htmlFor="borrowed-correct-brand" optional>
              <Input
                id="borrowed-correct-brand"
                value={brand}
                maxLength={120}
                onChange={(event) => setBrand(event.target.value)}
              />
            </Field>
            <Field label="Model" htmlFor="borrowed-correct-model" optional>
              <Input
                id="borrowed-correct-model"
                value={model}
                maxLength={120}
                onChange={(event) => setModel(event.target.value)}
              />
            </Field>
            <Field label="Borrowed quantity" htmlFor="borrowed-correct-quantity">
              <Input
                id="borrowed-correct-quantity"
                type="number"
                min={Math.max(1, record.returned_quantity)}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </Field>
            <Field label="Borrowed on" htmlFor="borrowed-correct-on">
              <Input
                id="borrowed-correct-on"
                type="date"
                value={borrowedOn}
                onChange={(event) => setBorrowedOn(event.target.value)}
              />
            </Field>
            <Field label="Due back" htmlFor="borrowed-correct-due" optional>
              <Input
                id="borrowed-correct-due"
                type="date"
                min={borrowedOn}
                value={dueOn}
                onChange={(event) => setDueOn(event.target.value)}
              />
            </Field>
          </div>
          <KeepingPlaceFields
            propertyId={place.propertyId}
            roomId={place.roomId}
            locationId={place.locationId}
            onPropertyChange={place.setPropertyId}
            onRoomChange={place.setRoomId}
            onLocationChange={place.setLocationId}
          />
          <Field label="Private notes" htmlFor="borrowed-correct-notes" optional>
            <Textarea
              id="borrowed-correct-notes"
              className="min-h-20"
              maxLength={4000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
          <p className="rounded-xl border border-brass/20 bg-brass-soft/35 px-3.5 py-2.5 text-2xs leading-relaxed text-muted-foreground">
            {record.returned_quantity > 0
              ? `${record.returned_quantity} unit(s) have already been returned to ${record.owner_name}.`
              : "No returns have been recorded for this borrowed item."}
          </p>
          {error && <FormError message={error} />}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={invalid || correct.isPending}>
              {correct.isPending ? <Spinner /> : <Save />}
              Save correction
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BorrowedPhotoPanel({ record }: { record: BorrowedRecord }) {
  const client = useQueryClient();
  const canWrite = useCanWrite();
  const [removeOpen, setRemoveOpen] = React.useState(false);

  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api.postForm<BorrowedDetail>(`/borrowed/${record.id}/photo`, form);
    },
    onSuccess: () => {
      invalidateBorrowed(client);
      toast.success("Borrowed-item photo saved privately");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: () => api.delete<BorrowedDetail>(`/borrowed/${record.id}/photo`),
    onSuccess: () => {
      invalidateBorrowed(client);
      toast.success("Borrowed-item photo removed");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  return (
    <section className="surface p-5 sm:p-6" aria-label="Borrowed-item photo">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-[1.3rem] tracking-[-0.02em]">
            Actual photo
          </h2>
          <p className="mt-1 max-w-xl text-2xs leading-relaxed text-muted-foreground">
            Private to this borrowed record. It is not ownership evidence and is not
            included in item evidence exports.
          </p>
        </div>
        {record.photo && canWrite && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setRemoveOpen(true)}
            disabled={remove.isPending}
          >
            {remove.isPending ? <Spinner /> : <Trash2 />}
            Remove photo
          </Button>
        )}
      </div>
      {record.photo ? (
        <div className="mt-4 flex flex-wrap items-start gap-4">
          <img
            src={record.photo.thumbnail_url}
            alt={`${record.item_name} borrowed from ${record.owner_name}`}
            className="h-44 w-full max-w-sm rounded-2xl border border-border/70 object-cover"
          />
          <div className="space-y-2">
            <Badge variant="brass">Borrowed photo</Badge>
            <p className="max-w-xs break-all text-2xs text-muted-foreground">
              {record.photo.original_filename} · {Math.max(1, Math.round(record.photo.byte_size / 1024))} KB
            </p>
            {canWrite && (
              <CameraUpload
                label="Replace borrowed-item photo"
                busy={upload.isPending}
                onUpload={async (file) => {
                  await upload.mutateAsync(file);
                }}
              />
            )}
          </div>
        </div>
      ) : canWrite ? (
        <div className="mt-4 flex flex-col items-start gap-3 rounded-2xl border border-dashed border-border/70 px-4 py-5 sm:flex-row sm:items-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary text-muted-foreground">
            <ImageOff className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">No actual photo yet</p>
            <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
              A photo can help identify the item, but it stays attached to this borrowed
              record only.
            </p>
          </div>
          <CameraUpload
            label="Add borrowed-item photo"
            busy={upload.isPending}
            onUpload={async (file) => {
              await upload.mutateAsync(file);
            }}
          />
        </div>
      ) : (
        <p className="mt-4 rounded-xl border border-border/60 bg-background/35 px-3.5 py-3 text-2xs text-muted-foreground">
          No borrowed-item photo is recorded. Viewers can read the record but cannot add
          photos.
        </p>
      )}
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove this borrowed-item photo?"
        description="The private photo file will be deleted. The borrowed record and its return history remain intact."
        confirmLabel="Remove photo"
        onConfirm={async () => {
          await remove.mutateAsync();
        }}
      />
    </section>
  );
}

export function CancelBorrowedDialog({
  open,
  onOpenChange,
  record,
  onCancelled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: BorrowedRecord;
  onCancelled?: (record: BorrowedDetail) => void;
}) {
  const client = useQueryClient();
  const requestId = useRequestId(open);
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const cancel = useMutation({
    mutationFn: () =>
      api.post<BorrowedDetail>(`/borrowed/${record.id}/cancel`, {
        reason: reason.trim() || null,
        request_id: requestId,
      }),
    onSuccess: (updated) => {
      invalidateBorrowed(client);
      toast.success("Borrowed record cancelled");
      onCancelled?.(updated);
      onOpenChange(false);
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel borrowed record?</DialogTitle>
          <DialogDescription>
            This keeps the record and its history but removes it from outstanding
            quantities. Records with any return history cannot be cancelled.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            cancel.mutate();
          }}
        >
          <Field label="Reason for cancellation" htmlFor="borrowed-cancel-reason" optional>
            <Textarea
              id="borrowed-cancel-reason"
              className="min-h-20"
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. recorded against the wrong owner"
            />
          </Field>
          <p className="rounded-xl border border-brass/20 bg-brass-soft/35 px-3.5 py-2.5 text-2xs leading-relaxed text-muted-foreground">
            {record.item_name} from {record.owner_name} has {record.returned_quantity}{" "}
            returned unit(s).
          </p>
          {error && <FormError message={error} />}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Keep record
            </Button>
            <Button type="submit" variant="destructive" disabled={cancel.isPending}>
              {cancel.isPending ? <Spinner /> : <Trash2 />}
              Cancel record
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
