import { useMutation } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
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
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, getApiErrorMessage } from "@/lib/api";
import { ITEM_DISPOSITION_LABELS } from "@/lib/labels";
import { useInvalidateInventory } from "@/lib/queries";
import type {
  ItemDetail,
  ItemDetailResponse,
  ItemDisposition,
} from "@/lib/types";

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function ItemDispositionDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ItemDetail;
}) {
  const invalidate = useInvalidateInventory();
  const [disposition, setDisposition] = React.useState<ItemDisposition | "">("");
  const [disposedOn, setDisposedOn] = React.useState(today());
  const [note, setNote] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setDisposition("");
    setDisposedOn(today());
    setNote("");
  }, [open, item.id]);

  const save = useMutation({
    mutationFn: () =>
      api.patch<ItemDetailResponse>(`/items/${item.id}`, {
        is_archived: true,
        disposition,
        disposed_on: disposedOn || null,
        disposition_note: note.trim() || null,
      }),
    onSuccess: () => {
      invalidate();
      toast.success("Item marked as no longer owned");
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark {item.name} as no longer owned</DialogTitle>
          <DialogDescription>
            Keep its photos, documents and history, but remove it from active inventory,
            stocktake and current totals. You can restore it later.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!disposition || !disposedOn) return;
            save.mutate();
          }}
        >
          {save.error && <FormError message={getApiErrorMessage(save.error)} />}
          <Field label="What happened?" htmlFor="item-disposition">
            <Select
              id="item-disposition"
              value={disposition}
              required
              disabled={save.isPending}
              onChange={(event) =>
                setDisposition(event.target.value as ItemDisposition | "")
              }
            >
              <option value="" disabled>
                Choose an outcome
              </option>
              {Object.entries(ITEM_DISPOSITION_LABELS)
                .filter(([value]) => value !== "other")
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              <option value="other">Other / no longer owned</option>
            </Select>
          </Field>
          <Field label="Date" htmlFor="item-disposed-on">
            <Input
              id="item-disposed-on"
              type="date"
              required
              max={today()}
              value={disposedOn}
              disabled={save.isPending}
              onChange={(event) => setDisposedOn(event.target.value)}
            />
          </Field>
          <Field label="Note" htmlFor="item-disposition-note" optional>
            <Textarea
              id="item-disposition-note"
              maxLength={2000}
              value={note}
              disabled={save.isPending}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Who received it, where it went, or anything worth remembering."
            />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || !disposition || !disposedOn}>
              {save.isPending && <Spinner />}
              Mark as no longer owned
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
