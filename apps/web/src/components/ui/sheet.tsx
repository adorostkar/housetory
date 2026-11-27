import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";

import {
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  keepOpenForInnerList,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetClose = DialogPrimitive.Close;

/** Bottom-anchored sheet built on Radix Dialog, for small screens. */
const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose = false, onEscapeKeyDown, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      onEscapeKeyDown={(event) => keepOpenForInnerList(event, onEscapeKeyDown)}
      className={cn(
        "fixed inset-x-0 bottom-[var(--keyboard-inset,0px)] z-50 grid max-h-[min(calc(100dvh-1rem),calc(var(--visual-viewport-height,100dvh)-0.5rem))] grid-cols-[minmax(0,1fr)] gap-4 overflow-y-auto overscroll-contain rounded-t-3xl border-t border-border/80 bg-popover px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 text-popover-foreground shadow-lift focus:outline-none data-[state=open]:animate-sheet-up",
        // A phone held sideways with the keyboard open leaves a strip of some 70 px.
        "[[data-keyboard-side]_&]:max-h-[var(--visual-viewport-height,100dvh)] [[data-keyboard-side]_&]:gap-1 [[data-keyboard-side]_&]:rounded-none [[data-keyboard-side]_&]:pb-1 [[data-keyboard-side]_&]:pl-[max(1.25rem,env(safe-area-inset-left))] [[data-keyboard-side]_&]:pr-[max(1.25rem,env(safe-area-inset-right))] [[data-keyboard-side]_&]:pt-1",
        className,
      )}
      {...props}
    >
      <div aria-hidden="true" className="mx-auto h-1.5 w-10 rounded-full bg-border [[data-keyboard-side]_&]:hidden" />
      {children}
      {!hideClose && (
        // Stays at the top while the sheet scrolls, so it can always be reached,
        // also when the phone keyboard leaves the sheet little room.
        <div className="pointer-events-none sticky top-3 z-20 order-first -mb-4 h-0 [[data-keyboard-side]_&]:top-1 [[data-keyboard-side]_&]:-mb-1">
          <DialogPrimitive.Close className="pointer-events-auto absolute -right-2 top-0 flex size-11 items-center justify-center rounded-full bg-popover/90 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </div>
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
