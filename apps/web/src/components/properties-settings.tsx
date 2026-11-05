import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Building2, Pencil, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, FormError } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { queryKeys, useCanWrite, useProperties } from "@/lib/queries";
import type { Property } from "@/lib/types";
import { pluralize } from "@/lib/utils";

function PropertyDialog({
  open,
  onOpenChange,
  property,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  property?: Property;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setName(property?.name ?? "");
    setDescription(property?.description ?? "");
  }, [open, property]);

  const save = useMutation({
    mutationFn: () =>
      property
        ? api.patch<Property>(`/properties/${property.id}`, {
            name: name.trim(),
            description: description.trim() || null,
          })
        : api.post<Property>("/properties", {
            name: name.trim(),
            description: description.trim() || null,
          }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.properties });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms });
      toast.success(property ? "Property updated" : "Property added");
      onOpenChange(false);
    },
  });
  const fieldErrors = save.error instanceof ApiError ? save.error.fields : undefined;
  const generalError = save.error && !fieldErrors ? getApiErrorMessage(save.error) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{property ? "Edit property" : "Add a property"}</DialogTitle>
          <DialogDescription>
            A property is a physical home or site in this household. Permissions stay at the
            household level.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          {generalError && <FormError message={generalError} />}
          <Field label="Property name" htmlFor="property-name" error={fieldErrors?.name}>
            <Input
              id="property-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              placeholder="Home, Summer house, Storage unit"
              autoFocus
              required
            />
          </Field>
          <Field label="Description" htmlFor="property-description" optional>
            <Textarea
              id="property-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={4000}
              className="min-h-20"
              placeholder="A short note, not a precise address."
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || !name.trim()}>
              {save.isPending && <Spinner />}
              {property ? "Save property" : "Add property"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PropertiesSettings() {
  const propertiesQuery = useProperties(true);
  const canWrite = useCanWrite();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Property | undefined>();
  const [deleteTarget, setDeleteTarget] = React.useState<Property | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.properties });
    void queryClient.invalidateQueries({ queryKey: queryKeys.rooms });
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers });
    void queryClient.invalidateQueries({ queryKey: queryKeys.items });
    void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
  };

  const archive = useMutation({
    mutationFn: (property: Property) =>
      api.patch<Property>(`/properties/${property.id}`, {
        is_archived: !property.is_archived,
      }),
    onSuccess: (_result, property) => {
      refresh();
      toast.success(property.is_archived ? "Property restored" : "Property archived");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (property: Property) => api.delete<void>(`/properties/${property.id}`),
    onSuccess: () => {
      refresh();
      setDeleteTarget(null);
      toast.success("Property deleted");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const properties = propertiesQuery.data?.items ?? [];
  return (
    <section className="surface p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-[1.35rem] font-normal tracking-[-0.02em]">
            Properties
          </h2>
          <p className="mt-1 max-w-xl text-[0.78rem] leading-relaxed text-muted-foreground">
            Physical homes and sites inside this household. Everyone keeps the same household role
            across every property.
          </p>
        </div>
        {canWrite && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(undefined);
              setDialogOpen(true);
            }}
          >
            <Plus />
            Add property
          </Button>
        )}
      </div>

      {propertiesQuery.isPending ? (
        <p className="mt-5 text-[0.78rem] text-muted-foreground">Loading properties…</p>
      ) : propertiesQuery.isError ? (
        <div className="mt-4">
          <FormError message={getApiErrorMessage(propertiesQuery.error)} />
        </div>
      ) : properties.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-border/70 px-4 py-4 text-[0.78rem] text-muted-foreground">
          No properties yet. Create one before adding rooms.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border/55">
          {properties.map((property) => {
            const populated =
              property.room_count > 0 || property.location_count > 0 || property.item_count > 0;
            return (
              <li key={property.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary/70 text-muted-foreground">
                  <Building2 className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[0.85rem] font-medium">{property.name}</span>
                    {property.is_archived && <Badge variant="secondary">Archived</Badge>}
                  </span>
                  <span className="mt-0.5 block text-[0.68rem] text-muted-foreground">
                    {pluralize(property.room_count, "room")} ·{" "}
                    {pluralize(property.item_count, "item")} ·{" "}
                    {pluralize(property.total_quantity, "unit")}
                    {property.description ? ` · ${property.description}` : ""}
                  </span>
                </span>
                {canWrite && (
                  <span className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Edit ${property.name}`}
                      onClick={() => {
                        setEditing(property);
                        setDialogOpen(true);
                      }}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={
                        property.is_archived
                          ? `Restore ${property.name}`
                          : `Archive ${property.name}`
                      }
                      disabled={archive.isPending || (!property.is_archived && populated)}
                      title={
                        !property.is_archived && populated
                          ? "Move or remove its rooms and items first."
                          : undefined
                      }
                      onClick={() => archive.mutate(property)}
                    >
                      {property.is_archived ? <ArchiveRestore /> : <Archive />}
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete ${property.name}`}
                      disabled={remove.isPending || populated}
                      title={populated ? "Move or remove its rooms and items first." : undefined}
                      onClick={() => setDeleteTarget(property)}
                    >
                      <Trash2 />
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <PropertyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        property={editing}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={deleteTarget ? `Delete ${deleteTarget.name}?` : "Delete property?"}
        description="This is only allowed when the property has no rooms or items. Existing item, room, container, photo and document IDs are never silently recreated."
        confirmLabel="Delete property"
        onConfirm={async () => {
          if (deleteTarget) await remove.mutateAsync(deleteTarget);
        }}
      />
    </section>
  );
}
