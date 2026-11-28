import {
  Activity,
  ChevronRight,
  CloudOff,
  Home,
  LogOut,
  Palette,
  Sparkles,
  UserRound,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { PALETTES, useTheme } from "@/components/theme-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatSavedAt } from "@/components/offline-banner";
import { getApiErrorMessage } from "@/lib/api";
import { clearAllItemDrafts } from "@/lib/item-drafts";
import { useOfflineStatus } from "@/lib/offline/controller";
import { useLogout, useSession, useSystemStatusSummary } from "@/lib/queries";

/**
 * Settings used to be one long page. Links to its old anchors still arrive
 * here; each one is sent on to the screen that now holds that section.
 */
const MOVED_ANCHORS: Record<string, string> = {
  "#item-images": "/settings/household",
  "#online-search": "/settings/services",
  "#online-search-connection": "/settings/services",
  "#online-manual-search": "/settings/services",
  "#reference-image-search": "/settings/services",
  "#system-status": "/settings/system-status",
};

const MODE_LABELS = { light: "Light", dark: "Dark", system: "System" } as const;

const ROLE_LABELS = { owner: "Owner", member: "Member", viewer: "Viewer" } as const;

function SettingsRow({
  to,
  icon: Icon,
  title,
  summary,
  badge,
}: {
  to: string;
  icon: LucideIcon;
  title: string;
  summary: string;
  badge?: React.ReactNode;
}) {
  return (
    <li>
      <Link
        to={to}
        className="flex min-h-14 items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-5"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <Icon className="size-4" strokeWidth={1.8} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{title}</span>
          <span className="block break-words text-xs text-muted-foreground">{summary}</span>
          {badge && <span className="mt-1.5 block">{badge}</span>}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </li>
  );
}

function SettingsGroup({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    // min-w-0: a long word in a row (an e-mail address) wraps instead of widening the page.
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className="eyebrow mb-2 px-1">
        {title}
      </h2>
      <ul className="surface divide-y divide-border/60 overflow-hidden">{children}</ul>
      {note && <p className="mt-2 px-1 text-2xs text-muted-foreground">{note}</p>}
    </section>
  );
}

export function SettingsPage() {
  const session = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const logout = useLogout();
  const { theme, palette } = useTheme();
  const offline = useOfflineStatus();
  const isOwner = session.data?.role === "owner";
  const health = useSystemStatusSummary(isOwner);

  const moved = MOVED_ANCHORS[location.hash];
  if (moved) {
    return <Navigate replace to={{ pathname: moved, hash: location.hash }} />;
  }

  if (session.isPending) {
    return (
      <div>
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-4 h-12 w-48" />
        <Skeleton className="mt-10 h-80 rounded-2xl" />
      </div>
    );
  }

  const user = session.data?.user;
  const household = session.data?.household;
  const role = session.data?.role;
  const paletteName =
    PALETTES.find((entry) => entry.id === palette)?.name ?? PALETTES[0].name;
  const healthBadge = !isOwner ? null : health.isPending ? (
    <Skeleton className="h-6 w-16 rounded-full" />
  ) : health.isError || !health.data ? (
    <Badge variant="outline">Unavailable</Badge>
  ) : health.data.status === "attention" ? (
    <Badge variant={health.data.core_issue_count > 0 ? "destructive" : "brass"}>
      {health.data.attention_count} need attention
    </Badge>
  ) : (
    <Badge variant="sage">Healthy</Badge>
  );

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Preferences"
        title="Settings"
        description="Your account, this household and the way Housetory looks."
      />

      <div className="grid min-w-0 max-w-2xl gap-6">
        <SettingsGroup id="settings-yours" title="Yours">
          <SettingsRow
            to="/settings/account"
            icon={UserRound}
            title="Account"
            summary={[user?.name, user?.email].filter(Boolean).join(" · ") || "Name and password"}
          />
          <SettingsRow
            to="/settings/appearance"
            icon={Palette}
            title="Appearance"
            summary={`${paletteName} · ${MODE_LABELS[theme]}`}
          />
          <SettingsRow
            to="/settings/offline"
            icon={CloudOff}
            title="Offline copy"
            summary={
              !offline.enabled
                ? "Off. Look up your things without a connection."
                : offline.info
                  ? `On this device · saved ${formatSavedAt(offline.info.savedAt)}`
                  : "On this device · no copy saved yet"
            }
          />
        </SettingsGroup>

        <SettingsGroup
          id="settings-household"
          title="Household"
          note={
            isOwner
              ? undefined
              : "Only the household owner can change household settings, manage members, set up AI or see system status."
          }
        >
          <SettingsRow
            to="/settings/household"
            icon={Home}
            title="Household"
            summary={[
              household?.name,
              household?.default_currency,
              role ? `you are ${ROLE_LABELS[role].toLowerCase()}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
          {isOwner && (
            <SettingsRow
              to="/settings/members"
              icon={Users}
              title="Members and invitations"
              summary="Who can open this household, and their roles."
            />
          )}
          <SettingsRow
            to="/settings/services"
            icon={Sparkles}
            title="AI and online services"
            summary="AI providers, data consent and online lookups. All optional."
          />
          {isOwner && (
            <SettingsRow
              to="/settings/system-status"
              icon={Activity}
              title="System status"
              summary="Readiness, background jobs and AI task checks."
              badge={healthBadge}
            />
          )}
        </SettingsGroup>

        <SettingsGroup id="settings-advanced" title="Advanced">
          <SettingsRow
            to="/settings/advanced"
            icon={Wrench}
            title="Storage, install and labels"
            summary="Storage and backup, install on iPhone, label calibration."
          />
        </SettingsGroup>

        <section className="surface flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
              Sign out
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              End this session on this device.
              {offline.enabled && " The offline copy is removed too."}
            </p>
          </div>
          <Button
            variant="outline"
            disabled={logout.isPending}
            onClick={() =>
              logout.mutate(undefined, {
                onSuccess: () => {
                  clearAllItemDrafts();
                  toast.success("Signed out");
                  navigate("/login", { replace: true });
                },
                onError: (error) => toast.error(getApiErrorMessage(error)),
              })
            }
          >
            <LogOut />
            Sign out
          </Button>
        </section>
      </div>
    </div>
  );
}
