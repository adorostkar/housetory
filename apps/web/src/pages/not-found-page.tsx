import { Link } from "react-router-dom";

import { EmptyIllustration } from "@/components/empty-state";
import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center text-center">
      <EmptyIllustration className="h-40 w-56" />
      <p className="eyebrow mt-6">404</p>
      <h1 className="mt-3 font-display text-4xl tracking-[-0.03em]">
        This page has no place.
      </h1>
      <p className="mt-3 max-w-md text-[0.9rem] leading-relaxed text-muted-foreground">
        The page you're looking for doesn't exist, or it may have moved.
      </p>
      <Button asChild className="mt-7">
        <Link to="/">Return home</Link>
      </Button>
    </div>
  );
}
