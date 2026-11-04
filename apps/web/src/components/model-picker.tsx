import { AlertCircle, Check, ChevronDown, Loader2, RefreshCw, Search, X } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AiProviderModel } from "@/lib/types";

const KIND_LABELS: Record<AiProviderModel["kind"], string> = {
  chat: "Chat",
  embedding: "Embedding",
  speech: "Speech",
  image: "Image",
  other: "Other",
};

const CAPABILITY_LABELS: Record<string, string> = {
  text: "Text",
  vision: "Vision",
  structured: "Structured",
  tools: "Tools",
};

export function ModelPicker({
  id,
  ariaLabel,
  value,
  models,
  onChange,
  disabled = false,
  requiredCapability,
  loading = false,
  error = null,
  cached = false,
  onDiscover,
  onRefresh,
  placeholder = "Search models",
}: {
  id?: string;
  ariaLabel: string;
  value: string;
  models: AiProviderModel[];
  onChange: (value: string) => void;
  disabled?: boolean;
  requiredCapability?: string;
  loading?: boolean;
  error?: string | null;
  cached?: boolean;
  onDiscover?: () => void;
  onRefresh?: () => void;
  placeholder?: string;
}) {
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const deferredSearch = React.useDeferredValue(search);
  const selected = models.find((model) => model.id === value);
  const chatModels = React.useMemo(
    () =>
      models.filter(
        (model) =>
          model.kind === "chat" &&
          (!requiredCapability || model.capabilities.includes(requiredCapability)),
      ),
    [models, requiredCapability],
  );
  const filtered = React.useMemo(() => {
    const term = deferredSearch.trim().toLowerCase();
    if (!term) return chatModels;
    return chatModels.filter(
      (model) =>
        model.id.toLowerCase().includes(term) ||
        (model.display_name ?? "").toLowerCase().includes(term),
    );
  }, [chatModels, deferredSearch]);
  const visible = filtered.slice(0, 50);
  const selectedUnsupported =
    models.length > 0 &&
    Boolean(value) &&
    (!selected ||
      selected.kind !== "chat" ||
      (requiredCapability ? !selected.capabilities.includes(requiredCapability) : false));
  const inputValue = open ? search : selected?.display_name ?? selected?.id ?? value;

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!wrapperRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  React.useEffect(() => {
    setActiveIndex(-1);
  }, [deferredSearch, open]);

  const choose = (model: AiProviderModel) => {
    onChange(model.id);
    setOpen(false);
    setSearch("");
    inputRef.current?.blur();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setSearch("");
      inputRef.current?.blur();
      return;
    }
    if (event.key === "ArrowDown" && visible.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => (current + 1) % visible.length);
      return;
    }
    if (event.key === "ArrowUp" && visible.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => (current <= 0 ? visible.length - 1 : current - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const active = visible[activeIndex];
      if (active) choose(active);
      else if (search.trim()) {
        onChange(search.trim());
        setOpen(false);
        setSearch("");
      }
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <Search className="pointer-events-none absolute left-3 top-[1.15rem] size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? `${id ?? ariaLabel}-model-list` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={inputValue}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          setSearch("");
        }}
        onChange={(event) => {
          setOpen(true);
          setSearch(event.target.value);
        }}
        onKeyDown={onKeyDown}
        className={cn(
          "h-10 w-full rounded-xl border border-input/90 bg-card/65 pl-8 pr-14 text-[0.8rem] text-foreground outline-none transition-[border-color,box-shadow,background-color] placeholder:text-muted-foreground focus:border-ring/50 focus:bg-card focus:ring-4 focus:ring-ring/10 disabled:cursor-not-allowed disabled:opacity-50",
        )}
      />
      <div className="absolute right-1.5 top-[1.15rem] flex -translate-y-1/2 items-center gap-0.5">
        {value ? (
          <button
            type="button"
            onClick={() => {
              onChange("");
              setOpen(false);
              setSearch("");
            }}
            className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label={`Clear ${ariaLabel}`}
          >
            <X className="size-3.5" />
          </button>
        ) : null}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </div>

      {selectedUnsupported && !open ? (
        <p className="mt-1 flex items-center gap-1 text-[0.66rem] text-brass">
          <AlertCircle className="size-3" />
          Saved model is not listed{requiredCapability ? ` as ${requiredCapability}-capable` : ""} in
          the current catalog. You can keep it or choose a replacement.
        </p>
      ) : null}

      {open ? (
        <div className="mt-1 overflow-hidden rounded-xl border border-border/80 bg-popover shadow-lift">
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[0.72rem] text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" />
              Discovering models from the provider…
            </div>
          ) : error ? (
            <div className="px-3 py-3 text-[0.72rem]" role="alert">
              <p className="flex items-center gap-1.5 text-destructive">
                <AlertCircle className="size-3.5" /> {error}
              </p>
              {onRefresh ? (
                <Button type="button" size="sm" variant="ghost" className="mt-1 h-7 px-2" onClick={onRefresh}>
                  Retry discovery
                </Button>
              ) : null}
            </div>
          ) : models.length === 0 ? (
            <div className="px-3 py-3 text-[0.72rem] text-muted-foreground">
              <p>No models discovered yet.</p>
              {onDiscover ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2 h-7 px-2"
                  onClick={onDiscover}
                >
                  <RefreshCw className="size-3" /> Discover models
                </Button>
              ) : null}
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-3 text-[0.72rem] text-muted-foreground">
              No compatible catalog model matches “{search}”. Press Enter to use that exact ID
              manually.
            </div>
          ) : (
            <>
              <div
                id={`${id ?? ariaLabel}-model-list`}
                role="listbox"
                aria-label={`${ariaLabel} suggestions`}
                className="max-h-64 overflow-y-auto p-1.5"
              >
                {visible.map((model, index) => (
                  <button
                    key={model.id}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex || model.id === value}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(model)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left",
                      index === activeIndex ? "bg-secondary" : "hover:bg-secondary/65",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[0.76rem] font-medium">
                          {model.display_name || model.id}
                        </span>
                        {model.id !== (model.display_name || model.id) ? (
                          <code className="truncate rounded bg-secondary px-1 py-0.5 text-[0.6rem] text-muted-foreground">
                            {model.id}
                          </code>
                        ) : null}
                        <Badge variant="outline" className="text-[0.55rem]">
                          {KIND_LABELS[model.kind]}
                        </Badge>
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1">
                        {model.capabilities.length > 0 ? (
                          model.capabilities.map((capability) => (
                            <Badge key={capability} variant="secondary" className="text-[0.55rem]">
                              {CAPABILITY_LABELS[capability] ?? capability}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-[0.62rem] text-muted-foreground">No task capabilities</span>
                        )}
                        <span className="text-[0.6rem] text-muted-foreground">
                          {model.capability_source === "provider_metadata"
                            ? "Provider metadata"
                            : "Heuristic — verify"}
                        </span>
                      </span>
                    </span>
                    {model.id === value ? <Check className="mt-0.5 size-3.5 shrink-0 text-sage" /> : null}
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-border/60 px-2.5 py-1.5 text-[0.62rem] text-muted-foreground">
                <span>
                  {filtered.length > visible.length
                    ? `Showing ${visible.length} of ${filtered.length}; type to narrow.`
                    : `${filtered.length} compatible model${filtered.length === 1 ? "" : "s"}`}
                  {cached ? " · cached" : ""}
                </span>
                {onRefresh ? (
                  <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-[0.62rem]" onClick={onRefresh}>
                    <RefreshCw className="size-2.5" /> Refresh
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
