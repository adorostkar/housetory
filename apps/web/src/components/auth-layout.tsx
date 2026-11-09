import { LockKeyhole } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";

export function AuthLayout({
  children,
  title,
  subtitle,
}: {
  children: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="grid min-h-[100dvh] lg:grid-cols-[minmax(0,1.04fr)_minmax(0,1fr)]">
      <aside className="relative hidden overflow-hidden bg-[#1E201B] text-[#F3EFE4] lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            backgroundImage:
              "radial-gradient(40rem 30rem at 15% 0%, rgba(181,139,90,0.16), transparent 65%), radial-gradient(36rem 32rem at 100% 100%, rgba(143,156,132,0.14), transparent 70%)",
          }}
        />
        <ArchBackdrop className="pointer-events-none absolute -bottom-24 -right-20 h-[34rem] w-[34rem] text-[#F3EFE4]/10" />

        <div className="relative flex items-center gap-2.5">
          <span className="inline-flex size-9 items-center justify-center rounded-[11px] bg-[#F3EFE4] text-[#23251F]">
            <BrandGlyph />
          </span>
          <span className="font-display text-[1.4rem] tracking-[-0.02em]">Housetory</span>
        </div>

        <div className="relative max-w-md pb-10">
          <p className="mb-5 text-2xs font-semibold uppercase tracking-[0.18em] text-[#F3EFE4]/50">
            Everything has a place
          </p>
          <h1 className="font-display text-[3.25rem] font-normal leading-[1.04] tracking-[-0.035em] text-[#F6F2E9]">
            A quieter way to know what you own.
          </h1>
          <p className="mt-6 max-w-sm text-pretty text-[0.95rem] leading-relaxed text-[#F3EFE4]/62">
            Rooms, shelves, photographs, receipts and warranties — kept together
            with the care your home deserves.
          </p>
        </div>

        <div className="relative flex items-center gap-2.5 text-2xs text-[#F3EFE4]/45">
          <LockKeyhole className="size-3.5" strokeWidth={1.6} />
          Private by design. Hosted on your own server.
        </div>
      </aside>

      <main className="relative flex min-h-[100dvh] flex-col px-5 py-6 sm:px-10 sm:py-8 lg:px-16">
        <div className="flex items-center lg:hidden">
          <BrandMark />
        </div>
        <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center py-14 lg:py-10">
          <div className="animate-fade-up">
            <p className="eyebrow mb-3">Welcome</p>
            <h1 className="font-display text-[2.6rem] font-normal leading-[1.06] tracking-[-0.035em] sm:text-[3rem]">
              {title}
            </h1>
            <p className="mt-3.5 text-pretty text-[0.92rem] leading-relaxed text-muted-foreground">
              {subtitle}
            </p>
            <div className="mt-9">{children}</div>
          </div>
        </div>
        <p className="mt-auto pt-8 text-center text-2xs tracking-[0.01em] text-muted-foreground lg:text-left">
          Housetory · Your home, considered.
        </p>
      </main>
    </div>
  );
}

function BrandGlyph() {
  return (
    <svg viewBox="0 0 40 40" className="size-6" fill="none" aria-hidden="true">
      <path
        d="M12.25 29.5V19.35c0-5.02 3.47-9.1 7.75-9.1s7.75 4.08 7.75 9.1V29.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M15.6 21.4h8.8M15.6 26.1h8.8"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.85"
      />
      <circle cx="20" cy="17.8" r="1.25" fill="#B58B5A" />
    </svg>
  );
}

function ArchBackdrop({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 500 500" className={className} fill="none" aria-hidden="true">
      <path
        d="M120 470V240c0-72 58-130 130-130s130 58 130 130v230"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M170 470V250c0-44 36-80 80-80s80 36 80 80v220"
        stroke="currentColor"
        strokeWidth="1.2"
        opacity="0.6"
      />
      <path
        d="M215 320h70M215 385h70M215 450h70"
        stroke="currentColor"
        strokeWidth="1.4"
        opacity="0.7"
      />
      <circle cx="250" cy="300" r="9" fill="currentColor" opacity="0.9" />
    </svg>
  );
}
