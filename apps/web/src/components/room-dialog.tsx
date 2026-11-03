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
import type { Room } from "@/lib/types";
import { collectDescendantIds, flattenRoomTree } from "@/lib/utils";

interface RoomPayload {
  name: string;
  description: string | null;
  parent_id: string | null;
}

export function RoomDialog({
  open,
  onOpenChange,
  rooms,
  room,
  defaultParentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rooms: Room[];
  room?: Room;
  defaultParentId?: string;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(room?.name ?? "");
    setDescription(room?.description ?? "");
    setParentId(room?.parent_id ?? defaultParentId ?? "");
  }, [open, room, defaultParentId]);

  const save = useMutation({
    mutationFn: (payload: RoomPayload) =>
      room
        ? api.patch<Room>(`/rooms/${room.id}`, payload)
        : api.post<Room>("/rooms", payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.rooms });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      toast.success(room ? "Room updated" : "Room added");
      onOpenChange(false);
    },
  });

  const excluded = room
    ? new Set([room.id, ...collectDescendantIds(rooms, room.id)])
    : new Set<string>();
  const options = flattenRoomTree(rooms).filter(({ room: option }) => !excluded.has(option.id));
  const fieldErrors = save.error instanceof ApiError ? save.error.fields : undefined;
  const generalError = save.error && !fieldErrors ? getApiErrorMessage(save.error) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{room ? "Edit room" : "Add a room"}</DialogTitle>
          <DialogDescription>
            {room
              ? "Refine the name or move this room within your home."
              : "Start with a space. You can nest smaller rooms inside it later."}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            save.mutate({
              name: name.trim(),
              description: description.trim() || null,
              parent_id: parentId || null,
            });
          }}
        >
          {generalError && <FormError message={generalError} />}
          <Field label="Room name" htmlFor="room-name" error={fieldErrors?.name}>
            <Input
              id="room-name"
              autoFocus
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Kitchen"
            />
          </Field>

          <Field label="Nested inside" htmlFor="room-parent" optional>
            <Select
              id="room-parent"
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
            >
              <option value="">No parent room</option>
              {options.map(({ room: option, depth }) => (
                <option key={option.id} value={option.id}>
                  {depth > 0 ? `${"— ".repeat(depth)}` : ""}
                  {option.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Description" htmlFor="room-description" optional>
            <Textarea
              id="room-description"
              className="min-h-24"
              maxLength={4000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What lives here?"
            />
          </Field>

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || !name.trim()}>
              {save.isPending && <Spinner />}
              {room ? "Save changes" : "Add room"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
