import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type PageHeaderProps = React.ComponentProps<typeof PageHeader>;

/**
 * Standard page scaffold: header, optional toolbar, content.
 * Use `size="large"` only on landing pages; work pages use the compact header.
 */
export function PageLayout({
  header,
  toolbar,
  children,
  className,
}: {
  header: PageHeaderProps;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("animate-fade-up", className)}>
      <PageHeader {...header} />
      {toolbar ? <div className="mb-5">{toolbar}</div> : null}
      {children}
    </div>
  );
}

export function PageSkeleton({
  variant = "list",
  className,
}: {
  variant?: "list" | "cards" | "detail";
  className?: string;
}) {
  return (
    <div
      className={cn("animate-fade-in", className)}
      aria-busy="true"
      aria-label="Loading"
    >
      <Skeleton className="h-8 w-1/2 max-w-sm" />
      <Skeleton className="mt-3 h-4 w-2/3 max-w-md" />
      {variant === "cards" && (
        <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="aspect-[4/3] rounded-2xl" />
          ))}
        </div>
      )}
      {variant === "list" && (
        <div className="mt-8 space-y-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-16 rounded-2xl" />
          ))}
        </div>
      )}
      {variant === "detail" && (
        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <Skeleton className="aspect-[4/3] rounded-2xl" />
          <div className="space-y-3">
            <Skeleton className="h-10 rounded-xl" />
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
          </div>
        </div>
      )}
    </div>
  );
}
