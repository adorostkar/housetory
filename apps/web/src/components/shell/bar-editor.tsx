import { Check, X } from "lucide-react";
import * as React from "react";
import { flushSync } from "react-dom";

import { cn } from "@/lib/utils";

/** One value to change through the bar, for example the name of a finding. */
export interface BarEditRequest {
  /** Short name of the value, shown in front of the field: "Name", "Quantity". */
  label: string;
  /** What is being changed, for screen readers: "Name of finding 2, Cordless drill". */
  description: string;
  value: string;
  inputMode?: "text" | "numeric" | "decimal";
  /** An error text keeps the editor open. Null accepts the value. */
  validate?: (value: string) => string | null;
  onCommit: (value: string) => void | Promise<void>;
  /** Gets focus back when the editor closes. Usually the value that was tapped. */
  returnFocus?: HTMLElement | null;
}

export interface BarEditor {
  /**
   * Opens the editor for a value. If another value is open and was changed, that
   * one is saved first; when it is not valid the editor stays on it and says why.
   * The same holds for a tap on any other control while the editor is open.
   */
  edit: (request: BarEditRequest) => void;
  active: boolean;
}

const BarEditorContext = React.createContext<BarEditor | null>(null);

/**
 * The editor of the nearest surface that has a bar: the page, or the assistant.
 * Null where there is none (a page rendered on its own, a plain dialog). Callers
 * then edit the value in place.
 */
export function useBarEditor(): BarEditor | null {
  return React.useContext(BarEditorContext);
}

/**
 * Hands a surface's editor to content that is shown inside that surface but is
 * rendered from another place in the React tree (a portal). Such content does not
 * find the editor by itself.
 */
export function BarEditorRelay({ editor, children }: { editor: BarEditor | null; children: React.ReactNode }) {
  return <BarEditorContext.Provider value={editor}>{children}</BarEditorContext.Provider>;
}

/**
 * Gives everything inside it a bar editor and draws that editor after its
 * children. `editorClassName` places the editor: at the bottom of the page, or at
 * the bottom of a sheet.
 */
