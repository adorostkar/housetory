import { ArrowUpRight, HandCoins } from "lucide-react";
import { Link } from "react-router-dom";

import { Disclosure } from "@/components/disclosure";
import { Badge } from "@/components/ui/badge";
import { useBorrowedList } from "@/lib/queries";
import { formatDate } from "@/lib/utils";

export function BorrowedKeptHere({
  roomId,
  locationId,
  className,
}: {
  roomId?: string;
  locationId?: string;
  className?: string;
}) {
  const query = useBorrowedList(
    {
      status: "open",
      room_id: roomId,
      storage_location_id: locationId,
    },
    12,
    Boolean(roomId || locationId),
  );
  const records = query.data?.items ?? [];
  if (query.isPending || query.isError || records.length === 0) return null;
  return (
    <section className={className} aria-label="Borrowed items kept here">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <HandCoins className="size-4 text-brass" aria-hidden="true" />
          Borrowed items kept here
        </h2>
        <Badge variant="brass">Not owned stock</Badge>
      </div>
      <ul className="mt-1 divide-y divide-border/60">
        {records.map((record) => (
          <li key={record.id}>
            <Link
              to={`/borrowed/${record.id}`}
              className="flex min-h-11 items-center justify-between gap-2 py-1.5 text-xs transition-colors hover:text-foreground"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{record.item_name}</span>
                <span className="block truncate text-2xs text-muted-foreground">
                  belongs to {record.owner_name} · {record.outstanding_quantity} held
                  {record.due_on ? ` · due ${formatDate(record.due_on)}` : ""}
                </span>
              </span>
              <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
      <Disclosure label="About borrowed items" buttonClassName="text-2xs font-normal">
        <p className="pb-1 text-2xs leading-relaxed text-muted-foreground">
          These goods belong to other people. They are not included in owned item counts,
          values, stocktake or evidence.
        </p>
      </Disclosure>
    </section>
  );
}
