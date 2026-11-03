import { Link } from "react-router-dom";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function EmptyState({
  title,
  description,
  actionLabel,
  actionTo,
  onAction,
  secondary,
  className,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  actionTo?: string;
  onAction?: () => void;
  secondary?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "surface flex flex-col items-center px-6 py-14 text-center sm:px-10 sm:py-20",
        className,
      )}
    >
      <EmptyIllustration />
      <h3 className="mt-7 font-display text-[1.75rem] font-normal tracking-[-0.025em]">
        {title}
      </h3>
      <p className="mt-2.5 max-w-md text-pretty text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      {(actionLabel || secondary) && (
        <div className="mt-7 flex flex-col items-center gap-3 sm:flex-row">
          {actionLabel &&
            (actionTo ? (
              <Button asChild size="lg">
                <Link to={actionTo}>
                  <Plus />
                  {actionLabel}
                </Link>
              </Button>
            ) : (
              <Button size="lg" onClick={onAction}>
                <Plus />
                {actionLabel}
              </Button>
            ))}
          {secondary}
        </div>
      )}
    </div>
  );
}

export function EmptyIllustration({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 220 150"
      className={cn("h-32 w-48 text-sage", className)}
      fill="none"
      aria-hidden="true"
    >
      <ellipse cx="110" cy="135" rx="74" ry="7" fill="currentColor" opacity="0.08" />
      <path
        d="M68 126V69.5C68 45.9 86.8 27 110 27s42 18.9 42 42.5V126"
        stroke="currentColor"
        strokeOpacity="0.34"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M78 126V72c0-19.3 14.3-35 32-35s32 15.7 32 35v54"
        stroke="currentColor"
        strokeOpacity="0.14"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M84 82h52M84 104h52M84 126h52"
        stroke="currentColor"
        strokeOpacity="0.24"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="110" cy="70" r="9" fill="hsl(var(--brass))" opacity="0.32" />
      <path
        d="M97 126v-9h16v9M129 126v-14h13v14"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M152 49v12M146 55h12"
        stroke="hsl(var(--brass))"
        strokeOpacity="0.55"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="65" cy="92" r="2" fill="currentColor" opacity="0.2" />
      <circle cx="160" cy="94" r="1.5" fill="currentColor" opacity="0.18" />
    </svg>
  );
}
