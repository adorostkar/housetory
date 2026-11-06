import { Globe2 } from "lucide-react";

import { Select } from "@/components/ui/select";
import { useSearchScope } from "@/hooks/use-search-scope";
import { cn } from "@/lib/utils";

function encode(householdId: string, propertyId: string) {
  if (!householdId) return "all";
  if (!propertyId) return `household:${householdId}`;
  return `household:${householdId}|property:${propertyId}`;
}

function decode(value: string) {
  if (!value || value === "all") return { householdId: "", propertyId: "" };
  if (value.startsWith("household:")) {
    const [householdId, propertyPart] = value.slice("household:".length).split("|property:");
    return {
      householdId: householdId ?? "",
      propertyId: propertyPart ?? "",
    };
  }
  return { householdId: "", propertyId: "" };
}

export function SearchScopeSelect({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const { selection, setSelection, scopes, label } = useSearchScope(true);
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Globe2 className="size-3.5 shrink-0 text-muted-foreground" />
      <Select
        aria-label="Search scope"
        value={encode(selection.householdId, selection.propertyId)}
        onChange={(event) => setSelection(decode(event.target.value))}
        className={cn(
          compact ? "h-9 rounded-lg text-[0.78rem]" : "h-10 rounded-xl text-[0.8rem]",
          "min-w-[180px]",
        )}
      >
        <option value="all">All my places</option>
        {scopes.map((household) => (
          <optgroup key={household.id} label={household.name}>
            <option value={encode(household.id, "")}>
              {household.name} — all properties
            </option>
            {household.properties.map((property) => (
              <option
                key={property.id}
                value={encode(household.id, property.id)}
              >
                {household.name} · {property.name}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
      <span className="sr-only">Current search scope: {label}</span>
    </div>
  );
}
