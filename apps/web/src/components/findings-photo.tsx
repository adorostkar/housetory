
import { cn } from "@/lib/utils";

/** Where a finding is on the photo, in fractions of the shown picture (0 to 1). */
export interface SourceRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PhotoFinding {
  id: string;
  /** The number on the pin. It is the number of the finding's row. */
  number: number;
  name: string;
  region?: SourceRegion | null;
}

/**
 * A region is used only when it is real: four finite numbers inside the picture, with
 * a size. Anything else means that the place of the finding is not known.
 */
export function usableRegion(region: SourceRegion | null | undefined): SourceRegion | null {
  if (!region || typeof region !== "object") return null;
  const { x, y, width, height } = region;
  const numbers = [x, y, width, height];
  if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  if (x < 0 || y < 0 || width <= 0 || height <= 0) return null;
  if (x + width > 1.0001 || y + height > 1.0001) return null;
  return region;
}

/**
 * The photo of a recognition with a numbered pin for every finding whose position is
 * known. A finding without a position gets no pin, and a quiet line says so. A pin is
 * never drawn at a made-up place.
 */
export function FindingsPhoto({
  src,
  alt,
  findings,
  activeId,
  onActivate,
  onPoint,
  className,
}: {
  src: string;
  alt: string;
  findings: PhotoFinding[];
  /** The finding that is pointed at now, from a row or from a pin. */
  activeId: string | null;
  /** A pin was pressed: go to the row of this finding. */
  onActivate: (id: string) => void;
  /** The pointer or the focus is on a pin. */
  onPoint?: (id: string) => void;
  className?: string;
}) {
  const placed = findings
    .map((finding) => ({ ...finding, region: usableRegion(finding.region) }))
    .filter((finding): finding is PhotoFinding & { region: SourceRegion } => finding.region !== null);
  const missing = findings.length - placed.length;
  const active = placed.find((finding) => finding.id === activeId);
  return (
    <figure className={cn("space-y-2", className)}>
      <div className="text-center">
        <div className="relative inline-block max-w-full align-top">
          <img
            src={src}
            alt={alt}
            className="block max-h-80 max-w-full rounded-2xl border border-border/60 bg-secondary/30"
          />
          {active && (
            <span
              aria-hidden="true"
              data-testid="finding-region"
              className="pointer-events-none absolute rounded-md border-2 border-primary shadow-[0_0_0_2px_hsl(var(--background))]"
              style={{
                left: `${active.region.x * 100}%`,
                top: `${active.region.y * 100}%`,
                width: `${active.region.width * 100}%`,
                height: `${active.region.height * 100}%`,
              }}
            />
          )}
          {placed.map((finding) => {
            const marked = finding.id === activeId;
            return (
              <button
                key={finding.id}
                type="button"
                aria-label={`Finding ${finding.number}: ${finding.name || "no name"}`}
                aria-pressed={marked}
                data-finding-pin={finding.id}
                onClick={() => onActivate(finding.id)}
                onFocus={() => onPoint?.(finding.id)}
                onMouseEnter={() => onPoint?.(finding.id)}
                className="group absolute flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-none"
                style={{
                  left: `${(finding.region.x + finding.region.width / 2) * 100}%`,
                  top: `${(finding.region.y + finding.region.height / 2) * 100}%`,
                }}
              >
                {/* The ring in the background colour keeps the pin readable on any photo. */}
                <span
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full border-2 border-background bg-primary text-xs font-semibold tabular-nums text-primary-foreground shadow-md transition-transform group-focus-visible:ring-2 group-focus-visible:ring-ring",
                    marked && "scale-125 ring-2 ring-background",
                  )}
                >
                  {finding.number}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {findings.length > 0 && missing > 0 && (
        <figcaption className="text-center text-xs text-muted-foreground">
          {placed.length === 0
            ? "Positions are not available for this photo."
            : `${missing} of ${findings.length} findings ${missing === 1 ? "is" : "are"} not marked on the photo: ${missing === 1 ? "its position is" : "their positions are"} not known.`}
        </figcaption>
      )}
    </figure>
  );
}
