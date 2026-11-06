import {
  Armchair,
  Bike,
  BookOpen,
  BriefcaseBusiness,
  Camera,
  Drill,
  Laptop,
  Package,
  Tv,
  Utensils,
  Wifi,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

function iconForCategory(name: string | null | undefined): LucideIcon {
  const value = (name ?? "").toLowerCase();
  if (value.includes("drill") || value.includes("tool")) return Drill;
  if (value.includes("tv") || value.includes("television")) return Tv;
  if (value.includes("cable") || value.includes("network")) return Wifi;
  if (value.includes("bag") || value.includes("luggage")) return BriefcaseBusiness;
  if (value.includes("chair") || value.includes("furniture")) return Armchair;
  if (value.includes("camera") || value.includes("photo")) return Camera;
  if (value.includes("laptop") || value.includes("computer")) return Laptop;
  if (value.includes("kitchen") || value.includes("utensil")) return Utensils;
  if (value.includes("book")) return BookOpen;
  if (value.includes("bike") || value.includes("bicycle")) return Bike;
  return Package;
}

export function CategoryIcon({
  category,
  className,
  label = "Category icon",
  decorative = false,
}: {
  category: string | null | undefined;
  className?: string;
  label?: string;
  decorative?: boolean;
}) {
  const Icon = iconForCategory(category);
  if (decorative) {
    return <Icon aria-hidden="true" className={className} strokeWidth={1.5} />;
  }
  return (
    <span role="img" aria-label={label} className={cn("inline-flex", className)}>
      <Icon aria-hidden="true" className="size-full" strokeWidth={1.5} />
    </span>
  );
}
