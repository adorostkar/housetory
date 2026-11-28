import { CloudOff, RotateCw } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { checkConnection, useOfflineStatus } from "@/lib/offline/controller";

/** "today at 14:02", or the date when the copy is older. */
export function formatSavedAt(savedAt: number, now = new Date()): string {
  const saved = new Date(savedAt);
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(
    saved,
  );
  if (saved.toDateString() === now.toDateString()) return `today at ${time}`;
  const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(saved);
  return `on ${day} at ${time}`;
}

function useTryAgain() {
  const [checking, setChecking] = React.useState(false);
  const tryAgain = () => {
    setChecking(true);
    void checkConnection().finally(() => setChecking(false));
  };
  return { checking, tryAgain };
}

/** Shown above every page while the server cannot be reached and the copy is used. */
export function OfflineBanner() {
  const { online, info } = useOfflineStatus();
  const { checking, tryAgain } = useTryAgain();
  if (online || !info) return null;
  return (
    <div
      role="status"
      data-testid="offline-banner"
      className="mb-5 flex items-center gap-3 rounded-xl border border-brass/25 bg-brass-soft/40 py-2 pl-4 pr-2 text-2xs leading-relaxed text-muted-foreground"
    >
      <CloudOff className="size-4 shrink-0 text-brass" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="font-medium text-brass">Offline.</span> You see your copy
        <span className="max-sm:hidden"> of {info.householdName}</span>, saved{" "}
        {formatSavedAt(info.savedAt)}. Changes need a connection.
      </p>
      {/* On a phone the button is the icon alone, so the line stays short. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 min-w-11 shrink-0 max-sm:px-0"
        disabled={checking}
        onClick={tryAgain}
      >
        {checking ? <Spinner /> : <RotateCw />}
        <span className="max-sm:sr-only">Try again</span>
      </Button>
    </div>
  );
}

// Pages that work from the copy. Everything else needs the server.
const OFFLINE_PAGES = [
  /^\/$/,
  /^\/items$/,
  /^\/rooms$/,
  /^\/containers$/,
  /^\/(items|rooms|containers)\/(?!new$)[^/]+$/,
  /^\/settings$/,
  /^\/settings\/(appearance|offline)$/,
];

export function worksOffline(pathname: string): boolean {
  return OFFLINE_PAGES.some((pattern) => pattern.test(pathname));
}

/**
 * Stands in for a page that needs the server while the copy is shown. A page
 * that was already open when the connection went away stays, so that a form
 * with unsaved text is not taken from the screen.
 */
export function OfflineBoundary({
  pathname,
  children,
}: {
  /** The page drawn inside. Beside an open item this is the list, not the item. */
  pathname: string;
  children: React.ReactNode;
}) {
  const { online, info } = useOfflineStatus();
  const offline = !online && info !== null;
  const openWhenLost = React.useRef<string | null>(null);
  // A page opened while already offline has nothing to lose, so it starts as "was offline".
  const wasOffline = React.useRef(offline);
  if (offline && !wasOffline.current) openWhenLost.current = pathname;
  // Back online, or the page was left: it is no longer the page to keep.
  if (!offline || openWhenLost.current !== pathname) openWhenLost.current = null;
  wasOffline.current = offline;
  if (offline && !worksOffline(pathname) && openWhenLost.current !== pathname) {
    return <OfflineUnavailable />;
  }
  return <>{children}</>;
}

function OfflineUnavailable() {
  const { checking, tryAgain } = useTryAgain();
  return (
    <div
      data-testid="offline-unavailable"
      className="surface flex flex-col items-center px-6 py-14 text-center sm:px-10 sm:py-20"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-brass-soft/60 text-brass">
        <CloudOff className="size-5" aria-hidden="true" />
      </span>
      <h1 className="mt-5 font-display text-2xl tracking-[-0.02em]">This page needs a connection</h1>
      <p className="mt-2 max-w-md text-pretty text-sm leading-relaxed text-muted-foreground">
        Your offline copy has your items, rooms and storage places. This page works again when
        Housetory can reach its server.
      </p>
      <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row">
        <Button asChild className="min-h-11">
          <Link to="/items">Go to items</Link>
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={checking}
          onClick={tryAgain}
        >
          {checking ? <Spinner /> : <RotateCw />}
          Try again
        </Button>
      </div>
    </div>
  );
}
