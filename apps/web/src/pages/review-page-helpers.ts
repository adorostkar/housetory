
import type {
  ReviewRun,
  ReviewScopeType,
  ReviewSuggestionStatus,
  ReviewSuggestionType,
} from "@/lib/types";
import { pluralize } from "@/lib/utils";

export const SCOPES: Array<{ value: ReviewScopeType; label: string }> = [
  { value: "household", label: "Whole household" },
  { value: "property", label: "Property" },
  { value: "room", label: "Room" },
  { value: "container", label: "Container or place" },
  { value: "items", label: "Selected items" },
];

export const TYPE_LABELS: Record<ReviewSuggestionType, string> = {
  category: "Category",
  name: "Naming",
  organisation: "Organisation",
  possible_duplicate: "Possible duplicate",
  missing_detail: "Missing detail",
  location_conflict: "Location wording",
};

export const STATUS_VARIANTS: Record<
  ReviewSuggestionStatus,
  "sage" | "brass" | "outline" | "secondary" | "destructive"
> = {
  pending: "brass",
  accepted: "sage",
  dismissed: "secondary",
  stale: "destructive",
  reverted: "outline",
};

export const STATUS_VALUES: ReviewSuggestionStatus[] = [
  "pending",
  "accepted",
  "dismissed",
  "stale",
  "reverted",
];

export const TYPE_VALUES = Object.keys(TYPE_LABELS) as ReviewSuggestionType[];

export function stringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function organisationTagNames(after: Record<string, unknown>): string[] {
  if (!Array.isArray(after.tags)) return stringList(after.tag_names);
  return after.tags.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (entry && typeof entry === "object" && "name" in entry) {
      const name = (entry as { name?: unknown }).name;
      return typeof name === "string" && name.trim() ? [name] : [];
    }
    return [];
  });
}

export function timestamp(value: string | null | undefined) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function aiRunSummary(run: ReviewRun) {
  if (!run.include_ai) return "AI not requested · offline rules only";
  const route = run.ai_provider_label
    ? ` via ${run.ai_provider_label}${run.ai_model ? ` · ${run.ai_model}` : ""}`
    : "";
  if (run.ai_error && run.ai_used) {
    return `AI failed${route} · ${run.ai_item_count} items sent · offline suggestions kept`;
  }
  if (run.ai_error) return `AI skipped${route} · 0 items sent`;
  if (!run.ai_used) return "AI skipped · no eligible items need organisation · 0 items sent";
  const provider = run.ai_provider_label ?? "Assistant";
  return `AI completed via ${provider}${run.ai_model ? ` · ${run.ai_model}` : ""} · ${run.ai_item_count} items sent`;
}

export function reviewScopeLabel({
  scopeType,
  propertyName,
  roomName,
  containerLabel,
  selectedCount,
}: {
  scopeType: ReviewScopeType;
  propertyName: string | null;
  roomName: string | null;
  containerLabel: string | null;
  selectedCount: number;
}) {
  if (scopeType === "household") return "Whole household";
  if (scopeType === "property") return propertyName ?? "Selected property";
  if (scopeType === "room") return roomName ? `Room: ${roomName}` : "Selected room";
  if (scopeType === "container") return containerLabel ?? "Selected container";
  return `${pluralize(selectedCount, "selected item")}`;
}
