import { Moon, Sun } from "lucide-react";

import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";

export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const next = resolvedTheme === "dark" ? "light" : "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      <Sun className="hidden size-[1.05rem] dark:block" />
      <Moon className="size-[1.05rem] dark:hidden" />
    </Button>
  );
}
