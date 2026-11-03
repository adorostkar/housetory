import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
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
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { queryKeys } from "@/lib/queries";
import type { LocationKind, StorageLocation } from "@/lib/types";
import { collectDescendantIds, flattenLocations, LOCATION_KIND_LABELS } from "@/lib/utils";

interface LocationPayload {
  room_id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  kind: LocationKind;
}

const KINDS: LocationKind[] = [
  "cabinet",
  "shelf",
  "drawer",
  "box",
  "bin",
  "closet",
  "other",
];

export function LocationDialog({
  open,
  onOpenChange,
  roomId,
  locations,
  location,
  defaultParentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
  locations: StorageLocation[];
  location?: StorageLocation;
  defaultParentId?: string;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<LocationKind>("shelf");
  const [parentId, setParentId] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(location?.name ?? "");
    setKind(location?.kind ?? "shelf");
    setParentId(location?.parent_id ?? defaultParentId ?? "");
    setDescription(location?.description ?? "");
  }, [open, location, defaultParentId]);

  const save = useMutation({
    mutationFn: (payload: LocationPayload) =>
      location
        ? api.patch<StorageLocation>(`/storage-locations/${location.id}`, payload)
        : api.post<StorageLocation>("/storage-locations", payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["locations"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      toast.success(location ? "Location updated" : "Location added");
      onOpenChange(false);
    },
  });

  const excluded = location
    ? new Set([location.id, ...collectDescendantIds(locations, location.id)])
    : new Set<string>();
  const options = flattenLocations(locations).filter(
    ({ location: option }) => !excluded.has(option.id),
  );
  const fieldErrors = save.error instanceof ApiError ? save.error.fields : undefined;
  const generalError = save.error && !fieldErrors ? getApiErrorMessage(save.error) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{location ? "Edit location" : "Add a place"}</DialogTitle>
          <DialogDescription>
            Shelves, cabinets, drawers and boxes can all hold other places and items.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            save.mutate({
              room_id: roomId,
              parent_id: parentId || null,
              name: name.trim(),
              description: description.trim() || null,
              kind,
            });
          }}
        >
          {generalError && <FormError message={generalError} />}

          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_150px]">
            <Field label="Name" htmlFor="location-name" error={fieldErrors?.name}>
              <Input
                id="location-name"
                autoFocus
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Top shelf"
              />
            </Field>
            <Field label="Kind" htmlFor="location-kind">
              <Select
                id="location-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as LocationKind)}
              >
                {KINDS.map((value) => (
                  <option key={value} value={value}>
                    {LOCATION_KIND_LABELS[value]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Nested inside" htmlFor="location-parent" optional>
            <Select
              id="location-parent"
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
            >
              <option value="">Directly in this room</option>
              {options.map(({ location: option, depth }) => (
                <option key={option.id} value={option.id}>
                  {depth > 0 ? `${"— ".repeat(depth)}` : ""}
                  {option.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Description" htmlFor="location-description" optional>
            <Textarea
              id="location-description"
              className="min-h-20"
              maxLength={4000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="A short note about this place"
            />
          </Field>

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || !name.trim()}>
              {save.isPending && <Spinner />}
              {location ? "Save changes" : "Add place"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
