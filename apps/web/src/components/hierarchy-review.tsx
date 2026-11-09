import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CornerDownRight,
  FolderTree,
  MapPin,
  Package,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  ImportDecision,
  ImportEntityType,
  ImportEntry,
  ProposedItem,
} from "@/lib/types";
import { cn } from "@/lib/utils";

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
}: {
  entries: ImportEntry[];
  edits: Record<string, ProposedItem>;
  decisions: Record<string, ImportDecision>;
  disabled: boolean;
  onEdit: (entryId: string, proposed: ProposedItem) => void;
  onDecision: (entryId: string, decision: ImportDecision) => void;
}) {
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
      if (!target || target.status !== "proposed") continue;
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
          <CornerDownRight className="size-3.5 text-brass" /> Approve a branch to include its
          contents.
        </span>
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="size-3.5" /> Nothing is written until you approve.
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
        />
      ))}
    </div>
  );
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
}) {
  const [editing, setEditing] = React.useState(false);
  const proposed = edits[entry.id] ?? entry.proposed;
  const decision = effectiveDecision(entry, decisions);
  const type = effectiveType(entry, decisions);
  const parentId = effectiveParent(entry, decisions);
  const parent = parentId ? entriesById.get(parentId) : null;
  const nodeChildren = children.get(entry.id) ?? [];
  const final = ["imported", "merged", "skipped", "rejected", "failed"].includes(
    entry.status,
  );
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
      <article
        className={cn(
          "surface overflow-hidden transition-colors",
          decision.include && !final && "border-sage/40",
          final && entry.status === "failed" && "border-destructive/30",
          final && "opacity-80",
        )}
      >
        <div
          className="flex items-start gap-2 p-3 sm:gap-3 sm:p-4"
          style={{ paddingLeft: `${12 + depth * 18}px` }}
        >
          {nodeChildren.length > 0 ? (
            <button
              type="button"
              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
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
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center text-muted-foreground">
              {type === "item" ? <Package className="size-3.5" /> : <CornerDownRight className="size-3.5" />}
            </span>
          )}
          {!final && (
            <input
              type="checkbox"
              checked={decision.include}
              disabled={disabled}
              onChange={(event) => onIncludeBranch(entry, event.target.checked)}
              aria-label={`Include ${proposed.name}${nodeChildren.length ? " and its contents" : ""}`}
              className="mt-1 size-4 accent-primary"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="text-sm font-medium">{proposed.name}</h3>
              <Badge variant={ENTITY_TONE[type]}>{ENTITY_LABELS[type]}</Badge>
              {(type === "item" || type === "container") && proposed.quantity !== 1 && (
                <Badge variant="secondary">×{proposed.quantity}</Badge>
              )}
              {entry.legacy_identifier && (
                <Badge variant="outline">{entry.legacy_identifier}</Badge>
              )}
              {ambiguous && (
                <Badge variant="brass">
                  <AlertTriangle className="size-3" /> Needs review
                </Badge>
              )}
              {highDuplicate && !final && (
                <Badge variant="brass">
                  <AlertTriangle className="size-3" /> Possible duplicate
                </Badge>
              )}
              {entry.status !== "proposed" && (
                <Badge variant="outline">
                  {entry.status.charAt(0).toUpperCase() + entry.status.slice(1)}
                </Badge>
              )}
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3" />
                {parent ? parent.proposed.name : "Top level"}
              </span>
              {entry.confidence != null && <span>{entry.confidence}% confidence</span>}
              {entry.source_path && <span className="truncate">{entry.source_path}</span>}
            </p>
            {entry.error && (
              <p className="mt-1.5 text-2xs text-destructive">{entry.error}</p>
            )}
            {highDuplicate && !final && (
              <div className="mt-2 rounded-lg border border-brass/25 bg-brass-soft/40 px-2.5 py-2 text-2xs text-muted-foreground">
                <p className="font-medium text-foreground/80">Existing item may match</p>
                {entry.duplicate_candidates
                  .filter((candidate) => candidate.score >= 55)
                  .map((candidate) => (
                    <p key={candidate.item_id} className="mt-1">
                      {candidate.name} · {candidate.room_name ?? "No room"} ·{" "}
                      {candidate.score}%
                    </p>
                  ))}
                <label className="mt-2 flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={Boolean(decision.allowDuplicate)}
                    disabled={disabled}
                    onChange={(event) => setDecision({ allowDuplicate: event.target.checked })}
                  />
                  Create a separate item anyway
                </label>
              </div>
            )}
            <details className="mt-1.5">
              <summary className="cursor-pointer text-2xs text-muted-foreground">
                Source reference
              </summary>
              <p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-secondary/35 px-2.5 py-2 font-mono text-2xs leading-relaxed text-muted-foreground">
                {entry.source_excerpt || "No source excerpt available."}
              </p>
            </details>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <div className="flex items-center gap-1">
              {!final && (
                <Select
                  aria-label={`Action for ${proposed.name}`}
                  value={decision.action}
                  disabled={disabled}
                  onChange={(event) =>
                    setDecision({ action: event.target.value as ImportDecision["action"] })
                  }
                  className="h-8 w-[108px] text-2xs"
                >
                  <option value="import">Import</option>
                  <option value="skip">Skip</option>
                  <option value="reject">Reject</option>
                </Select>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEditing((current) => !current)}
                aria-expanded={editing}
              >
                {editing ? <X /> : <CircleHelp />}
                {editing ? "Close" : "Edit"}
              </Button>
            </div>
            {nodeChildren.length > 0 && !final && (
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onIncludeBranch(entry, true)}
                >
                  <Plus /> Branch
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onIncludeBranch(entry, false)}
                >
                  Clear
                </Button>
              </div>
            )}
          </div>
        </div>

        {editing && (
          <div className="space-y-3 border-t border-border/60 p-3 sm:p-4">
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
          </div>
        )}
      </article>
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
          />
        ))}
    </div>
  );
}
