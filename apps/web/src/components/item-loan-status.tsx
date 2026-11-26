import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Loan } from "@/lib/types";
import { formatDate } from "@/lib/utils";

function unitLabel(count: number) {
  return count === 1 ? "unit" : "units";
}

function loanDates(loan: Loan) {
  return `Lent ${formatDate(loan.lent_on)} · ${
    loan.due_on ? `due ${formatDate(loan.due_on)}` : "no return date"
  }`;
}

/**
 * Who has the item right now, with a Return button for each open loan. It
 * renders nothing when no unit is on loan. Private loan notes are not shown.
 */
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
  const singleLoan = activeLoans.length === 1 ? activeLoans[0] : undefined;
  const singleBorrower = borrowers.length === 1;
  const heading =
    fullyLoaned && singleBorrower
      ? `With ${borrowers[0]}`
      : singleBorrower
        ? `${onLoanQuantity} of ${ownedQuantity} with ${borrowers[0]}`
        : fullyLoaned
          ? `All ${onLoanQuantity} ${unitLabel(onLoanQuantity)} on loan`
          : `${onLoanQuantity} of ${ownedQuantity} on loan`;

  return (
    <div className="min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium leading-snug">
            <span className="min-w-0 [overflow-wrap:anywhere]">{heading}</span>
            {singleLoan?.overdue && <Badge variant="brass">Past due</Badge>}
          </p>
          <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
            {singleLoan ? loanDates(singleLoan) : `${activeLoans.length} open loans`}
            {ownedQuantity > 1 &&
              ` · owned ${ownedQuantity} · here ${atHomeQuantity} · on loan ${onLoanQuantity}`}
          </p>
        </div>
        {canWrite && singleLoan && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-11 shrink-0"
            onClick={() => onReturnLoan(singleLoan)}
          >
            Return
          </Button>
        )}
      </div>

      {!singleLoan && (
        <ul className="mt-2 space-y-1.5">
          {activeLoans.slice(0, 4).map((loan) => (
            <li
              key={loan.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/35 py-1 pl-2.5 pr-1 text-2xs"
            >
              <span className="min-w-0">
                <Link
                  to={`/loans/${loan.id}`}
                  className="font-medium text-foreground/85 underline-offset-4 hover:underline"
                >
                  {loan.borrower_name} · {loan.outstanding_quantity} of {loan.quantity}
                </Link>
                <span className="block text-muted-foreground">
                  {loanDates(loan)}
                  {loan.overdue && " · past due"}
                </span>
              </span>
              {canWrite && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-11 shrink-0"
                  onClick={() => onReturnLoan(loan)}
                  aria-label={`Return from ${loan.borrower_name}`}
                >
                  Return
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {activeLoans.length > 4 && (
        <Link
          to={`/loans?item_id=${activeLoans[0]?.item_id ?? ""}`}
          className="mt-2 inline-flex min-h-11 items-center text-2xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          All {activeLoans.length} open loans
        </Link>
      )}
    </div>
  );
}
