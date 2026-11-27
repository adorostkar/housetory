import { Check, Monitor, Moon, Sun } from "lucide-react";

import { PALETTES, useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

const MODES = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
] as const;

/** Colour theme and light/dark choice. Both are kept on this device only. */
export function AppearanceSettings({ className }: { className?: string }) {
  const { theme, setTheme, palette, setPalette } = useTheme();
  return (
    <div className={cn("space-y-6", className)}>
      <fieldset>
        <legend className="field-label">Colour theme</legend>
        <p className="mt-1 text-xs text-muted-foreground">
          Changes colours only. The layout stays the same.
        </p>
        <div role="radiogroup" aria-label="Colour theme" className="mt-3 grid gap-2 sm:grid-cols-2">
          {PALETTES.map((entry) => {
            const selected = entry.id === palette;
            return (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setPalette(entry.id)}
                className={cn(
                  "flex min-h-14 items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  selected
                    ? "border-primary bg-secondary"
                    : "border-border bg-card hover:bg-secondary/60",
                )}
              >
                <span
                  aria-hidden="true"
                  className="flex h-8 w-14 shrink-0 overflow-hidden rounded-md border border-input"
                >
                  {entry.swatch.map((color) => (
                    <span key={color} className="h-full flex-1" style={{ backgroundColor: color }} />
                  ))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {entry.name}
                    {entry.id === "housetory" && (
                      <span className="font-normal text-muted-foreground"> · default</span>
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground">{entry.description}</span>
                </span>
                <Check
                  aria-hidden="true"
                  className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")}
                />
              </button>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="min-w-0">
        <legend className="field-label">Light or dark</legend>
        <div
          role="radiogroup"
          aria-label="Light or dark"
          className="mt-3 flex w-full max-w-sm rounded-xl border border-border bg-card p-1"
        >
          {MODES.map((mode) => {
            const selected = mode.id === theme;
            return (
              <button
                key={mode.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTheme(mode.id)}
                className={cn(
                  "flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                  // On the narrowest phones the icon sits above the word, so all three fit.
                  "max-[359px]:flex-col max-[359px]:gap-0.5 max-[359px]:px-1 max-[359px]:py-1",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <mode.icon aria-hidden="true" className="size-4" />
                {mode.label}
              </button>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
