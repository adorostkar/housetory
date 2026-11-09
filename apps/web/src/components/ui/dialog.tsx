import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-[hsl(30_10%_8%/0.38)] backdrop-blur-[3px] data-[state=open]:animate-fade-in",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose = false, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "dialog-safe-bottom fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100dvh-2rem-env(safe-area-inset-bottom))] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 grid-cols-[minmax(0,1fr)] gap-5 overflow-y-auto overscroll-contain rounded-2xl border border-border/80 bg-popover px-6 pt-6 text-popover-foreground shadow-lift focus:outline-none data-[state=open]:animate-fade-in sm:px-7 sm:pt-7",
        "max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto max-sm:flex max-sm:max-h-[90dvh] max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:flex-col max-sm:overflow-y-auto max-sm:rounded-b-none max-sm:rounded-t-2xl max-sm:border-b-0 max-sm:pb-0 max-sm:pt-0 max-sm:data-[state=open]:animate-sheet-up",
        className,
      )}
      {...props}
    >
      <div
        aria-hidden="true"
        data-dialog-handle=""
        className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-border sm:hidden"
      />
      {children}
      {!hideClose && (
        <div className="max-sm:pointer-events-none max-sm:sticky max-sm:top-3 max-sm:z-20 max-sm:order-first max-sm:-mb-5 max-sm:h-0 max-sm:shrink-0 sm:contents">
          <DialogPrimitive.Close className="pointer-events-auto absolute -right-2 top-0 rounded-full p-2 text-muted-foreground opacity-70 transition-colors hover:bg-secondary hover:text-foreground hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:right-4 sm:top-4">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </div>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-1.5 pr-8 max-sm:sticky max-sm:top-0 max-sm:z-10 max-sm:-mx-6 max-sm:bg-popover max-sm:px-6 max-sm:pb-2 max-sm:pt-7", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col-reverse gap-2 max-sm:dialog-safe-bottom max-sm:sticky max-sm:bottom-0 max-sm:z-10 max-sm:-mx-6 max-sm:border-t max-sm:border-border/60 max-sm:bg-popover max-sm:px-6 max-sm:pt-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "min-w-0 break-words font-display text-2xl font-normal tracking-[-0.02em]",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn(
      "min-w-0 break-words text-sm leading-relaxed text-muted-foreground",
      className,
    )}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
