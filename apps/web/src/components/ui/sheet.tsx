import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";

import {
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetClose = DialogPrimitive.Close;

/** Bottom-anchored sheet built on Radix Dialog, for small screens. */
const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose = false, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed inset-x-0 bottom-0 z-50 grid max-h-[calc(100dvh-1rem)] grid-cols-[minmax(0,1fr)] gap-4 overflow-y-auto overscroll-contain rounded-t-3xl border-t border-border/80 bg-popover px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 text-popover-foreground shadow-lift focus:outline-none data-[state=open]:animate-sheet-up",
        className,
      )}
      {...props}
    >
      <div aria-hidden="true" className="mx-auto h-1.5 w-10 rounded-full bg-border" />
      {children}
      {!hideClose && (
        <DialogPrimitive.Close className="absolute right-3 top-3 flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
SheetContent.displayName = "SheetContent";

export {
  Sheet,
  SheetClose,
  SheetContent,
  DialogDescription as SheetDescription,
  DialogHeader as SheetHeader,
  DialogTitle as SheetTitle,
};
