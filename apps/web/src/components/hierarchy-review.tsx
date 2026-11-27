import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  FolderTree,
  Package,
  Plus,
  ShieldCheck,
} from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReviewRow } from "@/components/review-row";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  ImportDecision,
  ImportEntityType,
  ImportEntry,
  ProposedItem,
} from "@/lib/types";

const ENTITY_LABELS: Record<ImportEntityType, string> = {
  room: "Room",
  container: "Container",
  location: "Fixed location",
  item: "Item",
};

const ENTITY_TONE: Record<ImportEntityType, "sage" | "brass" | "outline" | "secondary"> = {
  room: "sage",
  container: "brass",
  location: "outline",
  item: "secondary",
};

function entryType(entry: ImportEntry): ImportEntityType {
  return (entry.entity_type as ImportEntityType | undefined) ?? "item";
}

function effectiveDecision(entry: ImportEntry, decisions: Record<string, ImportDecision>): ImportDecision {
  return (
    decisions[entry.id] ?? {
      include: false,
      action: "import",
      mergeItemId: "",
      mergeFields: [],
    }
  );
}

function effectiveParent(
  entry: ImportEntry,
  decisions: Record<string, ImportDecision>,
): string | null {
  const decision = decisions[entry.id];
  if (decision && decision.parentEntryId !== undefined) return decision.parentEntryId;
  return entry.parent_entry_id ?? null;
}

function effectiveType(
  entry: ImportEntry,
  decisions: Record<string, ImportDecision>,
): ImportEntityType {
  return decisions[entry.id]?.entityType ?? entryType(entry);
}

function collectDescendants(
  id: string,
  children: Map<string, ImportEntry[]>,
): string[] {
  const result: string[] = [];
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const entry = stack.pop();
    if (!entry) continue;
    result.push(entry.id);
    stack.push(...(children.get(entry.id) ?? []));
  }
  return result;
}

export function HierarchyReview({
  entries,
  edits,
  decisions,
  disabled,
  onEdit,
  onDecision,
  onAdd,
  onSkip,
  onReject,
  onRestore,
  pendingIds,
  nameErrors,
}: {
  entries: ImportEntry[];
  edits: Record<string, ProposedItem>;
  decisions: Record<string, ImportDecision>;
  disabled: boolean;
  onEdit: (entryId: string, proposed: ProposedItem) => void;
  onDecision: (entryId: string, decision: ImportDecision) => void;
  /** Add this one record now. Its parent must be added already, or be added first. */
  onAdd?: (entryId: string) => void;
  onSkip?: (entryId: string) => void;
  onReject?: (entryId: string) => void;
  onRestore?: (entryId: string) => void;
  pendingIds?: ReadonlySet<string>;
  nameErrors?: Record<string, string | undefined>;
}) {
  const actions: RowActions = { onAdd, onSkip, onReject, onRestore, pendingIds, nameErrors };
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const entriesById = React.useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  );
  const children = React.useMemo(() => {
    const map = new Map<string, ImportEntry[]>();
    for (const entry of entries) {
      const parentId = effectiveParent(entry, decisions);
      if (!parentId || !entriesById.has(parentId)) continue;
      const bucket = map.get(parentId) ?? [];
      bucket.push(entry);
      map.set(parentId, bucket);
    }
    for (const bucket of map.values()) {
      bucket.sort((left, right) => left.position - right.position);
    }
    return map;
  }, [entries, decisions, entriesById]);

  const roots = React.useMemo(
    () =>
      entries
        .filter((entry) => {
          const parentId = effectiveParent(entry, decisions);
          return !parentId || !entriesById.has(parentId);
        })
        .sort((left, right) => left.position - right.position),
    [entries, decisions, entriesById],
  );

  const toggleCollapse = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const includeBranch = (entry: ImportEntry, include: boolean) => {
    const ids = [entry.id, ...collectDescendants(entry.id, children)];
    const inherited = include ? ancestorsOf(entry.id, entriesById, decisions) : [];
    for (const id of new Set([...ids, ...inherited])) {
      const target = entriesById.get(id);
      if (!target || !["proposed", "failed"].includes(target.status)) continue;
      const current = effectiveDecision(target, decisions);
      onDecision(id, {
        ...current,
        include,
        action: current.action === "skip" && include ? "import" : current.action,
      });
    }
  };

  return (
    <div className="space-y-2" aria-label="Proposed hierarchy">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border/60 bg-secondary/25 px-3 py-2 text-2xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <FolderTree className="size-3.5 text-sage" /> Rooms and containers are created in
          dependency order.
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CornerDownRight className="size-3.5 text-brass" /> Selecting a branch selects its
          contents.
        </span>
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="size-3.5" /> Nothing is added until you add it.
        </span>
      </div>
      {roots.map((entry) => (
        <HierarchyRow
          key={entry.id}
          entry={entry}
          depth={0}
          entriesById={entriesById}
          children={children}
          edits={edits}
          decisions={decisions}
          collapsed={collapsed}
          disabled={disabled}
          onToggleCollapse={toggleCollapse}
          onEdit={onEdit}
          onDecision={onDecision}
          onIncludeBranch={includeBranch}
          actions={actions}
        />
      ))}
    </div>
  );
}

