import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HandCoins, RotateCcw, Save } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
import { PersonNameInput } from "@/components/person-name-input";
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
import { queryKeys, useItemLoanOptions } from "@/lib/queries";
import type { Loan, LoanDetail } from "@/lib/types";
import { localDateISO } from "@/lib/utils";

function useRequestId(open: boolean) {
  const [requestId, setRequestId] = React.useState(() => crypto.randomUUID());
  React.useEffect(() => {
    if (open) setRequestId(crypto.randomUUID());
  }, [open]);
  return requestId;
}

function invalidateLoans(client: ReturnType<typeof useQueryClient>, itemId?: string | null) {
  void client.invalidateQueries({ queryKey: ["loans"] });
  void client.invalidateQueries({ queryKey: ["items"] });
  void client.invalidateQueries({ queryKey: ["item"] });
  if (itemId) {
    void client.invalidateQueries({ queryKey: queryKeys.itemLoans(itemId) });
    void client.invalidateQueries({ queryKey: ["items", itemId, "loan-options"] });
  }
  void client.invalidateQueries({ queryKey: queryKeys.overview });
}

export function LendLoanDialog({
  open,
  onOpenChange,
  itemId,
  itemName,
  available,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemId: string;
  itemName: string;
  available: number;
  onCreated?: (loan: LoanDetail) => void;
}) {
  const client = useQueryClient();
  const requestId = useRequestId(open);
  const [borrower, setBorrower] = React.useState("");
  const [quantity, setQuantity] = React.useState(String(Math.min(1, available)));
  const [lentOn, setLentOn] = React.useState(localDateISO());
  const [dueOn, setDueOn] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [includeContents, setIncludeContents] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const optionsQuery = useItemLoanOptions(itemId, open);

  React.useEffect(() => {
    if (!open) return;
    setBorrower("");
    setQuantity(String(Math.min(1, Math.max(0, available))));
    setLentOn(localDateISO());
    setDueOn("");
    setNotes("");
    setIncludeContents(false);
    setError(null);
  }, [open, available]);

  const create = useMutation({
    mutationFn: () =>
      api.post<LoanDetail>("/loans", {
        item_id: itemId,
        borrower_name: borrower.trim(),
        quantity: includeContents ? 1 : Number(quantity),
        lent_on: lentOn,
        due_on: dueOn || null,
        notes: notes.trim() || null,
        include_contents: includeContents,
        request_id: requestId,
      }),
    onSuccess: (loan) => {
      invalidateLoans(client, itemId);
      toast.success(
        loan.includes_contents && (loan.contents_loans?.length ?? 0) > 0
          ? `Lent ${itemName} with ${loan.contents_loans?.length} content item(s) to ${loan.borrower_name}`
          : `Lent ${loan.quantity} × ${itemName} to ${loan.borrower_name}`,
      );
      onCreated?.(loan);
      onOpenChange(false);
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const invalid =
    !borrower.trim() ||
    !Number.isInteger(Number(quantity)) ||
    Number(quantity) < 1 ||
    Number(quantity) > available ||
    (includeContents && !optionsQuery.data?.contents_items.length) ||
    !lentOn ||
    Boolean(dueOn && dueOn < lentOn);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HandCoins className="size-4 text-brass" />
            Lend {itemName}
          </DialogTitle>
          <DialogDescription>
            Record a borrower display name and dates. No borrower account, email or contact
            details are created. The item keeps its normal home location.
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
          <div className="rounded-xl border border-border/60 bg-secondary/20 px-3.5 py-2.5 text-[0.74rem] text-muted-foreground">
            <strong className="font-medium text-foreground">{available}</strong> unit(s)
            available at home. Owned quantity includes loaned stock.
          </div>
          {optionsQuery.data?.has_contents && (
            <div className="rounded-xl border border-border/60 bg-background/40 p-3.5">
              <label className="flex items-start gap-2.5 text-[0.78rem]">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 rounded border-border"
                  checked={includeContents}
                  disabled={optionsQuery.data.contents_items.length === 0}
                  onChange={(event) => {
                    setIncludeContents(event.target.checked);
                    if (event.target.checked) setQuantity("1");
                  }}
                />
                <span>
                  Include the contents in this loan
                  <span className="mt-0.5 block text-[0.68rem] leading-relaxed text-muted-foreground">
                    {includeContents
                      ? "Each available child item is loaned separately with the same borrower and dates. Returning the parent does not mark children returned."
                      : "Off by default. The parent can be lent alone; its contents stay recorded at home and are not implied to be with the borrower."}
                  </span>
                </span>
              </label>
              {includeContents && (
                <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
                  <p className="text-[0.7rem] text-muted-foreground">
                    {optionsQuery.data.contents_items.length} item(s) ·{" "}
                    {optionsQuery.data.contents_available_quantity} available unit(s)
                    will be included:
                  </p>
                  <ul className="max-h-32 space-y-1 overflow-y-auto text-[0.7rem]">
                    {optionsQuery.data.contents_items.map((entry) => (
                      <li
                        key={entry.item_id}
                        className="flex items-center justify-between gap-2 rounded-lg bg-secondary/30 px-2.5 py-1.5"
                      >
                        <span className="truncate">{entry.item_name}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {entry.available_quantity} unit(s)
                        </span>
                      </li>
                    ))}
                  </ul>
                  {optionsQuery.data.excluded_items.length > 0 && (
                    <div className="text-[0.66rem] leading-relaxed text-muted-foreground">
                      <p className="font-medium">Not included:</p>
                      <ul className="mt-1 space-y-0.5">
                        {optionsQuery.data.excluded_items.map((entry) => (
                          <li key={`${entry.item_name}-${entry.reason}`}>
                            {entry.item_name} — {entry.reason}
                            {entry.owner_name ? ` (${entry.owner_name})` : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {optionsQuery.isPending && open && (
            <p className="text-[0.68rem] text-muted-foreground">
              Checking whether this item holds contents…
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Borrower" htmlFor="loan-borrower">
              <PersonNameInput
                id="loan-borrower"
                value={borrower}
                onChange={setBorrower}
                placeholder="Name to show on the loan"
                autoFocus
              />
            </Field>
            <Field label="Quantity" htmlFor="loan-quantity">
              <Input
                id="loan-quantity"
                type="number"
                min={1}
                max={available}
                value={includeContents ? "1" : quantity}
                disabled={includeContents}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </Field>
            <Field label="Lent on" htmlFor="loan-lent">
              <Input
                id="loan-lent"
                type="date"
                value={lentOn}
                onChange={(event) => setLentOn(event.target.value)}
              />
            </Field>
            <Field label="Due back" htmlFor="loan-due" optional>
              <Input
                id="loan-due"
                type="date"
                value={dueOn}
                min={lentOn}
                onChange={(event) => setDueOn(event.target.value)}
              />
            </Field>
          </div>
          <Field label="Private notes" htmlFor="loan-notes" optional>
            <Textarea
              id="loan-notes"
              className="min-h-20"
              maxLength={4000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Only visible to household members with access."
            />
          </Field>
          {error && <FormError message={error} />}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={invalid || create.isPending}>
              {create.isPending ? <Spinner /> : <HandCoins />}
              Record loan
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ReturnLoanDialog({
  open,
  onOpenChange,
  loan,
  onReturned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loan: Loan;
  onReturned?: (loan: LoanDetail) => void;
}) {
  const client = useQueryClient();
  const requestId = useRequestId(open);
  const [quantity, setQuantity] = React.useState(String(loan.outstanding_quantity));
  const [returnedOn, setReturnedOn] = React.useState(localDateISO());
  const [notes, setNotes] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setQuantity(String(loan.outstanding_quantity));
    setReturnedOn(localDateISO());
    setNotes("");
    setError(null);
  }, [open, loan.id, loan.outstanding_quantity]);

  const create = useMutation({
    mutationFn: () =>
      api.post<LoanDetail>(`/loans/${loan.id}/returns`, {
        quantity: Number(quantity),
        returned_on: returnedOn,
        notes: notes.trim() || null,
        request_id: requestId,
      }),
    onSuccess: (updated) => {
      invalidateLoans(client, updated.item_id);
      toast.success(
        updated.outstanding_quantity === 0
          ? "Loan fully returned"
          : `${updated.outstanding_quantity} unit(s) still outstanding`,
      );
      onReturned?.(updated);
      onOpenChange(false);
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const invalid =
    !Number.isInteger(Number(quantity)) ||
    Number(quantity) < 1 ||
    Number(quantity) > loan.outstanding_quantity ||
    !returnedOn;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Return from {loan.borrower_name}</DialogTitle>
          <DialogDescription>
            {loan.outstanding_quantity} unit(s) outstanding. Partial returns are recorded
            separately and can be undone from the loan history.
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
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Quantity" htmlFor="return-quantity">
              <Input
                id="return-quantity"
                type="number"
                min={1}
                max={loan.outstanding_quantity}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                autoFocus
              />
            </Field>
            <Field label="Returned on" htmlFor="return-date">
              <Input
                id="return-date"
                type="date"
                min={loan.lent_on}
                value={returnedOn}
                onChange={(event) => setReturnedOn(event.target.value)}
              />
            </Field>
          </div>
          <Field label="Private notes" htmlFor="return-notes" optional>
            <Textarea
              id="return-notes"
              className="min-h-20"
              maxLength={4000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="e.g. one cable returned without the pouch"
            />
          </Field>
          {error && <FormError message={error} />}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={invalid || create.isPending}>
              {create.isPending ? <Spinner /> : <RotateCcw />}
              Record return
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CorrectLoanDialog({
  open,
  onOpenChange,
  loan,
  onCorrected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loan: Loan;
  onCorrected?: (loan: LoanDetail) => void;
}) {
  const client = useQueryClient();
  const requestId = useRequestId(open);
  const [borrower, setBorrower] = React.useState(loan.borrower_name);
  const [quantity, setQuantity] = React.useState(String(loan.quantity));
  const [lentOn, setLentOn] = React.useState(loan.lent_on);
  const [dueOn, setDueOn] = React.useState(loan.due_on ?? "");
  const [notes, setNotes] = React.useState(loan.notes ?? "");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setBorrower(loan.borrower_name);
    setQuantity(String(loan.quantity));
    setLentOn(loan.lent_on);
    setDueOn(loan.due_on ?? "");
    setNotes(loan.notes ?? "");
    setError(null);
  }, [open, loan.id, loan.borrower_name, loan.quantity, loan.lent_on, loan.due_on, loan.notes]);

  const correct = useMutation({
    mutationFn: () =>
      api.patch<LoanDetail>(`/loans/${loan.id}`, {
        borrower_name: borrower.trim(),
        quantity: Number(quantity),
        lent_on: lentOn,
        due_on: dueOn || null,
        notes: notes.trim() || null,
        request_id: requestId,
      }),
    onSuccess: (updated) => {
      invalidateLoans(client, updated.item_id);
      toast.success("Loan corrected and recorded in history");
      onCorrected?.(updated);
      onOpenChange(false);
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const invalid =
    !borrower.trim() ||
    !Number.isInteger(Number(quantity)) ||
    Number(quantity) < 1 ||
    !lentOn ||
    Boolean(dueOn && dueOn < lentOn);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Correct loan</DialogTitle>
          <DialogDescription>
            Corrections create a new history event. Increasing the quantity needs available
            stock; reducing it cannot go below what has already been returned.
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
            <Field label="Borrower" htmlFor="correct-borrower">
              <PersonNameInput
                id="correct-borrower"
                value={borrower}
                onChange={setBorrower}
              />
            </Field>
            <Field label="Loan quantity" htmlFor="correct-quantity">
              <Input
                id="correct-quantity"
                type="number"
                min={Math.max(1, loan.returned_quantity)}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </Field>
            <Field label="Lent on" htmlFor="correct-lent">
              <Input
                id="correct-lent"
                type="date"
                value={lentOn}
                onChange={(event) => setLentOn(event.target.value)}
              />
            </Field>
            <Field label="Due back" htmlFor="correct-due" optional>
              <Input
                id="correct-due"
                type="date"
                min={lentOn}
                value={dueOn}
                onChange={(event) => setDueOn(event.target.value)}
              />
            </Field>
          </div>
          <Field label="Private notes" htmlFor="correct-notes" optional>
            <Textarea
              id="correct-notes"
              className="min-h-20"
              maxLength={4000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
          <p className="rounded-xl border border-brass/20 bg-brass-soft/35 px-3.5 py-2.5 text-[0.72rem] leading-relaxed text-muted-foreground">
            {loan.returned_quantity > 0
              ? `${loan.returned_quantity} unit(s) have already been returned.`
              : "No returns have been recorded for this loan."}
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
