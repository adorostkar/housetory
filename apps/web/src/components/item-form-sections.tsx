import { ChevronDown } from "lucide-react";
import * as React from "react";

import type { ItemCondition } from "@/lib/types";
import { cn } from "@/lib/utils";

export const CONDITIONS: ItemCondition[] = ["new", "excellent", "good", "fair", "poor", "unknown"];

export function FormSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("surface p-5 sm:p-7", className)}>
      <div className="mb-6">
        <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">{title}</h2>
        {description && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

export function OptionalFormSection({
  id,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="surface p-5 sm:p-6">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-4 text-left"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-display text-[1.18rem] tracking-[-0.02em]">{title}</span>
            <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Optional
            </span>
          </span>
          <span className="mt-1 block text-2xs leading-relaxed text-muted-foreground">
            {summary}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 px-2.5 py-1 text-2xs font-medium text-muted-foreground">
          {open ? "Hide" : "Edit"}
          <ChevronDown
            className={cn("size-3.5 transition-transform", open && "rotate-180")}
          />
        </span>
      </button>
      {open && (
        <div id={id} className="mt-5 space-y-5 border-t border-border/60 pt-5">
          {children}
        </div>
      )}
    </section>
  );
}
