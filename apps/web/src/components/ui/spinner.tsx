import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";

function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      className={cn("size-4 animate-spin", className)}
      aria-hidden="true"
      strokeWidth={2}
    />
  );
}

export { Spinner };
