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
  deletes it inside the same transaction.

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
- The empty source delete is irreversible. The UI does not promise undo. Earlier
  individual item-move history remains, but undo safely refuses when the original
  source no longer exists.
- Source room/place photos are deleted with the source and are called out in the
  preview. Photos on moved nested places remain with those places.

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
- Removed source entity photos are irreversible.
- There is no whole-place undo for deletion. Individual item moves may be undone
  only while their original source still exists.

## Walkthrough screenshots

- [Box item list with scoped selection](walkthrough/place-management/01-box-bulk-selection.png)
- [Move selected items to a room](walkthrough/place-management/02-box-move-dialog.png)
- [Item origin preserved after edit, save and move](walkthrough/place-management/03-origin-after-save.png)
- [Move all contents preview](walkthrough/place-management/04-move-contents-preview.png)
- [Move contents and delete preview](walkthrough/place-management/05-move-and-delete-preview.png)
- [Room deletion with child-room reparenting preview](walkthrough/place-management/06-room-delete-preview.png)
