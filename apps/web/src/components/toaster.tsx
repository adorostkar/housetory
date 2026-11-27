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
        // On touch the buttons of a message are 44 px. The small close button keeps
        // its look and gets a tap area around it.
        classNames: {
          actionButton: "coarse:!h-11 coarse:!px-4",
          cancelButton: "coarse:!h-11 coarse:!px-4",
          // More to the right and down, because the button sits on the edge of the screen.
          closeButton:
            "coarse:before:absolute coarse:before:-bottom-4 coarse:before:-left-2 coarse:before:-right-4 coarse:before:-top-2 coarse:before:content-['']",
        },
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
