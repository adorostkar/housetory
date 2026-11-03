import { BrandSymbol } from "@/components/brand-mark";
import { Skeleton } from "@/components/ui/skeleton";

export function PageFallback() {
  return (
    <div className="animate-fade-in" aria-busy="true" aria-label="Loading page">
      <div className="flex items-center gap-3">
        <BrandSymbol className="size-8 opacity-60" />
        <Skeleton className="h-3.5 w-28" />
      </div>
      <Skeleton className="mt-5 h-11 w-2/3 max-w-md" />
      <div className="mt-10 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-36 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