export function BarEditorBoundary({
  children,
  editorClassName,
  onActiveChange,
  resetKey,
}: {
  children: React.ReactNode;
  editorClassName?: string;
  onActiveChange?: (active: boolean) => void;
  /** When this changes (another page), an open editor closes without saving. */
  resetKey?: string;
}) {
  const [request, setRequest] = React.useState<BarEditRequest | null>(null);
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const editorRef = React.useRef<HTMLDivElement>(null);
  const errorId = React.useId();
  // The latest values, for `edit`, which must not change identity on every key press.
  const current = React.useRef({ request, text, saving });
  current.current = { request, text, saving };

  const active = request !== null;
  React.useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  const open = React.useCallback((next: BarEditRequest) => {
    setRequest(next);
    setText(next.value);
    setError(null);
    // Select the old value, so typing replaces it and the arrow keys keep it.
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const close = React.useCallback((target: BarEditRequest | null) => {
    setRequest(null);
    setError(null);
    setSaving(false);
    const element = target?.returnFocus;
    if (element?.isConnected) window.requestAnimationFrame(() => element.focus());
  }, []);

  /** Saves the open value. Resolves to false when it was not accepted. */
  const commit = React.useCallback(async (): Promise<boolean> => {
    const { request: target, text: value } = current.current;
    if (!target) return true;
    const trimmed = value.trim();
    const problem = target.validate?.(trimmed) ?? null;
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return false;
    }
    if (trimmed === target.value.trim()) return true;
    setSaving(true);
    try {
      await target.onCommit(trimmed);
      return true;
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "This could not be saved. Try again.");
      inputRef.current?.focus();
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const edit = React.useCallback(
    (next: BarEditRequest) => {
      const { request: openRequest, saving: busy } = current.current;
      if (busy) return;
      if (!openRequest) {
        open(next);
        return;
      }
      void commit().then((accepted) => {
        if (accepted) open(next);
      });
    },
    [commit, open],
  );

  // The page the value belonged to is gone: nothing is left to save into.
  const openedFor = React.useRef(resetKey);
  React.useEffect(() => {
    if (openedFor.current === resetKey) return;
    openedFor.current = resetKey;
    close(null);
  }, [resetKey, close]);

  // A tap anywhere else first saves the open value, so that Add, Skip and the
  // like never act on the old one. This runs before the tapped control hears
  // the click, and the page is drawn again in between, so that control works
  // with the new value. A value that is not valid holds the tap back.
  React.useEffect(() => {
    if (!active) return;
    const onClick = (event: MouseEvent) => {
      const { request: target, text: typed, saving: busy } = current.current;
      if (!target) return;
      if (event.target instanceof Node && editorRef.current?.contains(event.target)) return;
      const hold = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (busy) {
        hold();
        return;
      }
      const trimmed = typed.trim();
      const problem = target.validate?.(trimmed) ?? null;
      if (problem) {
        hold();
        setError(problem);
        inputRef.current?.focus();
        return;
      }
      if (trimmed !== target.value.trim()) {
        let pending: unknown;
        try {
          flushSync(() => {
            pending = target.onCommit(trimmed);
          });
        } catch (failure) {
          hold();
          setError(failure instanceof Error && failure.message ? failure.message : "This could not be saved. Try again.");
          return;
        }
        if (pending instanceof Promise) {
          // A save that takes time: the tap waits for it and has to be repeated.
          hold();
          setSaving(true);
          pending.then(
            () => close(null),
            (failure) => {
              setSaving(false);
              setError(failure instanceof Error && failure.message ? failure.message : "This could not be saved. Try again.");
              inputRef.current?.focus();
            },
          );
          return;
        }
      }
      flushSync(() => close(null));
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [active, close]);

  const value = React.useMemo(() => ({ edit, active }), [edit, active]);

  return (
    <BarEditorContext.Provider value={value}>
      {children}
      {request && (
        <div
          ref={editorRef}
          role="group"
          aria-label={`Edit ${request.description}`}
          data-testid="bar-editor"
          data-always-on-screen
          className={cn("border-t border-border/70 bg-background/95 backdrop-blur-xl", editorClassName)}
        >
          {error && (
            <p id={errorId} role="alert" className="px-2 pb-1.5 text-xs font-medium text-destructive">
              {error}
            </p>
          )}
          <form
            className="mx-auto flex w-full max-w-[1224px] items-center gap-2"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const target = request;
              void commit().then((accepted) => {
                if (accepted) close(target);
              });
            }}
          >
            <div
              className={cn(
                "flex h-12 min-w-0 flex-1 items-center rounded-2xl border bg-card ring-4",
                error ? "border-destructive/70 ring-destructive/10" : "border-ring/50 ring-ring/10",
              )}
            >
              <span
                aria-hidden="true"
                className="ml-1.5 flex h-8 max-w-[45%] shrink-0 items-center rounded-full bg-accent px-2.5 text-xs font-medium text-accent-foreground"
              >
                <span className="truncate">{request.label}</span>
              </span>
              <input
                ref={inputRef}
                value={text}
                inputMode={request.inputMode ?? "text"}
                enterKeyHint="done"
                autoComplete="off"
                dir="auto"
                aria-label={request.description}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                disabled={saving}
                onChange={(event) => {
                  setText(event.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  close(request);
                }}
                className="h-full min-w-0 flex-1 bg-transparent px-2 text-[1rem] text-foreground outline-none"
              />
            </div>
            <button
              type="button"
              aria-label="Cancel editing"
              title="Cancel"
              onClick={() => close(request)}
              className="flex size-12 shrink-0 items-center justify-center rounded-full border border-input bg-card text-foreground hover:bg-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
            <button
              type="submit"
              aria-label={`Save ${request.label.toLowerCase()}`}
              title="Save"
              disabled={saving}
              className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lift hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
            >
              <Check aria-hidden="true" className="size-5" strokeWidth={2.4} />
            </button>
          </form>
        </div>
      )}
    </BarEditorContext.Provider>
  );
}
