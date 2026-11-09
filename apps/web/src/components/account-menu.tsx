import { Check, ChevronUp, LogOut, Plus, Settings, UserRound, Users } from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HouseholdCreateDialog } from "@/components/household-switcher";
import { getApiErrorMessage } from "@/lib/api";
import { useLogout, useSelectHousehold, useSession } from "@/lib/queries";
import { cn, initials } from "@/lib/utils";

export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const logout = useLogout();
  const selectHousehold = useSelectHousehold();
  const [createOpen, setCreateOpen] = React.useState(false);
  const user = session?.user;
  const household = session?.household;
  const households = session?.households ?? [];

  const onLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        toast.success("Signed out");
        navigate("/login", { replace: true });
      },
      onError: (error) => toast.error(getApiErrorMessage(error)),
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "group flex items-center gap-3 rounded-xl text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            compact
              ? "size-9 justify-center rounded-full hover:bg-secondary/70"
              : "w-full px-2 py-2 hover:bg-secondary/60",
          )}
          aria-label="Account menu"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-2xs font-semibold tracking-[0.04em] text-foreground ring-1 ring-border/60">
            {user ? initials(user.name) : <UserRound className="size-4" />}
          </span>
          {!compact && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium leading-tight text-foreground">
                  {user?.name ?? "Account"}
                </span>
                <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                  {household?.name ?? ""}
                </span>
              </span>
              <ChevronUp className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={compact ? "bottom" : "top"} className="w-56">
        <DropdownMenuLabel className="normal-case tracking-normal">
          <span className="block text-xs font-medium text-foreground">{user?.name}</span>
          <span className="mt-0.5 block truncate text-2xs font-normal text-muted-foreground">
            {user?.email}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="normal-case tracking-normal">
          Households
        </DropdownMenuLabel>
        {households.map((entry) => (
          <DropdownMenuItem
            key={entry.id}
            disabled={selectHousehold.isPending}
            onSelect={() => {
              if (entry.is_current) return;
              selectHousehold.mutate(entry.id, {
                onSuccess: () => {
                  toast.success(`Switched to ${entry.name}`);
                  navigate("/", { replace: true });
                },
                onError: (error) => toast.error(getApiErrorMessage(error)),
              });
            }}
          >
            <span className="flex size-4 items-center justify-center">
              {entry.is_current ? <Check className="size-3.5 text-sage" /> : null}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {entry.name}
              <span className="ml-1 text-2xs capitalize text-muted-foreground">
                {entry.role}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
          <Plus />
          Create household
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/settings")}>
          <Settings />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/settings/account")}>
          <UserRound />
          Account settings
        </DropdownMenuItem>
        {session?.role === "owner" && (
          <DropdownMenuItem onSelect={() => navigate("/settings/members")}>
            <Users />
            Members & invitations
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive disabled={logout.isPending} onSelect={onLogout}>
          <LogOut />
          {logout.isPending ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
      <HouseholdCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </DropdownMenu>
  );
}
