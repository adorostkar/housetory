import { Toaster as Sonner } from "sonner";

import { useTheme } from "@/components/theme-provider";

export function Toaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Sonner
      theme={resolvedTheme}
      position="top-center"
      closeButton
      toastOptions={{
        className: "font-sans",
        style: {
          background: "hsl(var(--popover))",
          color: "hsl(var(--popover-foreground))",
          border: "1px solid hsl(var(--border))",
          borderRadius: "14px",
          boxShadow:
            "0 2px 4px hsl(var(--shadow-color) / 0.05), 0 22px 50px -20px hsl(var(--shadow-color) / 0.2)",
        },
      }}
    />
  );
}
