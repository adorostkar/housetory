# Scoped place management

Room, storage-place and container item lists reuse the Items-tab bulk selection
and action workflow. The same item cards, checkboxes, `Move`, `Tags`, `Category`,
`Images` and evidence-export actions are used rather than a second implementation.

## Scoped selection

- A place view selects only items returned by its own bounded query.
- **Direct only** selects items assigned exactly to the room/fixed place/container.
- **Include nested** includes items in nested storage places, and for a room, its
  sub-rooms. The active scope is kept in the URL.
- Search and sort are also kept in the URL. Changing scope, search, sort, filters
  or source clears the selection.
- Only loaded, non-archived items can be selected. Counts state loaded vs total so
  a place view never silently selects household-wide inventory.

## Origin-aware item navigation

Item cards opened from a room, container/place, or filtered Items page carry a
safe, same-app `from` path and display label. Item detail then shows
**Back to [origin]**. Edit, Save, Cancel and Back preserve that origin even after
the item is moved to another room/place. Standard Items navigation still works.

Only relative same-app paths are accepted. External URLs, protocol-relative URLs,
scheme URLs, control characters and overlong labels are rejected. A best-effort
scroll position is remembered for the originating list.

## Emptying and deleting

The same transactional backend workflow powers:

- **Move all contents**: removes every item/nested place from a source while
  keeping the source.
- **Move contents and delete**: moves first, verifies the source is empty, then
  deletes it inside the same transaction. Storage places become recoverable
  tombstones; room deletion remains the explicit irreversible operation.

Preview includes direct and nested item counts, units, archived items, active
loans, nested places, child rooms, active borrowed placements and source photos.
It lists representative items/places and explains warnings and blockers.

Rules:

- Inventory is never deleted by these workflows.
- Nested storage places keep their IDs, identifiers, hierarchy and contents.
- A room's sub-rooms are reparented under the destination room. Room-content
  moves require a destination in the same property; existing whole-root-room
  property moves remain the separate property workflow.
- Destination self/descendant/cycle and cross-household references are rejected.
- A stale preview fingerprint, changed counts or concurrent hierarchy mutation
  returns `409 place_contents_changed` and writes nothing.
- Active borrowed-record placement references follow the contents. Historical
  snapshots on returned/cancelled records are not rewritten.
- Item loans are unchanged; only the item's home room/place moves.
- Item metadata, quantities, documents, photos, purchases and warranties are
  untouched.
- A failed post-move verification rolls the entire transaction back.
- Empty storage-place deletion is recoverable: the place row, identity, room,
  parent, identifier, photos and deletion snapshot are retained as a tombstone.
  Earlier individual item moves can offer **Restore container and undo move…** for
  one eligible item at a time. This is not a whole-container undo.
- Room deletion remains irreversible and stays blocked while active or
  recoverable-deleted places/contents remain. The UI says so instead of implying
  that a blocked room was deleted.
- Storage-place photos are retained with a tombstone and return if the place is
  restored. Room photos are deleted with the room. Photos on moved nested places
  remain with those places.

## Recoverable deleted storage places

Deleting an empty storage place now writes a household-scoped tombstone rather
than removing the row. Tombstones:

- are excluded from active lists, counts, search, selection, label generation,
  new move destinations and QR lookups;
- keep their stable ID and QR identifier, so a later restore does not create a
  duplicate or steal a reassigned identifier;
- are not automatically purged. No retention purge job was added;
- retain their photos and deletion snapshot, including room, parent, property,
  path, identifier and photo count;
- are visible as an honest `410 container_deleted` / `location_deleted` state when
  an old QR or detail link is opened.

An item move whose original place is a tombstone shows a distinct restore action
in item history. The preview lists the original container identity, parent/room,
identifier and the one item that will be returned. Confirmation atomically
restores the tombstone and moves that one item back, then records a
`container.restored` event and an `item.move_undone` compensating event.

The restore is blocked rather than guessed when:

- the item moved again after the recorded move;
- the original room or parent place is missing or also deleted;
- the original property/room metadata is inconsistent;
- an active place now uses the same name in that room/parent, or the legacy
  identifier is now used elsewhere;
- the item is archived or no longer exists;
- recovery metadata points to another household or the user lacks write access.

Previously hard-deleted legacy places have no tombstone. Their history shows that
they predate recoverable deletion and cannot be recreated safely; Housetory does
not invent a room, parent or identity from incomplete snapshots. Room hierarchy
restoration and whole-bulk reversal remain deferred.

## Containers list and detail

Containers now expose consistent delete actions:

- Empty: confirmation, then delete.
- Nonempty: **Move contents and delete** destination preview and confirmation.
- **Move contents** remains available separately to empty a container without
  deleting it.

The existing room-place menu uses the same dialogs and transaction.

## Permissions

The new routes use the existing household write guard and `require_auth`
convention. Viewers remain read-only. Members and owners can perform the same
write/delete operations they could already perform on empty rooms/places. No
delete permission was broadened. Source, destination, items, borrowed records and
history remain household-scoped; cross-household IDs are not reachable.

## Known limitations

- Room-content destination rooms must be in the same property.
- Transfer operations are synchronous. Very large households may take longer; no
  background job/cancel UI is provided.
- Historical borrowed records that already have a returned/cancelled status keep
  their historical snapshots even if their old room/place is later deleted.
- Room photos and room deletion remain irreversible.
- There is no whole-place or whole-bulk undo. A recoverable storage-place
  tombstone can restore only one eligible item move at a time; it does not bring
  back other former contents.
- Tombstones are retained without an automatic purge job. A future explicit
  retention lifecycle is required before any permanent cleanup.

## Walkthrough screenshots

- [Box item list with scoped selection](walkthrough/place-management/01-box-bulk-selection.png)
- [Move selected items to a room](walkthrough/place-management/02-box-move-dialog.png)
- [Item origin preserved after edit, save and move](walkthrough/place-management/03-origin-after-save.png)
- [Move all contents preview](walkthrough/place-management/04-move-contents-preview.png)
- [Move contents and delete preview](walkthrough/place-management/05-move-and-delete-preview.png)
- [Room deletion with child-room reparenting preview](walkthrough/place-management/06-room-delete-preview.png)
- [Restore-assisted undo preview](walkthrough/restore-assisted-undo/01-preview.png)
- [Restored container and returned item](walkthrough/restore-assisted-undo/02-restored.png)
