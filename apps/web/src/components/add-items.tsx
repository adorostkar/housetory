import { ArrowRight, Camera, MapPin, Mic, PencilLine, Plus, Upload } from "lucide-react";
import * as React from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCanWrite } from "@/lib/queries";
import { cn } from "@/lib/utils";

export interface AddItemsContext {
  propertyId?: string;
  roomId?: string;
  locationId?: string;
  roomName?: string;
  locationName?: string;
}

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
      <AddItemsDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setExplicitContext(undefined);
            window.setTimeout(() => triggerRef.current?.focus(), 0);
          }
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

const CHOICES = [
  {
    id: "manual",
    title: "Enter manually",
    description: "Add an item yourself, with just the details you have.",
    icon: PencilLine,
    path: "/items/new",
  },
  {
    id: "scan",
    title: "Scan a photo",
    description: "Photograph several objects, then review the suggestions.",
    icon: Camera,
    path: "/scan",
  },
  {
    id: "voice",
    title: "Record a voice note",
    description: "Speak naturally, edit the transcript, then review grouped items.",
    icon: Mic,
    path: "/voice",
  },
  {
    id: "import",
    title: "Import a list or file",
    description: "Bring in pasted notes, Markdown, spreadsheets or documents.",
    icon: Upload,
    path: "/imports",
  },
] as const;

function AddItemsDialog({
  open,
  onOpenChange,
  context,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: AddItemsContext | undefined;
}) {
  const navigate = useNavigate();
  const contextLabel = [context?.roomName, context?.locationName]
    .filter(Boolean)
    .join(" · ");
  const choose = (path: string) => {
    const params = new URLSearchParams();
    if (context?.propertyId) params.set("property_id", context.propertyId);
    if (context?.roomId) params.set("room_id", context.roomId);
    if (context?.locationId) params.set("location_id", context.locationId);
    const query = params.toString();
    onOpenChange(false);
    navigate(query ? `${path}?${query}` : path);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add items</DialogTitle>
          <DialogDescription>
            Choose the easiest way to bring something into your home.
          </DialogDescription>
        </DialogHeader>

        {(context?.propertyId || context?.roomId || context?.locationId) && (
          <div className="flex items-start gap-2.5 rounded-xl border border-sage/25 bg-sage-soft/40 px-3.5 py-3 text-[0.75rem] leading-relaxed text-muted-foreground">
            <MapPin className="mt-0.5 size-4 shrink-0 text-sage" />
            <span>
              Starting from{" "}
              <strong className="font-medium text-foreground/90">
                {contextLabel || "the room or place selected on this page"}
              </strong>
              . Sources with their own locations keep them; you can change defaults
              during review.
            </span>
          </div>
        )}

        <div className="grid gap-2.5">
          {CHOICES.map((choice, index) => (
            <button
              key={choice.id}
              type="button"
              autoFocus={index === 0}
              onClick={() => choose(choice.path)}
              className={cn(
                "group flex w-full items-center gap-3 rounded-xl border border-border/70 bg-card/55 px-3.5 py-3.5 text-left transition-[border-color,background-color,transform] hover:border-border hover:bg-secondary/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.995] sm:px-4 sm:py-4",
              )}
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground/70 transition-colors group-hover:text-foreground">
                <choice.icon className="size-[1.1rem]" strokeWidth={1.7} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[0.86rem] font-medium">{choice.title}</span>
                <span className="mt-0.5 block text-[0.72rem] leading-relaxed text-muted-foreground">
                  {choice.description}
                </span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
