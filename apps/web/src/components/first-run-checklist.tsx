import { Bot, Check, DoorOpen, FileText, Package } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Step {
  key: string;
  title: string;
  description: string;
  done: boolean;
  icon: typeof Package;
  action: { label: string; onClick?: () => void; to?: string };
}

export function FirstRunChecklist({
  roomCount,
  itemCount,
  documentCount,
  onCreateRoom,
  onAddItems,
}: {
  roomCount: number;
  itemCount: number;
  documentCount: number;
  onCreateRoom: () => void;
  onAddItems: () => void;
}) {
  const steps: Step[] = [
    {
      key: "room",
      title: "Create a room",
      description: "Rooms and shelves give everything a place to live.",
      done: roomCount > 0,
      icon: DoorOpen,
      action: { label: roomCount > 0 ? "Add another" : "Create room", onClick: onCreateRoom },
    },
    {
      key: "items",
      title: "Add your first items",
      description: "A camera, a favourite pan, the keys by the door.",
      done: itemCount > 0,
      icon: Package,
      action: { label: "Add items", onClick: onAddItems },
    },
    {
      key: "document",
      title: "Attach a receipt or document",
      description: "Keep the paper trail next to the thing it proves.",
      done: documentCount > 0,
      icon: FileText,
      action: { label: "Open documents", to: "/documents" },
    },
    {
      key: "assistant",
      title: "Ask the assistant",
      description: "Once you have items, ask where anything is.",
      done: false,
      icon: Bot,
      action: { label: "Open assistant", to: "/assistant" },
    },
  ];
  const completed = steps.filter((step) => step.done).length;
  if (completed === steps.length) return null;

  return (
    <section className="surface p-6" aria-label="Getting started">
      <p className="eyebrow mb-2">Getting started</p>
      <h2 className="font-display text-[1.5rem] tracking-[-0.025em]">
        Your home, ready for its first story.
      </h2>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {completed} of {steps.length} steps done — take them at your own pace.
      </p>
      <ol className="mt-5 divide-y divide-border/60">
        {steps.map((step) => {
          const Icon = step.icon;
          return (
            <li key={step.key} className="flex items-center gap-3 py-3">
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full",
                  step.done
                    ? "bg-sage-soft text-accent-foreground"
                    : "bg-secondary text-muted-foreground",
                )}
              >
                {step.done ? <Check className="size-4" /> : <Icon className="size-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block text-sm font-medium",
                    step.done && "text-muted-foreground line-through",
                  )}
                >
                  {step.title}
                  {step.done && <span className="sr-only"> (done)</span>}
                </span>
                <span className="block text-2xs text-muted-foreground">
                  {step.description}
                </span>
              </span>
              {step.action.to ? (
                <Button variant="ghost" size="sm" asChild>
                  <Link to={step.action.to}>{step.action.label}</Link>
                </Button>
              ) : (
                <Button
                  variant={step.done ? "ghost" : "outline"}
                  size="sm"
                  onClick={step.action.onClick}
                >
                  {step.action.label}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
