import type { ReactElement, SVGProps } from "react";

import { cn } from "@/lib/utils";

export const BUILTIN_ILLUSTRATION_LABELS: Record<string, string> = {
  drill: "Power drill",
  tv: "Television",
  "ethernet-cable": "Ethernet cable",
  suitcase: "Suitcase",
  box: "Storage box",
  chair: "Chair",
  sofa: "Sofa",
  camera: "Camera",
  laptop: "Laptop",
  kettle: "Kettle",
  bicycle: "Bicycle",
  book: "Book",
  generic: "Generic item",
};

function Drill() {
  return (
    <>
      <path d="M38 52h58l18 8v14H58L38 66z" />
      <path d="M114 57l18 5v10l-18 5" />
      <path d="M58 66l-18 20h22l16-20" />
      <path d="M62 40h34M64 34v12" />
    </>
  );
}

function Television() {
  return (
    <>
      <rect x="22" y="24" width="116" height="68" rx="6" />
      <path d="M70 104h20M80 92v12" />
      <path d="M38 40h64M38 50h36" opacity=".55" />
    </>
  );
}

function EthernetCable() {
  return (
    <>
      <rect x="28" y="44" width="44" height="32" rx="4" />
      <path d="M38 52v16M46 52v16M54 52v16M62 52v16" />
      <path d="M72 60c20 0 18-24 38-24h14" />
      <rect x="118" y="30" width="18" height="18" rx="3" />
    </>
  );
}

function Suitcase() {
  return (
    <>
      <rect x="28" y="38" width="104" height="62" rx="8" />
      <path d="M62 38v-8h36v8M58 100v8M102 100v8M46 55v28" />
      <circle cx="52" cy="105" r="3" />
      <circle cx="108" cy="105" r="3" />
    </>
  );
}

function Box() {
  return (
    <>
      <path d="M30 48l50-22 50 22-50 22z" />
      <path d="M30 48v42l50 22 50-22V48M80 70v42" />
      <path d="M55 37l50 23M55 72l50-22" opacity=".45" />
    </>
  );
}

function Chair() {
  return (
    <>
      <path d="M52 24h56v54H52zM44 78h72v12H44z" />
      <path d="M54 90v18M106 90v18M52 60h56" />
    </>
  );
}

function Sofa() {
  return (
    <>
      <path d="M28 54h104v38H28zM28 66v-8c0-8 6-14 14-14h76c8 0 14 6 14 14v8" />
      <path d="M52 54v38M108 54v38M40 92v10M120 92v10" />
    </>
  );
}

function Camera() {
  return (
    <>
      <rect x="24" y="42" width="112" height="56" rx="8" />
      <circle cx="80" cy="70" r="20" />
      <circle cx="80" cy="70" r="10" opacity=".5" />
      <path d="M48 42l8-12h32l8 12M118 54h6" />
    </>
  );
}

function Laptop() {
  return (
    <>
      <path d="M44 30h72v54H44zM28 92h104l-8 10H36z" />
      <path d="M58 44h44M58 54h30" opacity=".5" />
    </>
  );
}

function Kettle() {
  return (
    <>
      <path d="M46 52h58l-6 52H52zM46 52c0-8 6-14 14-14h30c8 0 14 6 14 14" />
      <path d="M104 60c20 0 20 30 4 32M48 32l-10-8M64 96h22" />
    </>
  );
}

function Bicycle() {
  return (
    <>
      <circle cx="42" cy="82" r="22" />
      <circle cx="118" cy="82" r="22" />
      <path d="M42 82l24-40h26l26 40M66 42h40M80 42l38 40M64 82h46" />
      <path d="M100 34h16" />
    </>
  );
}

function Book() {
  return (
    <>
      <path d="M22 34c18-8 36-8 58 2v60c-22-10-40-10-58-2z" />
      <path d="M138 34c-18-8-36-8-58 2v60c22-10 40-10 58-2z" />
      <path d="M38 46c10-3 20-3 30 1M38 60c10-3 20-3 30 1M92 47c10-4 20-4 30-1M92 61c10-4 20-4 30-1" opacity=".45" />
    </>
  );
}

function Generic() {
  return (
    <>
      <path d="M32 44l48-20 48 20-48 22zM32 44v44l48 22 48-22V44M80 66v44" />
      <path d="M58 34l48 22M58 68l48-22" opacity=".35" />
    </>
  );
}

const ILLUSTRATIONS: Record<string, () => ReactElement> = {
  drill: Drill,
  tv: Television,
  "ethernet-cable": EthernetCable,
  suitcase: Suitcase,
  box: Box,
  chair: Chair,
  sofa: Sofa,
  camera: Camera,
  laptop: Laptop,
  kettle: Kettle,
  bicycle: Bicycle,
  book: Book,
  generic: Generic,
};

export function BuiltinIllustration({
  illustrationKey,
  label,
  className,
  ...props
}: {
  illustrationKey: string;
  label?: string;
  className?: string;
} & Omit<SVGProps<SVGSVGElement>, "children">) {
  const Illustration = ILLUSTRATIONS[illustrationKey] ?? Generic;
  const accessibleLabel =
    label ?? BUILTIN_ILLUSTRATION_LABELS[illustrationKey] ?? "Generic illustration";
  return (
    <span
      className={cn(
        "flex size-full items-center justify-center bg-[radial-gradient(circle_at_30%_20%,hsl(var(--secondary)/.9),hsl(var(--card)/.65))]",
        className,
      )}
      role="img"
      aria-label={accessibleLabel}
    >
      <svg
        viewBox="0 0 160 120"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-[72%] w-[72%] text-foreground/45"
        aria-hidden="true"
        {...props}
      >
        <Illustration />
      </svg>
    </span>
  );
}
