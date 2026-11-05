import { HandCoins, RotateCcw } from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Loan } from "@/lib/types";
import { formatDate } from "@/lib/utils";

function unitLabel(count: number) {
  return count === 1 ? "unit" : "units";
}

export function ItemLoanStatus({
  ownedQuantity,
  atHomeQuantity,
  loans,
  canWrite,
  onReturnLoan,
}: {
  ownedQuantity: number;
  atHomeQuantity: number;
  loans: Loan[];
  canWrite: boolean;
  onReturnLoan: (loan: Loan) => void;
}) {
  const activeLoans = loans.filter(
    (loan) =>
      loan.outstanding_quantity > 0 &&
      (loan.status === "outstanding" || loan.status === "partially_returned"),
  );
  const onLoanQuantity = activeLoans.reduce(
    (total, loan) => total + loan.outstanding_quantity,
    0,
  );
  if (onLoanQuantity <= 0) return null;

  const borrowers = [...new Set(activeLoans.map((loan) => loan.borrower_name))];
  const fullyLoaned = atHomeQuantity <= 0;
  const singleLoan = activeLoans.length === 1;
  const singleBorrower = borrowers.length === 1;
  const overdue = activeLoans.some((loan) => loan.overdue);
  const heading =
    fullyLoaned && singleBorrower
      ? `On loan to ${borrowers[0]}`
      : fullyLoaned
        ? `All ${onLoanQuantity} ${unitLabel(onLoanQuantity)} are on loan`
        : singleBorrower
          ? `${onLoanQuantity} of ${ownedQuantity} ${unitLabel(ownedQuantity)} on loan to ${borrowers[0]}`
          : `${onLoanQuantity} of ${ownedQuantity} ${unitLabel(ownedQuantity)} on loan`;
  const singleDue = singleLoan
    ? activeLoans[0]?.due_on
      ? `Due ${formatDate(activeLoans[0].due_on)}`
      : "No return date set"
    : null;

  return (
    <div className="mt-4 max-w-2xl rounded-2xl border border-brass/30 bg-brass-soft/35 px-4 py-3.5 text-left">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <HandCoins className="size-4 shrink-0 text-brass" aria-hidden="true" />
            <p className="text-[0.86rem] font-medium leading-snug text-foreground">
              {heading}
            </p>
            {overdue && <Badge variant="brass">Past due</Badge>}
          </div>
          <p className="mt-1 text-[0.72rem] leading-relaxed text-muted-foreground">
            Owned {ownedQuantity} · at home {atHomeQuantity} · on loan{" "}
            {onLoanQuantity}
            {singleDue ? ` · ${singleDue}` : ""}
          </p>

          {!singleLoan && (
            <ul className="mt-2 space-y-1.5">
              {activeLoans.slice(0, 4).map((loan) => (
                <li
                  key={loan.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/35 px-2.5 py-1.5 text-[0.72rem]"
                >
                  <Link
                    to={`/loans/${loan.id}`}
                    className="min-w-0 font-medium text-foreground/85 underline-offset-4 hover:underline"
                  >
                    {loan.borrower_name} · {loan.outstanding_quantity} of{" "}
                    {loan.quantity} on loan
                  </Link>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    {loan.due_on
                      ? `Due ${formatDate(loan.due_on)}`
                      : "No due date recorded"}
                    {loan.overdue && <Badge variant="brass">Past due</Badge>}
                    {canWrite && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[0.68rem]"
                        onClick={() => onReturnLoan(loan)}
                        aria-label={`Record return from ${loan.borrower_name}`}
                      >
                        <RotateCcw className="size-3" />
                        Return
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {activeLoans.length > 4 && (
            <Link
              to={`/loans?item_id=${activeLoans[0]?.item_id ?? ""}`}
              className="mt-2 inline-block text-[0.68rem] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              All {activeLoans.length} open loans
            </Link>
          )}

          <p className="mt-1.5 text-[0.68rem] leading-relaxed text-muted-foreground">
            {fullyLoaned
              ? "The recorded room and container are its usual home, not a current physical location while loaned out."
              : `The recorded room and container are where the ${atHomeQuantity} at-home ${unitLabel(atHomeQuantity)} normally live.`}
          </p>
        </div>

        {canWrite && singleLoan && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0 self-start"
            onClick={() => onReturnLoan(activeLoans[0]!)}
          >
            <RotateCcw />
            Record return
          </Button>
        )}
      </div>
    </div>
  );
}
