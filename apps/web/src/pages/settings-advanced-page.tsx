import { Printer, Smartphone } from "lucide-react";
import { Link } from "react-router-dom";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { useCanWrite, useOverview } from "@/lib/queries";
import { formatFileSize } from "@/lib/utils";

/** Things that are rarely needed: storage, installing the app, label calibration. */
export function SettingsAdvancedPage() {
  const overview = useOverview();
  const canWrite = useCanWrite();
  const storageBytes = (overview.data?.photo_bytes ?? 0) + (overview.data?.document_bytes ?? 0);

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Settings"
        title="Advanced"
        description="Things you rarely need: storage and backup, installing the app, and label calibration."
        backTo="/settings"
        backLabel="Settings"
      />

      <div className="grid min-w-0 max-w-4xl gap-6">
        <section className="surface p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
                Storage
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Photographs and documents live on your server's persistent volume.
              </p>
            </div>
            <p className="shrink-0 text-sm tabular-nums text-foreground/80">
              {formatFileSize(storageBytes)}
            </p>
          </div>
          <p className="mt-4 text-2xs text-muted-foreground">
            Back up your database and uploads regularly with{" "}
            <code className="rounded bg-secondary px-1.5 py-0.5 text-2xs">scripts/backup.sh</code>.
          </p>
        </section>

        <details className="surface p-5 sm:p-6">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
            <Smartphone className="size-4 text-muted-foreground" strokeWidth={1.7} />
            Install on your iPhone
          </summary>
          <p className="mt-2 max-w-xl text-xs leading-relaxed text-muted-foreground">
            Open Housetory at its trusted HTTPS address — your public domain, a
            trusted LAN address, or an optional Tailscale address — in Safari, tap
            the Share button, then choose{" "}
            <span className="text-foreground">Add to Home Screen</span>. Camera
            capture and installed-PWA features require this secure context.
          </p>
        </details>

        <section className="surface p-5 sm:p-6">
          <h2 className="flex items-center gap-2 font-display text-[1.35rem] font-normal tracking-[-0.02em]">
            <Printer className="size-4 text-muted-foreground" strokeWidth={1.7} />
            Label calibration
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
            If printed labels do not line up with the sheet, print a calibration sheet
            and set the offsets. The offsets are saved in this browser.
          </p>
          {canWrite ? (
            <Button variant="outline" size="sm" className="mt-4" asChild>
              <Link to="/labels#calibration">Open label calibration</Link>
            </Button>
          ) : (
            <p className="mt-3 text-2xs text-muted-foreground">
              Viewers cannot print labels. Ask an owner for member access.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
