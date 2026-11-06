import { ArrowUpRight, HandCoins } from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { useBorrowedList } from "@/lib/queries";
import { formatDate } from "@/lib/utils";

export function BorrowedKeptHere({
  roomId,
  locationId,
}: {
  roomId?: string;
  locationId?: string;
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
    <section className="surface mt-4 border-brass/20 p-4 sm:p-5" aria-label="Borrowed items kept here">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 font-display text-[1.25rem] tracking-[-0.02em]">
            <HandCoins className="size-4 text-brass" />
            Borrowed items kept here
          </h2>
          <p className="mt-1 text-[0.72rem] leading-relaxed text-muted-foreground">
            These goods belong to other people. They are not included in owned item counts,
            values, stocktake or evidence.
          </p>
        </div>
        <Badge variant="brass">Not owned stock</Badge>
      </div>
      <ul className="mt-3 divide-y divide-border/60">
        {records.map((record) => (
          <li key={record.id}>
            <Link
              to={`/borrowed/${record.id}`}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-[0.76rem] transition-colors hover:text-foreground"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{record.item_name}</span>
                <span className="block truncate text-[0.68rem] text-muted-foreground">
                  belongs to {record.owner_name} · {record.outstanding_quantity} held
                  {record.due_on ? ` · due ${formatDate(record.due_on)}` : ""}
                </span>
              </span>
              <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
