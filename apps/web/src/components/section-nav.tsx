import * as React from "react";

import { cn } from "@/lib/utils";

export type SectionNavItem = { id: string; label: string };

/**
 * In-page anchor navigation with scroll-spy. Horizontally scrollable chips on
 * mobile; sticky below the top bar on desktop.
 */
export function SectionNav({
  sections,
  className,
}: {
  sections: SectionNavItem[];
  className?: string;
}) {
  const [active, setActive] = React.useState(sections[0]?.id ?? "");
  const ids = sections.map((section) => section.id).join("|");

  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const order = ids.split("|");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const first = order.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { rootMargin: "-20% 0px -60% 0px" },
    );
    for (const id of order) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [ids]);

  const go = (event: React.MouseEvent, id: string) => {
    const element = document.getElementById(id);
    if (!element) return;
    event.preventDefault();
    setActive(id);
    element.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  return (
    <nav
      aria-label="Page sections"
      data-testid="section-nav"
      className={cn(
        "-mx-5 mb-5 overflow-x-auto px-5 sm:-mx-8 sm:px-8 lg:sticky lg:top-16 lg:z-20 lg:mx-0 lg:overflow-visible lg:border-b lg:border-border/50 lg:bg-background/80 lg:px-0 lg:py-2 lg:backdrop-blur-xl",
        className,
      )}
    >
      <ul className="flex w-max items-center gap-2 lg:w-auto">
        {sections.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              onClick={(event) => go(event, section.id)}
              aria-current={active === section.id ? "location" : undefined}
              className={cn(
                "inline-flex h-8 items-center whitespace-nowrap rounded-full border px-3 text-2xs font-medium transition-colors",
                active === section.id
                  ? "border-sage/40 bg-sage-soft text-foreground"
                  : "border-border/70 text-muted-foreground hover:text-foreground",
              )}
            >
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
