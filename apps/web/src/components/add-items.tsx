import { Plus } from "lucide-react";
import * as React from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { SmartAddInput, type SmartAddContext } from "@/components/smart-add-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useCanWrite } from "@/lib/queries";

export type AddItemsContext = SmartAddContext;

interface AddItemsApi {
  openAddItems: (context?: AddItemsContext, trigger?: HTMLElement | null) => void;
  setPageContext: (context: AddItemsContext | null) => void;
}

const AddItemsReactContext = React.createContext<AddItemsApi | null>(null);

function inferRouteContext(pathname: string, search: string): AddItemsContext | undefined {
  const params = new URLSearchParams(search);
  const context: AddItemsContext = {};
  const queryProperty = params.get("property_id");
  const queryRoom = params.get("room_id");
  const queryLocation = params.get("location_id");
  if (queryProperty) context.propertyId = queryProperty;
  if (queryRoom) context.roomId = queryRoom;
  if (queryLocation) context.locationId = queryLocation;
  const roomMatch = pathname.match(/^\/rooms\/([^/]+)/);
  if (roomMatch) context.roomId = decodeURIComponent(roomMatch[1]!);
  const containerMatch = pathname.match(/^\/containers\/([^/]+)/);
  if (containerMatch) context.locationId = decodeURIComponent(containerMatch[1]!);
  return context.roomId || context.locationId ? context : undefined;
}

export function AddItemsProvider({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [open, setOpen] = React.useState(false);
  const [explicitContext, setExplicitContext] = React.useState<
    AddItemsContext | undefined
  >();
  const [pageContext, setPageContextState] = React.useState<
    AddItemsContext | undefined
  >();
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const routeContext = React.useMemo(
    () => inferRouteContext(location.pathname, location.search),
    [location.pathname, location.search],
  );
  const context = explicitContext ?? pageContext ?? routeContext;
  const openAddItems = React.useCallback(
    (next?: AddItemsContext, trigger?: HTMLElement | null) => {
      triggerRef.current = trigger ?? null;
      setExplicitContext(next);
      setOpen(true);
    },
    [],
  );
  const setPageContext = React.useCallback((next: AddItemsContext | null) => {
    setPageContextState(next ?? undefined);
  }, []);
  const api = React.useMemo(
    () => ({ openAddItems, setPageContext }),
    [openAddItems, setPageContext],
  );

  return (
    <AddItemsReactContext.Provider value={api}>
      {children}
      <AddItemsOverlay
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setExplicitContext(undefined);
            window.setTimeout(() => triggerRef.current?.focus(), 0);
          }
        }}
        onFinish={() => {
          setOpen(false);
          setExplicitContext(undefined);
          triggerRef.current = null;
        }}
        context={context}
      />
    </AddItemsReactContext.Provider>
  );
}

export function useAddItems() {
  const value = React.useContext(AddItemsReactContext);
  if (!value) {
    throw new Error("useAddItems must be used inside AddItemsProvider.");
  }
  return value;
}

export function useRegisterAddItemsContext(context: AddItemsContext | null) {
  const api = React.useContext(AddItemsReactContext);
  const roomId = context?.roomId;
  const propertyId = context?.propertyId;
  const locationId = context?.locationId;
  const roomName = context?.roomName;
  const locationName = context?.locationName;
  React.useEffect(() => {
    if (!api) return;
    api.setPageContext(
      propertyId || roomId || locationId || roomName || locationName
        ? { propertyId, roomId, locationId, roomName, locationName }
        : null,
    );
    return () => api.setPageContext(null);
  }, [api, propertyId, roomId, locationId, roomName, locationName]);
}

export function AddItemsButton({
  context,
  label = "Add items",
  variant = "default",
  size = "default",
  className,
  iconOnly = false,
}: {
  context?: AddItemsContext;
  label?: string;
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
  iconOnly?: boolean;
}) {
  const canWrite = useCanWrite();
  const { openAddItems } = useAddItems();
  if (!canWrite) return null;
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      onClick={(event) => openAddItems(context, event.currentTarget)}
      aria-label={iconOnly ? label : undefined}
    >
      <Plus />
      {!iconOnly && label}
    </Button>
  );
}

export function AddItemsRedirect() {
  const { openAddItems } = useAddItems();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  React.useEffect(() => {
    const context: AddItemsContext = {};
    const propertyId = searchParams.get("property_id");
    const roomId = searchParams.get("room_id");
    const locationId = searchParams.get("location_id");
    if (propertyId) context.propertyId = propertyId;
    if (roomId) context.roomId = roomId;
    if (locationId) context.locationId = locationId;
    navigate("/", { replace: true });
    openAddItems(propertyId || roomId || locationId ? context : undefined);
  }, [navigate, openAddItems, searchParams]);
  return null;
}

function AddItemsOverlay({
  open,
  onOpenChange,
  onFinish,
  context,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFinish: () => void;
  context: AddItemsContext | undefined;
}) {
  const desktop = useMediaQuery("(min-width: 1024px)");
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = React.useState(false);
  const escapeRef = React.useRef<(() => boolean) | null>(null);
  React.useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);
  const changeOpen = (next: boolean) => {
    if (!next && busy) return;
    onOpenChange(next);
  };
  const guard = {
    onEscapeKeyDown: (event: KeyboardEvent) => {
      if (busy || escapeRef.current?.()) event.preventDefault();
    },
    onInteractOutside: (event: Event) => {
      if (busy) event.preventDefault();
    },
  };
  const description = "Describe them, paste a product link, add a photo or speak.";
  const body = (
    <SmartAddInput
      context={context}
      layout={desktop ? "dialog" : "sheet"}
      onBusyChange={setBusy}
      onFinish={() => {
        setBusy(false);
        onFinish();
      }}
      escapeRef={escapeRef}
    />
  );

  if (desktop) {
    return (
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="max-w-xl overflow-visible" hideClose={busy} {...guard}>
          <DialogHeader>
            <DialogTitle>Add items</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Sheet open={open} onOpenChange={changeOpen}>
      <SheetContent
        hideClose={busy}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus({ preventScroll: true });
        }}
        {...guard}
      >
        <SheetHeader className="pr-12">
          <SheetTitle ref={titleRef} tabIndex={-1} className="focus:outline-none">
            Add items
          </SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {body}
      </SheetContent>
    </Sheet>
  );
}
