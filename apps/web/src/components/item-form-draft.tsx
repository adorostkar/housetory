import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  ITEM_DRAFTS_CLEARED_EVENT,
  clearItemDraft,
  itemFormFingerprint,
  readItemDraft,
  saveItemDraft,
  type ItemDraft,
  type ItemDraftScope,
  type ItemFormValues,
} from "@/lib/item-drafts";
import { useNavigationGuard } from "@/lib/navigation-guard";
import { useSession } from "@/lib/queries";

export const ITEM_DRAFT_SAVE_DELAY_MS = 500;

/**
 * Tracks whether the item form has unsaved input, guards navigation away from
 * it, and keeps a recoverable local draft while it is dirty. The draft is tied
 * to the account, household and form the component was opened with.
 */
export function useItemFormProtection({
  formId,
  values,
  itemUpdatedAt,
}: {
  formId: string;
  values: ItemFormValues;
  itemUpdatedAt: string | null;
}) {
  const session = useSession().data;
  const userId = session?.user?.id;
  const householdId = session?.household?.id;
  // Frozen at open: a later household switch must not redirect this form's
  // draft into another household's storage.
  const [scope] = React.useState<ItemDraftScope | null>(() =>
    userId && householdId ? { userId, householdId, formId } : null,
  );
  const [opened] = React.useState(() => ({
    fingerprint: itemFormFingerprint(values),
    itemUpdatedAt,
  }));
  const dirty = itemFormFingerprint(values) !== opened.fingerprint;

  const [offer, setOffer] = React.useState<ItemDraft | null>(() => {
    if (!scope) return null;
    const draft = readItemDraft(scope);
    if (!draft) return null;
    if (itemFormFingerprint(draft.values) === opened.fingerprint) {
      clearItemDraft(scope);
      return null;
    }
    return draft;
  });

  const finished = React.useRef(false);
  const wrote = React.useRef(false);
  const draftBase = React.useRef(opened.itemUpdatedAt);
  const latest = React.useRef({ values, dirty, offer });
  latest.current = { values, dirty, offer };

  const persist = React.useCallback(() => {
    const current = latest.current;
    // An offered draft is never overwritten before the user has decided on it.
    if (!scope || finished.current || current.offer || !current.dirty) return;
    if (saveItemDraft(scope, current.values, draftBase.current)) wrote.current = true;
  }, [scope]);

  const serialized = JSON.stringify(values);
  React.useEffect(() => {
    if (!scope || offer || finished.current) return;
    if (!dirty) {
      if (wrote.current) {
        clearItemDraft(scope);
        wrote.current = false;
      }
      return;
    }
    const timer = window.setTimeout(persist, ITEM_DRAFT_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [serialized, dirty, offer, scope, persist]);

  // The page can be frozen or killed without warning (notably on iOS), so the
  // draft is also flushed whenever the page is hidden and when the form unmounts.
  React.useEffect(() => {
    const onPageHide = () => persist();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") persist();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      persist();
    };
  }, [persist]);

  const finish = React.useCallback(
    (clear: boolean) => {
      finished.current = true;
      if (scope && clear) clearItemDraft(scope);
    },
    [scope],
  );

  // Discarding the current input leaves a draft that is still on offer alone.
  const releaseGuard = useNavigationGuard(dirty, () => finish(!latest.current.offer));

  // Sign-out wipes every draft; this form must neither write its draft back
  // nor hold up the navigation that follows.
  React.useEffect(() => {
    const onCleared = () => {
      finished.current = true;
      releaseGuard();
      setOffer(null);
    };
    window.addEventListener(ITEM_DRAFTS_CLEARED_EVENT, onCleared);
    return () => window.removeEventListener(ITEM_DRAFTS_CLEARED_EVENT, onCleared);
  }, [releaseGuard]);

  return {
    dirty,
    draftOffer: offer
      ? {
          savedAt: offer.savedAt,
          itemChanged:
            offer.itemUpdatedAt !== null &&
            opened.itemUpdatedAt !== null &&
            offer.itemUpdatedAt !== opened.itemUpdatedAt,
        }
      : null,
    /** Returns the stored values to put back into the form. */
    restoreDraft: (): ItemFormValues | null => {
      if (!offer) return null;
      draftBase.current = offer.itemUpdatedAt;
      wrote.current = true;
      setOffer(null);
      return offer.values;
    },
    discardDraft: () => {
      if (scope) clearItemDraft(scope);
      setOffer(null);
    },
    /** Call after a successful save, before navigating away. */
    markSaved: () => {
      finish(true);
      releaseGuard();
    },
    /** Call when the user explicitly abandons the form, before navigating away. */
    discardChanges: () => {
      finish(!latest.current.offer);
      releaseGuard();
    },
  };
}

export function ItemDraftBanner({
  savedAt,
  itemChanged,
  onRestore,
  onDiscard,
}: {
  savedAt: number;
  itemChanged: boolean;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  const titleId = React.useId();
  const saved = new Date(savedAt);
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brass/20 bg-brass-soft/60 px-3.5 py-3"
    >
      <div className="min-w-0 flex-1 basis-56">
        <h2 id={titleId} className="text-sm font-medium">
          Unsaved draft found
        </h2>
        <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">
          Saved on this device{" "}
          <time dateTime={saved.toISOString()}>
            {new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(saved)}
          </time>
          . Restoring replaces what is in the form now.
        </p>
        {itemChanged && (
          <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
            This item has changed since the draft was saved. Saving a restored
            draft overwrites those newer details.
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onRestore}>Restore draft</Button>
        <Button variant="outline" onClick={onDiscard}>
          Discard draft
        </Button>
      </div>
    </section>
  );
}
