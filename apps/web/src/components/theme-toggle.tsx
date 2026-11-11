import { Monitor, Moon, Sun } from "lucide-react";

import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";

const THEME_CYCLE = {
  light: { next: "dark", label: "Light", icon: Sun },
  dark: { next: "system", label: "Dark", icon: Moon },
  system: { next: "light", label: "System", icon: Monitor },
} as const;

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const { next, label, icon: Icon } = THEME_CYCLE[theme];
  const actionLabel = `Appearance: ${label}. Switch to ${next} mode`;
  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      onClick={() => setTheme(next)}
      aria-label={actionLabel}
      title={actionLabel}
    >
      <Icon className="size-[1.05rem]" aria-hidden="true" />
    </Button>
  );
}
