import * as React from "react";

import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLoanPeople } from "@/lib/queries";
import type { LoanPerson } from "@/lib/types";
import { cn } from "@/lib/utils";

function suggestionMeta(person: LoanPerson): string {
  const parts: string[] = [];
  if (person.lent_open > 0) parts.push(`${person.lent_open} lent out`);
  if (person.borrowed_open > 0) parts.push(`${person.borrowed_open} borrowed`);
  if (parts.length === 0) {
    const total = person.lent_total + person.borrowed_total;
    if (total > 0) {
      parts.push(`${total} past ${total === 1 ? "record" : "records"}`);
    }
  }
  return parts.join(" · ") || "No open records";
}

export function PersonNameInput({
  id,
  value,
  onChange,
  placeholder,
  ariaLabel,
  autoFocus,
  maxLength = 120,
  className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  maxLength?: number;
  className?: string;
}) {
  const listboxId = React.useId();
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const debouncedValue = useDebouncedValue(value, 180);
  const peopleQuery = useLoanPeople(debouncedValue, open);
  const people = peopleQuery.data?.items ?? [];

  React.useEffect(() => {
    setActiveIndex(-1);
  }, [debouncedValue, open]);

  const select = (name: string) => {
    onChange(name);
    setOpen(false);
    setActiveIndex(-1);
  };

  const optionId = (index: number) => `${listboxId}-option-${index}`;

  return (
    <div
      ref={containerRef}
      className="relative min-w-0"
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!containerRef.current?.contains(next)) setOpen(false);
      }}
    >
      <Input
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          open && activeIndex >= 0 ? optionId(activeIndex) : undefined
        }
        autoComplete="off"
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        className={className}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder ?? "Start typing a name"}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            if (people.length > 0) {
              setActiveIndex((current) =>
                Math.min(current + 1, people.length - 1),
              );
            }
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            if (people.length > 0) {
              setActiveIndex((current) =>
                current <= 0 ? people.length - 1 : current - 1,
              );
            }
            return;
          }
          if (event.key === "Enter" && open && activeIndex >= 0) {
            const person = people[activeIndex];
            if (person) {
              event.preventDefault();
              select(person.name);
            }
            return;
          }
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            return;
          }
          if (event.key === "Tab") setOpen(false);
        }}
      />
      {open && (
        <div
          data-testid="person-suggestions"
          className="absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-xl border border-border/80 bg-popover shadow-lift"
        >
          {peopleQuery.isPending ? (
            <p className="px-3 py-2.5 text-[0.7rem] text-muted-foreground">
              Looking up household loan names…
            </p>
          ) : people.length > 0 ? (
            <ul
              role="listbox"
              id={listboxId}
              aria-label="Existing household loan names"
              className="max-h-56 overflow-y-auto p-1.5"
            >
              {people.map((person, index) => (
                <li
                  key={person.name}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={cn(
                    "cursor-pointer rounded-lg px-2.5 py-2 text-[0.78rem]",
                    index === activeIndex
                      ? "bg-secondary text-foreground"
                      : "text-foreground/85 hover:bg-secondary/60",
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    select(person.name);
                  }}
                >
                  <span className="block truncate font-medium">{person.name}</span>
                  <span className="mt-0.5 block text-[0.64rem] text-muted-foreground">
                    {suggestionMeta(person)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2.5 text-[0.7rem] leading-relaxed text-muted-foreground">
              {value.trim()
                ? "No saved names match. This name is saved only when you save the record."
                : "No saved names yet. Type a name; it is saved only with this record."}
            </p>
          )}
          <p className="border-t border-border/60 px-3 py-1.5 text-[0.6rem] text-muted-foreground">
            From this household's loan and borrowed records. Selecting a name creates
            nothing.
          </p>
        </div>
      )}
    </div>
  );
}