interface RowActions {
  onAdd?: (entryId: string) => void;
  onSkip?: (entryId: string) => void;
  onReject?: (entryId: string) => void;
  onRestore?: (entryId: string) => void;
  pendingIds?: ReadonlySet<string>;
  nameErrors?: Record<string, string | undefined>;
}

function ancestorsOf(
  id: string,
  entriesById: Map<string, ImportEntry>,
  decisions: Record<string, ImportDecision>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let cursor = entriesById.get(id);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const parentId = effectiveParent(cursor, decisions);
    if (!parentId) break;
    const parent = entriesById.get(parentId);
    if (!parent) break;
    result.push(parent.id);
    cursor = parent;
  }
  return result;
}

function descendantsOf(
  id: string,
  children: Map<string, ImportEntry[]>,
): Set<string> {
  return new Set(collectDescendants(id, children));
}

function HierarchyRow({
  entry,
  depth,
  entriesById,
  children,
  edits,
  decisions,
  collapsed,
  disabled,
  onToggleCollapse,
  onEdit,
  onDecision,
  onIncludeBranch,
  actions,
}: {
  entry: ImportEntry;
  depth: number;
  entriesById: Map<string, ImportEntry>;
  children: Map<string, ImportEntry[]>;
  edits: Record<string, ProposedItem>;
  decisions: Record<string, ImportDecision>;
  collapsed: Set<string>;
  disabled: boolean;
  onToggleCollapse: (id: string) => void;
  onEdit: (entryId: string, proposed: ProposedItem) => void;
  onDecision: (entryId: string, decision: ImportDecision) => void;
  onIncludeBranch: (entry: ImportEntry, include: boolean) => void;
  actions: RowActions;
}) {
  const [editing, setEditing] = React.useState(false);
  const proposed = edits[entry.id] ?? entry.proposed;
  const decision = effectiveDecision(entry, decisions);
  const type = effectiveType(entry, decisions);
  const parentId = effectiveParent(entry, decisions);
  const parent = parentId ? entriesById.get(parentId) : null;
  const nodeChildren = children.get(entry.id) ?? [];
  // A failed record stays open: it can be corrected and added again.
  const final = ["imported", "merged", "skipped", "rejected"].includes(entry.status);
  const skipped = entry.status === "skipped" || entry.status === "rejected";
  const highDuplicate = entry.duplicate_candidates.some(
    (candidate) => candidate.score >= 55,
  );
  const ambiguous =
    entry.confidence != null && entry.confidence < 70;
  const collapsedNow = collapsed.has(entry.id);
  const excludedDescendants = descendantsOf(entry.id, children);
  const parentOptions = [...entriesById.values()]
    .filter((candidate) => {
      if (candidate.id === entry.id) return false;
      if (effectiveType(candidate, decisions) === "item") return false;
      if (excludedDescendants.has(candidate.id)) return false;
      return true;
    })
    .sort((left, right) => left.position - right.position);

  const update = (patch: Partial<ProposedItem>) =>
    onEdit(entry.id, { ...proposed, ...patch });
  const setDecision = (patch: Partial<ImportDecision>) =>
    onDecision(entry.id, { ...decision, ...patch });

  return (
    <div>
      <ReviewRow
        style={{ marginLeft: `${depth * 14}px` }}
        className={final ? "opacity-80" : undefined}
        title={proposed.name}
        titleLabel={`Name of ${proposed.name || entry.proposed.name || "this record"}`}
        onTitleChange={final ? undefined : (name) => update({ name })}
        titleValidate={(value) => (value ? null : "Give this record a name.")}
        quantityValidate={(value) =>
          /^\d+$/.test(value) && Number(value) <= 1_000_000 ? null : "Enter a whole number, 0 or more."}
        titleError={actions.nameErrors?.[entry.id]}
        quantity={type === "item" || type === "container" ? proposed.quantity : null}
        onQuantityChange={!final && type === "item"
          ? (value) => update({ quantity: value === "" ? 0 : Number(value) })
          : undefined}
        disabled={disabled || final}
        thumbnail={nodeChildren.length > 0 ? (
          <button
            type="button"
            className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground lg:size-8"
            onClick={() => onToggleCollapse(entry.id)}
            aria-label={collapsedNow ? "Expand branch" : "Collapse branch"}
            aria-expanded={!collapsedNow}
          >
            {collapsedNow ? (
              <ChevronRight className="size-4" />
            ) : (
              <ChevronDown className="size-4" />
            )}
          </button>
        ) : (
          <span className="flex size-8 items-center justify-center text-muted-foreground">
            {type === "item" ? <Package className="size-3.5" /> : <CornerDownRight className="size-3.5" />}
          </span>
        )}
        selection={final || !actions.onAdd
          ? undefined
          : {
              checked: decision.include,
              onChange: (include) => onIncludeBranch(entry, include),
              label: `Select ${proposed.name}${nodeChildren.length ? " and its contents" : ""}`,
            }}
        badges={
          <>
            <Badge variant={ENTITY_TONE[type]}>{ENTITY_LABELS[type]}</Badge>
            {entry.legacy_identifier && (
              <Badge variant="outline">{entry.legacy_identifier}</Badge>
            )}
            {highDuplicate && !final && (
              <Badge variant="brass">
                <AlertTriangle className="size-3" /> Possible duplicate
              </Badge>
            )}
          </>
        }
        values={[
          { label: "In", value: parent ? parent.proposed.name : "Top level" },
          ...(entry.confidence != null
            ? [{ label: "Confidence", value: `${entry.confidence}%`, uncertain: ambiguous }]
            : []),
        ]}
        error={entry.error}
        extra={
          <>
            {highDuplicate && !final && (
              <div className="rounded-lg border border-brass/25 bg-brass-soft/40 px-2.5 py-2 text-2xs text-muted-foreground">
                <p className="font-medium text-foreground/80">Existing item may match</p>
                {entry.duplicate_candidates
                  .filter((candidate) => candidate.score >= 55)
                  .map((candidate) => (
                    <p key={candidate.item_id} className="mt-1">
                      {candidate.name} · {candidate.room_name ?? "No room"} ·{" "}
                      {candidate.score}%
                    </p>
                  ))}
                <label className="mt-1 flex min-h-11 items-center gap-2 lg:min-h-8">
                  <input
                    type="checkbox"
                    className="size-4 rounded-none accent-primary"
                    checked={Boolean(decision.allowDuplicate)}
                    disabled={disabled}
                    onChange={(event) => setDecision({ allowDuplicate: event.target.checked })}
                  />
                  Create a separate item anyway
                </label>
              </div>
            )}
            <details>
              <summary className="cursor-pointer text-2xs text-muted-foreground">
                Source reference
              </summary>
              <p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-secondary/35 px-2.5 py-2 font-mono text-2xs leading-relaxed text-muted-foreground">
                {entry.source_excerpt || "No source excerpt available."}
              </p>
            </details>
          </>
        }
        status={final ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              {entry.status === "imported" ? "Added" : entry.status === "merged" ? "Updated"
                : entry.status === "rejected" ? "Rejected" : "Skipped"}
            </span>
            {skipped && actions.onRestore && (
              <Button type="button" size="sm" variant="outline" className="min-h-11 lg:min-h-9"
                aria-label={`Restore ${proposed.name}`}
                onClick={() => actions.onRestore?.(entry.id)}>
                Restore
              </Button>
            )}
          </p>
        ) : undefined}
        primary={actions.onAdd ? {
          label: `Add ${ENTITY_LABELS[type].toLowerCase()}`,
          onClick: () => actions.onAdd?.(entry.id),
          pending: actions.pendingIds?.has(entry.id),
        } : undefined}
        onSkip={actions.onSkip ? () => actions.onSkip?.(entry.id) : undefined}
        actions={nodeChildren.length > 0 && !final && actions.onAdd ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 lg:min-h-9"
              disabled={disabled}
              onClick={() => onIncludeBranch(entry, true)}
            >
              <Plus /> Select branch
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-11 lg:min-h-9"
              disabled={disabled}
              onClick={() => onIncludeBranch(entry, false)}
            >
              Clear branch
            </Button>
          </>
        ) : undefined}
        expand={final ? undefined : { open: editing, onOpenChange: setEditing, label: "Edit" }}
      >

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="text-2xs font-medium">
                Name
                <Input
                  className="mt-1.5"
                  value={proposed.name}
                  maxLength={200}
                  disabled={disabled || final}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </label>
              <label className="text-2xs font-medium">
                Entity type
                <Select
                  className="mt-1.5"
                  value={type}
                  disabled={disabled || final}
                  onChange={(event) =>
                    setDecision({ entityType: event.target.value as ImportEntityType })
                  }
                >
                  <option value="item">Item</option>
                  <option value="container">Container</option>
                  <option value="room">Room</option>
                  <option value="location">Fixed location</option>
                </Select>
              </label>
              <label className="text-2xs font-medium">
                Parent
                <Select
                  className="mt-1.5"
                  value={parentId ?? ""}
                  disabled={disabled || final}
                  onChange={(event) =>
                    setDecision({ parentEntryId: event.target.value || null })
                  }
                >
                  <option value="">Top level</option>
                  {parentOptions.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.proposed.name} · {ENTITY_LABELS[effectiveType(candidate, decisions)]}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="text-2xs font-medium">
                Quantity
                <Input
                  className="mt-1.5"
                  type="number"
                  min={0}
                  max={1_000_000}
                  value={proposed.quantity}
                  disabled={disabled || final || type !== "item"}
                  onChange={(event) => update({ quantity: Number(event.target.value) })}
                />
              </label>
              {type === "container" && (
                <label className="text-2xs font-medium">
                  Container type
                  <Select
                    className="mt-1.5"
                    value={String(proposed.relationships.container_type ?? "box")}
                    disabled={disabled || final}
                    onChange={(event) =>
                      update({
                        relationships: {
                          ...proposed.relationships,
                          container_type: event.target.value,
                        },
                      })
                    }
                  >
                    <option value="box">Box</option>
                    <option value="bin">Bin</option>
                    <option value="crate">Crate</option>
                    <option value="suitcase">Suitcase</option>
                    <option value="bag">Bag</option>
                    <option value="other">Other</option>
                  </Select>
                </label>
              )}
              {(type === "container" || type === "location") && (
                <label className="text-2xs font-medium">
                  Legacy identifier
                  <Input
                    className="mt-1.5"
                    value={
                      decision.legacyIdentifier !== undefined
                        ? decision.legacyIdentifier ?? ""
                        : entry.legacy_identifier ?? ""
                    }
                    maxLength={120}
                    placeholder="STO-01"
                    disabled={disabled || final}
                    onChange={(event) =>
                      setDecision({ legacyIdentifier: event.target.value || null })
                    }
                  />
                </label>
              )}
            </div>
            {type === "item" && (
              <label className="block text-2xs font-medium">
                Description
                <Textarea
                  className="mt-1.5"
                  value={proposed.description ?? ""}
                  maxLength={4000}
                  disabled={disabled || final}
                  onChange={(event) => update({ description: event.target.value || null })}
                />
              </label>
            )}
            <p className="text-2xs leading-relaxed text-muted-foreground">
              Parent changes are validated for cycles by the backend. Creating a room or
              container reuses an existing record when its name, room, parent and legacy
              identifier already match.
            </p>
        {actions.onReject && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
            <p className="text-2xs text-muted-foreground">
              Reject marks this record as wrong. It can be restored.
            </p>
            <Button type="button" size="sm" variant="ghost" className="min-h-11 lg:min-h-9"
              disabled={disabled} onClick={() => actions.onReject?.(entry.id)}>
              Reject entry
            </Button>
          </div>
        )}
      </ReviewRow>
      {!collapsedNow &&
        nodeChildren.map((child) => (
          <HierarchyRow
            key={child.id}
            entry={child}
            depth={depth + 1}
            entriesById={entriesById}
            children={children}
            edits={edits}
            decisions={decisions}
            collapsed={collapsed}
            disabled={disabled}
            onToggleCollapse={onToggleCollapse}
            onEdit={onEdit}
            onDecision={onDecision}
            onIncludeBranch={onIncludeBranch}
            actions={actions}
          />
        ))}
    </div>
  );
}
