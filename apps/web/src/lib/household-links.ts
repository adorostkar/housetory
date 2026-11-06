export function withHousehold(url: string, householdId?: string | null): string {
  if (!householdId) return url;
  const [path, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  params.set("household_id", householdId);
  return `${path}?${params.toString()}`;
}
