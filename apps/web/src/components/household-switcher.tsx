import { Check, ChevronDown, House, Plus } from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { getApiErrorMessage } from "@/lib/api";
import {
  useCreateHousehold,
  useSelectHousehold,
  useSession,
} from "@/lib/queries";
import type { HouseholdMembership } from "@/lib/types";
import { cn } from "@/lib/utils";

const ROLE_LABELS = {
  owner: "Owner",
  member: "Member",
  viewer: "Viewer",
} as const;

export function HouseholdCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateHousehold();
  const navigate = useNavigate();
  const [name, setName] = React.useState("");
  const [propertyName, setPropertyName] = React.useState("Home");

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setPropertyName("Home");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a household</DialogTitle>
          <DialogDescription>
            A household has its own members, properties and inventory. Your account
            can belong to several independently, with a different role in each.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && propertyName.trim()) {
              create.mutate(
                {
                  name: name.trim(),
                  property_name: propertyName.trim(),
                },
                {
                  onSuccess: () => {
                    onOpenChange(false);
                    toast.success("Household created");
                    navigate("/", { replace: true });
                  },
                  onError: (error) => toast.error(getApiErrorMessage(error)),
                },
              );
            }
          }}
        >
          {create.error && <FormError message={getApiErrorMessage(create.error)} />}
          <Field label="Household name" htmlFor="new-household-name">
            <Input
              id="new-household-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              placeholder="My Home, Family home, Studio"
              autoFocus
              required
            />
          </Field>
          <Field
            label="First property"
            htmlFor="new-household-property"
            hint="You can add more properties later."
          >
            <Input
              id="new-household-property"
              value={propertyName}
              onChange={(event) => setPropertyName(event.target.value)}
              maxLength={120}
              required
            />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={create.isPending || !name.trim() || !propertyName.trim()}
            >
              {create.isPending ? <Spinner /> : <Plus />}
              Create household
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function HouseholdSwitcher({ compact = false }: { compact?: boolean }) {
  const session = useSession();
  const select = useSelectHousehold();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = React.useState(false);
  const households = session.data?.households ?? [];
  const current = households.find((entry) => entry.is_current) ?? session.data?.household;

  const choose = (household: HouseholdMembership) => {
    if (household.is_current || select.isPending) return;
    select.mutate(household.id, {
      onSuccess: () => {
        toast.success(`Switched to ${household.name}`);
        navigate("/", { replace: true });
      },
      onError: (error) => toast.error(getApiErrorMessage(error)),
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "group flex items-center gap-2 rounded-xl border border-border/60 bg-card/55 text-left transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              compact
                ? "size-9 justify-center rounded-full border-transparent bg-transparent"
                : "mt-5 w-full px-3 py-2.5",
            )}
            aria-label="Switch household"
          >
            <House className="size-4 shrink-0 text-muted-foreground" />
            {!compact && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {current?.name ?? "Choose household"}
                  </span>
                  <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                    {session.data?.role ? ROLE_LABELS[session.data.role] : "No household"}
                    {households.length > 1 ? ` · ${households.length} households` : ""}
                  </span>
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="normal-case tracking-normal">
            Your households
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {households.length === 0 ? (
            <DropdownMenuItem disabled>No household access</DropdownMenuItem>
          ) : (
            households.map((household) => (
              <DropdownMenuItem
                key={household.id}
                onSelect={() => choose(household)}
                disabled={select.isPending}
                className="gap-2"
              >
                <span className="flex size-5 shrink-0 items-center justify-center">
                  {household.is_current ? (
                    <Check className="size-3.5 text-sage" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">{household.name}</span>
                  <span className="block text-2xs text-muted-foreground">
                    {ROLE_LABELS[household.role]} ·{" "}
                    {household.property_count}{" "}
                    {household.property_count === 1 ? "property" : "properties"}
                  </span>
                </span>
                {household.is_current && <Badge variant="outline">Current</Badge>}
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
            <Plus />
            Create household
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <HouseholdCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
