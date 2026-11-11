import type { EnhancementState } from "@/lib/types/enrichment";
import { formatCurrency } from "@/lib/utils";

export function enhancementLabel(state: EnhancementState): string {
  switch (state.status) {
    case "off":
      return state.reason === "consent_required" ? "AI needs consent" : "AI off";
    case "queued":
      return "AI suggestions queued";
    case "running":
      return "Preparing AI suggestions";
    case "ready":
      return state.reason === "no_changes"
        ? "AI review complete · no changes" : "AI suggestions available";
    case "failed":
      return state.reason === "read_timeout" ? "AI timed out · local results kept"
        : state.reason === "unreachable" || state.reason === "connect_timeout"
          ? "AI unreachable · local results kept"
          : state.reason === "busy" ? "AI busy · local results kept" : "AI suggestions unavailable";
    case "skipped":
      return state.reason === "cancelled" ? "AI suggestions cancelled"
        : "AI suggestions skipped: source or settings changed";
    case "accepted":
      return "AI suggestions loaded into review";
  }
}

export function keepManualEdits<T extends object>(base: T, edited: T, suggested: T): T {
  const baseline = new Map<string, unknown>(Object.entries(base));
  const manual = Object.entries(edited).filter(
    ([key, value]) => JSON.stringify(value) !== JSON.stringify(baseline.get(key)),
  );
  return { ...suggested, ...Object.fromEntries(manual) };
}

export function proposalValue(value: unknown): string {
  if (value == null || value === "") return "Not set";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.length ? value.map(proposalValue).join(", ") : "None";
  const fields = new Map<string, unknown>(Object.entries(value));
  const name = fields.get("name") ?? fields.get("text");
  if (typeof name === "string") return name;
  return Object.entries(value)
    .filter(([key, field]) => field != null && !key.endsWith("_id") && key !== "currency")
    .map(([key, field]) => key === "price_cents" && typeof field === "number"
      ? typeof fields.get("currency") === "string"
        ? formatCurrency(field, String(fields.get("currency")))
        : `${field} minor units (currency unknown)`
      : `${key.replaceAll("_", " ")}: ${proposalValue(field)}`)
    .join(" · ") || "Not set";
}
