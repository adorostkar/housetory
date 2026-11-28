import { CloudOff, RotateCw, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { formatSavedAt } from "@/components/offline-banner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  checkConnection,
  disableOfflineCopy,
  enableOfflineCopy,
  setOfflinePhotos,
  syncOfflineCopy,
  useOfflineStatus,
} from "@/lib/offline/controller";
import { useSession } from "@/lib/queries";
import { pluralize } from "@/lib/utils";

/** The offline copy on this device: on or off, what it holds, and removing it. */
export function SettingsOfflinePage() {
  const status = useOfflineStatus();
  const session = useSession();
  const [busy, setBusy] = React.useState(false);
  const household = session.data?.household?.name ?? "this household";
  const offline = !status.online;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const blocked = !status.supported
    ? "This browser cannot keep an offline copy here. Open Housetory at an https address (or on this computer itself) and try again."
    : !status.allowed && !offline
      ? "The owner of this household does not allow offline copies for your role."
      : null;

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Settings"
        title="Offline copy"
        description="Look up your things when this device cannot reach your Housetory server."
        backTo="/settings"
        backLabel="Settings"
      />

      <div className="grid min-w-0 max-w-2xl gap-6">
        <section className="surface p-5 sm:p-6">
          {/* A label, so a tap anywhere on the line works the switch. */}
          <label className="flex items-start gap-4">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">
                Keep a copy on this device
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                A copy of {household} is saved on this device. Without a connection you can
                look and search in it. You cannot change anything until you are connected
                again.
              </span>
            </span>
            <Switch
              aria-label="Keep a copy on this device"
              checked={status.enabled}
              disabled={busy || (!status.enabled && blocked !== null) || (offline && !status.enabled)}
              onCheckedChange={(checked) =>
                void run(async () => {
                  if (checked) {
                    await enableOfflineCopy(true);
                    toast.success("Offline copy is on");
                  } else {
                    await disableOfflineCopy();
                    toast.success("Offline copy removed from this device");
                  }
                })
              }
            />
          </label>

          {blocked && (
            <p
              role="note"
              className="mt-4 rounded-xl border border-brass/25 bg-brass-soft/40 px-4 py-3 text-2xs leading-relaxed text-muted-foreground"
            >
              {blocked}
            </p>
          )}

          <ul className="mt-5 grid gap-2 text-xs leading-relaxed text-muted-foreground">
            <li>It is off until you turn it on, and it is for this device only.</li>
            <li>
              Saved: items, rooms, storage places and who has borrowed what. Not saved:
              documents, purchases and the assistant.
            </li>
            <li>
              The copy is removed when you sign out, when you turn this off, and after 30 days
              without a connection.
            </li>
            <li>
              Anyone who can open this device can read the copy. Use it only on a device with
              a screen lock.
            </li>
          </ul>
        </section>

        {status.enabled && (
          <section className="surface p-5 sm:p-6" aria-labelledby="offline-copy-state">
            <h2 id="offline-copy-state" className="text-sm font-medium text-foreground">
              The copy on this device
            </h2>
            <div data-testid="offline-copy-state" className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {status.info ? (
                <p>
                  {status.info.householdName}: {pluralize(status.info.itemCount, "item")}, saved{" "}
                  {formatSavedAt(status.info.savedAt)}.
                </p>
              ) : status.syncing ? (
                <p>Saving the first copy…</p>
              ) : (
                <p>No copy is saved yet.</p>
              )}
              {status.photoProgress && status.photos && (
                <p>
                  Photos: {status.photoProgress.saved} of {status.photoProgress.total} saved.
                </p>
              )}
              {offline && (
                <p className="mt-2 flex items-center gap-2 text-brass">
                  <CloudOff className="size-3.5" aria-hidden="true" />
                  No connection now. The copy is updated when you are connected again.
                </p>
              )}
              {status.info && !status.appReady && !status.syncing && (
                <p className="mt-2 text-brass">
                  The app itself is not saved on this device yet. Reload this page once while
                  you are connected. Until then the copy works only while Housetory stays open.
                </p>
              )}
              {status.syncError && <p className="mt-2 text-destructive">{status.syncError}</p>}
            </div>

            <label className="mt-5 flex items-start gap-4">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">Save photos too</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  One small photo for each item. It uses more space and more data.
                </span>
              </span>
              <Switch
                aria-label="Save photos too"
                checked={status.photos}
                disabled={busy || offline}
                onCheckedChange={(checked) => void run(() => setOfflinePhotos(checked))}
              />
            </label>

            <div className="mt-5 flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={busy || status.syncing}
                onClick={() =>
                  void run(async () => {
                    if (offline && !(await checkConnection())) {
                      toast.error("Still no connection to your Housetory server.");
                      return;
                    }
                    await syncOfflineCopy();
                  })
                }
              >
                {status.syncing ? <Spinner /> : <RotateCw />}
                Update now
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await disableOfflineCopy();
                    toast.success("Offline copy removed from this device");
                  })
                }
              >
                <Trash2 />
                Remove from this device
              </Button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
