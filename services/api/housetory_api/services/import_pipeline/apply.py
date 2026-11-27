"""Applying reviewed import proposals to the inventory."""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...api.errors import ApiError
from ...domain import ImportEntityType, ImportEntryStatus, ImportStatus
from ...models import (
    Category,
    Household,
    ImportBatch,
    ImportEntry,
    Item,
    Property,
    Room,
    StorageLocation,
    Tag,
)
from ...schemas.imports import (
    ImportApplyEntry,
    ImportApplyFailure,
    ImportApplyResult,
    ImportEntryDraftRequest,
    LocationProposal,
    ProposedItem,
)
from ...schemas.items import ItemCreate, ItemUpdate, PurchaseIn, WarrantyIn
from .. import properties as property_service
from ..containers import create_containers
from ..draft_revisions import REVISION_KEY, DraftConflict, decide
from ..import_row_drafts import (
    REVIEW_DRAFT_KEY,
    draft_revision,
    first_reading,
    is_stub,
    kept_draft,
    same_draft,
    source_proposed,
    with_draft,
    without_draft,
)
from ..items import create_item_record, get_item, update_item_record
from .serialization import _batch_detail, _safe_error, serialize_batch

# The choices of a row that are not part of the proposal itself: what to do with it and
# with which target. They are kept with a skipped row, inside its proposal, so that the
# whole draft comes back after a reload and after Restore. A row that still waits keeps
# them the same way, together with its first reading (see ``import_row_drafts``).


def _proposed_json(
    proposed: ProposedItem,
    request: ImportApplyEntry | ImportEntryDraftRequest | None = None,
    revision: int | None = None,
) -> dict:
    """The edited proposal as stored. With ``request`` it also carries the review draft.

    ``revision`` is the revision of the draft that is kept with a skip.
    """
    data = proposed.model_dump(mode="json")
    relationships = dict(data.get("relationships") or {})
    kept = relationships.pop(REVIEW_DRAFT_KEY, None)
    if request is not None:
        # A skip names its target only when the person chose to merge. A draft of a
        # waiting row says the action itself, and may keep a target that is not chosen yet.
        action = (
            request.action
            if isinstance(request, ImportEntryDraftRequest)
            else ("merge" if request.merge_item_id else "import")
        )
        draft: dict[str, Any] = {
            "action": action,
            "merge_item_id": str(request.merge_item_id) if request.merge_item_id else None,
            "merge_fields": list(request.merge_fields),
            "allow_duplicate": request.allow_duplicate,
        }
        if request.entity_type is not None:
            draft["entity_type"] = request.entity_type
        if "parent_entry_id" in request.model_fields_set:
            draft["parent_entry_id"] = (
                str(request.parent_entry_id) if request.parent_entry_id else None
            )
        if "legacy_identifier" in request.model_fields_set:
            draft["legacy_identifier"] = request.legacy_identifier
        # The fields that were changed by hand. A request that does not name them
        # leaves the ones that were kept before.
        edited = kept.get("edited_fields") if isinstance(kept, dict) else None
        if request.edited_fields is not None:
            edited = list(request.edited_fields)
        if edited:
            draft["edited_fields"] = edited
        if revision is not None:
            draft[REVISION_KEY] = revision
        relationships[REVIEW_DRAFT_KEY] = draft
    data["relationships"] = relationships
    return data


def _context_property(db: Session, batch: ImportBatch) -> Property:
    raw = (batch.metadata_json or {}).get("context") or {}
    property_id = raw.get("property_id")
    if property_id:
        try:
            record = db.get(Property, uuid.UUID(str(property_id)))
        except (ValueError, TypeError):
            record = None
        if record is not None and record.household_id == batch.household_id:
            return record
    room, _location = _context_destination(db, batch)
    if room is not None:
        return property_service.get_property(db, batch.household_id, room.property_id)
    return property_service.resolve_room_property(db, batch.household_id, None)


def _context_destination(
    db: Session, batch: ImportBatch
) -> tuple[Room | None, StorageLocation | None]:
    raw = (batch.metadata_json or {}).get("context") or {}
    try:
        room_id = uuid.UUID(str(raw.get("room_id"))) if raw.get("room_id") else None
        location_id = uuid.UUID(str(raw.get("location_id"))) if raw.get("location_id") else None
    except (ValueError, TypeError):
        return None, None
    room = db.get(Room, room_id) if room_id else None
    location = db.get(StorageLocation, location_id) if location_id else None
    if room is not None and room.household_id != batch.household_id:
        room = None
    if location is not None and (
        location.household_id != batch.household_id or location.deleted_at is not None
    ):
        location = None
    if location is not None:
        location_room = db.get(Room, location.room_id)
        if room is None and location_room is not None:
            room = location_room
    return room, location


def _apply_context_destination(
    db: Session, batch: ImportBatch, proposed: ProposedItem
) -> ProposedItem:
    room, location = _context_destination(db, batch)
    if room is None and location is None:
        return proposed
    updates: dict[str, Any] = {}
    sources = dict(proposed.field_sources)
    if proposed.room is None and room is not None:
        updates["room"] = LocationProposal(
            text=room.name,
            entity_type="room",
            status="matched",
            matched_id=room.id,
            name=room.name,
            room_id=room.id,
        )
        sources["room"] = "inferred"
    if proposed.storage_location is None and proposed.room is None and location is not None:
        updates["storage_location"] = LocationProposal(
            text=location.name,
            entity_type="storage_location",
            identifier=location.identifier,
            status="matched",
            matched_id=location.id,
            name=location.name,
            room_id=location.room_id,
            parent_id=location.parent_id,
        )
        sources["storage_location"] = "inferred"
    if not updates:
        return proposed
    updates["field_sources"] = sources
    return proposed.model_copy(update=updates)


def _resolve_or_create_category(
    db: Session, household_id: uuid.UUID, name: str | None
) -> uuid.UUID | None:
    if not name:
        return None
    normalized = name.strip().lower()
    if not normalized:
        return None
    category = db.scalar(
        select(Category).where(
            Category.household_id == household_id,
            Category.name.ilike(normalized),
        )
    )
    if category is not None:
        return category.id
    category = Category(household_id=household_id, name=name.strip()[:80], sort_order=0)
    db.add(category)
    db.flush()
    return category.id


def _resolve_or_create_tags(
    db: Session, household_id: uuid.UUID, names: list[str]
) -> list[uuid.UUID]:
    ids: list[uuid.UUID] = []
    for raw_name in names:
        name = raw_name.strip().lstrip("#")[:60]
        if not name:
            continue
        tag = db.scalar(
            select(Tag).where(
                Tag.household_id == household_id, func.lower(Tag.name) == name.lower()
            )
        )
        if tag is None:
            tag = Tag(household_id=household_id, name=name)
            db.add(tag)
            db.flush()
        ids.append(tag.id)
    return list(dict.fromkeys(ids))


def _default_currency(db: Session, household_id: uuid.UUID) -> str:
    household = db.get(Household, household_id)
    return household.default_currency if household is not None else "USD"


def _item_create_from_proposal(
    db: Session, household_id: uuid.UUID, proposed: ProposedItem
) -> ItemCreate:
    if proposed.room and proposed.room.status == "ambiguous":
        raise ValueError("Choose a room to resolve the ambiguous destination before applying.")
    if proposed.storage_location and proposed.storage_location.status == "ambiguous":
        raise ValueError("Choose a place to resolve the ambiguous destination before applying.")
    purchase = None
    if proposed.purchase and any(
        value is not None
        for value in (
            proposed.purchase.purchase_date,
            proposed.purchase.price_cents,
            proposed.purchase.merchant,
            proposed.purchase.order_number,
        )
    ):
        purchase = PurchaseIn(
            merchant=proposed.purchase.merchant,
            purchase_date=proposed.purchase.purchase_date,
            price_cents=proposed.purchase.price_cents,
            currency=proposed.purchase.currency or _default_currency(db, household_id),
            order_number=proposed.purchase.order_number,
            notes=proposed.purchase.notes,
        )
    warranty = None
    if proposed.warranty and any(
        value is not None
        for value in (
            proposed.warranty.provider,
            proposed.warranty.start_date,
            proposed.warranty.end_date,
            proposed.warranty.duration_months,
        )
    ):
        warranty = WarrantyIn(
            provider=proposed.warranty.provider,
            start_date=proposed.warranty.start_date,
            duration_months=proposed.warranty.duration_months,
            end_date=proposed.warranty.end_date,
            notes=proposed.warranty.notes,
        )
    description = proposed.description
    if proposed.notes and proposed.notes not in (description or ""):
        description = f"{description}\n\nNotes: {proposed.notes}" if description else proposed.notes
    return ItemCreate(
        name=proposed.name,
        description=description[:4000] if description else None,
        brand=proposed.brand,
        model=proposed.model,
        serial_number=proposed.serial_number,
        quantity=max(1, proposed.quantity),
        room_id=proposed.room.matched_id
        if proposed.room and proposed.room.status == "matched"
        else None,
        storage_location_id=(
            proposed.storage_location.matched_id
            if proposed.storage_location and proposed.storage_location.status == "matched"
            else None
        ),
        category_id=(
            proposed.category.matched_id
            if proposed.category and proposed.category.status == "matched"
            else _resolve_or_create_category(
                db,
                household_id,
                proposed.category.name if proposed.category else None,
            )
        ),
        tag_ids=_resolve_or_create_tags(db, household_id, proposed.tags),
        purchase=purchase,
        warranty=warranty,
    )


def _merge_from_proposal(
    db: Session,
    household_id: uuid.UUID,
    item: Item,
    proposed: ProposedItem,
    fields: list[str],
) -> None:
    payload: dict[str, Any] = {}
    if "name" in fields:
        payload["name"] = proposed.name
    if "description" in fields:
        payload["description"] = proposed.description
    if "brand" in fields:
        payload["brand"] = proposed.brand
    if "model" in fields:
        payload["model"] = proposed.model
    if "serial_number" in fields:
        payload["serial_number"] = proposed.serial_number
    if "quantity" in fields:
        payload["quantity"] = max(0, proposed.quantity)
    if "category" in fields:
        payload["category_id"] = (
            proposed.category.matched_id
            if proposed.category and proposed.category.status == "matched"
            else _resolve_or_create_category(
                db,
                household_id,
                proposed.category.name if proposed.category else None,
            )
        )
    if "room" in fields:
        payload["room_id"] = (
            proposed.room.matched_id
            if proposed.room and proposed.room.status == "matched"
            else None
        )
    if "storage_location" in fields:
        payload["storage_location_id"] = (
            proposed.storage_location.matched_id
            if proposed.storage_location and proposed.storage_location.status == "matched"
            else None
        )
    if "purchase" in fields and proposed.purchase:
        payload["purchase"] = PurchaseIn(
            merchant=proposed.purchase.merchant,
            purchase_date=proposed.purchase.purchase_date,
            price_cents=proposed.purchase.price_cents,
            currency=proposed.purchase.currency or _default_currency(db, household_id),
            order_number=proposed.purchase.order_number,
            notes=proposed.purchase.notes,
        )
    if "warranty" in fields and proposed.warranty:
        payload["warranty"] = WarrantyIn(
            provider=proposed.warranty.provider,
            start_date=proposed.warranty.start_date,
            duration_months=proposed.warranty.duration_months,
            end_date=proposed.warranty.end_date,
            notes=proposed.warranty.notes,
        )
    if "tags" in fields:
        existing = {tag.id for tag in item.tags}
        payload["tag_ids"] = list(
            existing | set(_resolve_or_create_tags(db, household_id, proposed.tags))
        )
    if "notes" in fields and proposed.notes:
        payload["description"] = (
            f"{item.description}\n\nNotes: {proposed.notes}" if item.description else proposed.notes
        )
    update_item_record(db, household_id, item, ItemUpdate(**payload))


def _effective_parent_id(
    entry: ImportEntry, requested: dict[uuid.UUID, ImportApplyEntry]
) -> uuid.UUID | None:
    request = requested.get(entry.id)
    if request is not None and "parent_entry_id" in request.model_fields_set:
        return request.parent_entry_id
    return entry.parent_entry_id


def _hierarchy_depth(
    entry: ImportEntry,
    entries: dict[uuid.UUID, ImportEntry],
    requested: dict[uuid.UUID, ImportApplyEntry],
) -> int:
    depth = 0
    seen: set[uuid.UUID] = set()
    cursor = entry
    while True:
        parent_id = _effective_parent_id(cursor, requested)
        if parent_id is None or parent_id not in entries:
            break
        if cursor.id in seen:
            raise ValueError("The selected hierarchy contains a parent cycle.")
        seen.add(cursor.id)
        cursor = entries[parent_id]
        depth += 1
    return depth


def _find_room(
    db: Session,
    household_id: uuid.UUID,
    property_id: uuid.UUID,
    name: str,
    parent_id: uuid.UUID | None,
) -> Room | None:
    query = select(Room).where(
        Room.household_id == household_id,
        Room.property_id == property_id,
        func.lower(Room.name) == name.strip().lower(),
    )
    if parent_id is None:
        query = query.where(Room.parent_id.is_(None))
    else:
        query = query.where(Room.parent_id == parent_id)
    return db.scalar(query.limit(1))


def _ensure_room(
    db: Session,
    household_id: uuid.UUID,
    property_id: uuid.UUID,
    name: str,
    parent_id: uuid.UUID | None,
) -> Room:
    existing = _find_room(db, household_id, property_id, name, parent_id)
    if existing is not None:
        return existing
    room = Room(
        household_id=household_id,
        property_id=property_id,
        name=name[:120],
        parent_id=parent_id,
    )
    db.add(room)
    db.flush()
    return room


def _find_existing_container(
    db: Session,
    household_id: uuid.UUID,
    property_id: uuid.UUID,
    room_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    name: str,
    legacy_identifier: str | None,
) -> StorageLocation | None:
    room_ids = select(Room.id).where(
        Room.household_id == household_id,
        Room.property_id == property_id,
    )
    if legacy_identifier:
        found = db.scalar(
            select(StorageLocation).where(
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
                StorageLocation.room_id.in_(room_ids),
                (
                    (func.upper(StorageLocation.legacy_identifier) == legacy_identifier.upper())
                    | (func.upper(StorageLocation.identifier) == legacy_identifier.upper())
                    | StorageLocation.aliases.contains([legacy_identifier])
                ),
            )
        )
        if found is not None:
            return found
    query = select(StorageLocation).where(
        StorageLocation.household_id == household_id,
        StorageLocation.active(),
        StorageLocation.room_id == room_id,
        func.lower(StorageLocation.name) == name.strip().lower(),
    )
    if parent_id is None:
        query = query.where(StorageLocation.parent_id.is_(None))
    else:
        query = query.where(StorageLocation.parent_id == parent_id)
    return db.scalar(query.limit(1))


def apply_hierarchy_import(
    db: Session, batch: ImportBatch, request_entries: list[ImportApplyEntry]
) -> ImportApplyResult:
    if batch.status not in {ImportStatus.REVIEW.value, ImportStatus.COMPLETED.value}:
        raise ValueError("This import is not ready to apply.")
    batch.status = ImportStatus.APPLYING.value
    db.commit()
    entries = {
        entry.id: entry
        for entry in db.scalars(select(ImportEntry).where(ImportEntry.batch_id == batch.id)).all()
    }
    requested = {request.id: request for request in request_entries}
    ordered = sorted(
        (entries[request.id] for request in request_entries if request.id in entries),
        key=lambda entry: (
            _hierarchy_depth(entry, entries, requested),
            entry.position,
        ),
    )
    property_record = _context_property(db, batch)
    created = merged = skipped = rejected = failed = 0
    failures: list[ImportApplyFailure] = []
    for entry in ordered:
        request = requested[entry.id]
        if entry.status in {ImportEntryStatus.IMPORTED.value, ImportEntryStatus.MERGED.value}:
            skipped += 1
            continue
        savepoint = db.begin_nested()
        try:
            proposed = request.proposed or ProposedItem.model_validate(entry.proposed)
            # A skip changes what is kept for the row, so its revision goes up.
            revision = draft_revision(entry.proposed) + 1
            if request.action == "reject":
                entry.proposed = _proposed_json(proposed, request, revision)
                entry.status = ImportEntryStatus.REJECTED.value
                rejected += 1
                savepoint.commit()
                continue
            if request.action == "skip":
                # The edited record and its choices are kept, for Restore.
                entry.proposed = _proposed_json(proposed, request, revision)
                entry.status = ImportEntryStatus.SKIPPED.value
                skipped += 1
                savepoint.commit()
                continue
            entry.proposed = _proposed_json(proposed)
            entity_type = request.entity_type or entry.entity_type
            if entity_type not in {value.value for value in ImportEntityType}:
                raise ValueError("Choose a valid entity type.")
            parent_id = _effective_parent_id(entry, requested)
            parent = entries.get(parent_id) if parent_id else None
            if parent is not None and parent.status not in {
                ImportEntryStatus.IMPORTED.value,
                ImportEntryStatus.SKIPPED.value,
            }:
                raise ValueError("Approve the parent location or container first.")
            if request.entity_type is not None:
                entry.entity_type = entity_type
            if "parent_entry_id" in request.model_fields_set:
                entry.parent_entry_id = request.parent_entry_id
            parent_room_id = parent.created_room_id if parent is not None else None
            parent_location_id = parent.created_location_id if parent is not None else None
            if entity_type == ImportEntityType.ROOM.value:
                room = _ensure_room(
                    db,
                    batch.household_id,
                    property_record.id,
                    proposed.name,
                    parent_room_id,
                )
                entry.created_room_id = room.id
                entry.status = ImportEntryStatus.IMPORTED.value
                created += 1
                savepoint.commit()
                continue
            if entity_type in {
                ImportEntityType.CONTAINER.value,
                ImportEntityType.LOCATION.value,
            }:
                room_id = parent_room_id
                if parent is not None and parent.created_location_id:
                    parent_location = db.get(StorageLocation, parent.created_location_id)
                    if parent_location is not None:
                        room_id = parent_location.room_id
                if room_id is None and proposed.room and proposed.room.matched_id:
                    room_id = proposed.room.matched_id
                if room_id is None:
                    raise ValueError("Choose a room for this location or container.")
                legacy = (
                    request.legacy_identifier
                    or entry.legacy_identifier
                    or str(proposed.relationships.get("legacy_identifier") or "")
                    or None
                )
                existing = _find_existing_container(
                    db,
                    batch.household_id,
                    property_record.id,
                    room_id,
                    parent_location_id,
                    proposed.name,
                    legacy,
                )
                if existing is not None:
                    location = existing
                elif entity_type == ImportEntityType.CONTAINER.value:
                    container_type = str(proposed.relationships.get("container_type") or "box")
                    try:
                        location = create_containers(
                            db,
                            batch.household_id,
                            room_id=room_id,
                            container_type=container_type,
                            quantity=1,
                            parent_id=parent_location_id,
                            name=proposed.name,
                        )[0]
                    except ApiError as exc:
                        raise ValueError(exc.message) from None
                else:
                    location = StorageLocation(
                        household_id=batch.household_id,
                        room_id=room_id,
                        parent_id=parent_location_id,
                        name=proposed.name[:120],
                        description=proposed.description,
                        kind="other",
                    )
                    db.add(location)
                    db.flush()
                if legacy:
                    location.legacy_identifier = location.legacy_identifier or legacy[:120]
                    aliases = list(location.aliases or [])
                    if legacy.upper() not in {value.upper() for value in aliases}:
                        aliases.append(legacy)
                        location.aliases = aliases
                if request.legacy_identifier is not None:
                    entry.legacy_identifier = request.legacy_identifier or None
                entry.created_room_id = location.room_id
                entry.created_location_id = location.id
                entry.status = ImportEntryStatus.IMPORTED.value
                created += 1
                savepoint.commit()
                continue
            if entry.duplicate_candidates and entry.duplicate_resolution == "skip":
                entry.status = ImportEntryStatus.SKIPPED.value
                skipped += 1
                savepoint.commit()
                continue
            strong_duplicate = any(
                int(candidate.get("score") or 0) >= 55
                for candidate in (entry.duplicate_candidates or [])
                if isinstance(candidate, dict)
            )
            if (
                entity_type == ImportEntityType.ITEM.value
                and strong_duplicate
                and not request.allow_duplicate
                and request.action == "import"
            ):
                raise ValueError(
                    "A possible duplicate was found. Choose skip, merge with the existing "
                    "item, or explicitly allow a new item."
                )
            if request.action == "merge":
                if not request.merge_item_id or not request.merge_fields:
                    raise ValueError("Choose an item and at least one merge field.")
                item = get_item(db, batch.household_id, request.merge_item_id)
                _merge_from_proposal(db, batch.household_id, item, proposed, request.merge_fields)
                entry.status = ImportEntryStatus.MERGED.value
                entry.matched_item_id = item.id
                merged += 1
                savepoint.commit()
                continue
            room_id = parent_room_id
            location_id = parent_location_id
            if parent is not None and parent.created_location_id:
                parent_location = db.get(StorageLocation, parent.created_location_id)
                if parent_location is not None:
                    room_id = parent_location.room_id
            if (
                parent_location_id is None
                and proposed.storage_location
                and proposed.storage_location.matched_id
            ):
                location_id = proposed.storage_location.matched_id
                parent_location = db.get(StorageLocation, location_id)
                if parent_location is not None:
                    room_id = parent_location.room_id
            if room_id is None and proposed.room and proposed.room.matched_id:
                room_id = proposed.room.matched_id
            payload = _item_create_from_proposal(db, batch.household_id, proposed)
            payload = payload.model_copy(
                update={"room_id": room_id, "storage_location_id": location_id}
            )
            item = create_item_record(db, batch.household_id, payload)
            entry.imported_item_id = item.id
            entry.status = ImportEntryStatus.IMPORTED.value
            created += 1
            savepoint.commit()
        except Exception as exc:  # noqa: BLE001 - one node must not lose the batch
            savepoint.rollback()
            entry = db.get(ImportEntry, request.id)
            if entry is not None:
                entry.status = ImportEntryStatus.FAILED.value
                entry.error = _safe_error(exc)
                failed += 1
                failures.append(
                    ImportApplyFailure(entry_id=entry.id, message=entry.error or "Import failed.")
                )
    db.commit()
    statuses = list(
        db.scalars(select(ImportEntry.status).where(ImportEntry.batch_id == batch.id)).all()
    )
    batch.imported_entries = statuses.count(ImportEntryStatus.IMPORTED.value) + statuses.count(
        ImportEntryStatus.MERGED.value
    )
    batch.skipped_entries = statuses.count(ImportEntryStatus.SKIPPED.value)
    batch.failed_entries = statuses.count(ImportEntryStatus.FAILED.value)
    undecided = statuses.count(ImportEntryStatus.PROPOSED.value) + statuses.count(
        ImportEntryStatus.APPROVED.value
    )
    batch.status = (
        ImportStatus.COMPLETED.value
        if undecided == 0 and batch.failed_entries == 0
        else ImportStatus.REVIEW.value
    )
    if batch.status == ImportStatus.COMPLETED.value:
        batch.completed_at = datetime.now(UTC)
    batch.metadata_json = {
        **(batch.metadata_json or {}),
        "last_apply": {
            "created": created,
            "merged": merged,
            "skipped": skipped,
            "rejected": rejected,
            "failed": failed,
        },
    }
    db.commit()
    return ImportApplyResult(
        batch=serialize_batch(db, batch),
        created=created,
        merged=merged,
        skipped=skipped,
        rejected=rejected,
        failed=failed,
        failures=failures,
    )


def apply_import(
    db: Session, batch: ImportBatch, request_entries: list[ImportApplyEntry]
) -> ImportApplyResult:
    if batch.metadata_json.get("hierarchy"):
        return apply_hierarchy_import(db, batch, request_entries)
    if batch.status not in {ImportStatus.REVIEW.value, ImportStatus.COMPLETED.value}:
        raise ValueError("This import is not ready to apply.")
    batch.status = ImportStatus.APPLYING.value
    db.commit()
    entries = {
        entry.id: entry
        for entry in db.scalars(select(ImportEntry).where(ImportEntry.batch_id == batch.id)).all()
    }
    created = merged = skipped = rejected = failed = 0
    failures: list[ImportApplyFailure] = []
    for request in request_entries:
        entry = entries.get(request.id)
        if entry is None:
            failures.append(
                ImportApplyFailure(entry_id=request.id, message="Import entry not found.")
            )
            failed += 1
            continue
        if entry.status in {ImportEntryStatus.IMPORTED.value, ImportEntryStatus.MERGED.value}:
            skipped += 1
            continue
        proposed = request.proposed or ProposedItem.model_validate(entry.proposed)
        # A skip changes what is kept for the row, so its revision goes up.
        revision = draft_revision(entry.proposed) + 1
        savepoint = db.begin_nested()
        try:
            entry.proposed = _proposed_json(proposed)
            entry.field_sources = proposed.field_sources
            if request.action == "reject":
                entry.proposed = _proposed_json(proposed, request, revision)
                entry.status = ImportEntryStatus.REJECTED.value
                rejected += 1
                savepoint.commit()
                continue
            if request.action == "skip":
                # The edited row and its choices (action, target) are kept, for Restore.
                entry.proposed = _proposed_json(proposed, request, revision)
                entry.status = ImportEntryStatus.SKIPPED.value
                entry.duplicate_resolution = "skip"
                skipped += 1
                savepoint.commit()
                continue
            if request.action == "merge":
                if not request.merge_item_id:
                    raise ValueError("Choose an existing item to merge into.")
                if not request.merge_fields:
                    raise ValueError("Choose at least one field to merge.")
                item = get_item(db, batch.household_id, request.merge_item_id)
                _merge_from_proposal(db, batch.household_id, item, proposed, request.merge_fields)
                entry.status = ImportEntryStatus.MERGED.value
                entry.matched_item_id = item.id
                entry.duplicate_resolution = "merge"
                merged += 1
                savepoint.commit()
                continue
            item_payload = _item_create_from_proposal(db, batch.household_id, proposed)
            if proposed.room and proposed.room.status == "ambiguous":
                raise ValueError("Resolve the room match before importing this entry.")
            if proposed.storage_location and proposed.storage_location.status == "ambiguous":
                raise ValueError("Resolve the storage-location match before importing.")
            item = create_item_record(db, batch.household_id, item_payload)
            entry.status = ImportEntryStatus.IMPORTED.value
            entry.imported_item_id = item.id
            entry.duplicate_resolution = "new"
            created += 1
            savepoint.commit()
        except Exception as exc:  # noqa: BLE001 - one bad entry must not lose the batch
            savepoint.rollback()
            entry = db.get(ImportEntry, request.id)
            if entry is not None:
                entry.status = ImportEntryStatus.FAILED.value
                entry.error = _safe_error(exc)
                failed += 1
                failures.append(
                    ImportApplyFailure(entry_id=entry.id, message=entry.error or "Import failed.")
                )
    db.commit()
    counts = db.execute(select(ImportEntry.status).where(ImportEntry.batch_id == batch.id)).all()
    statuses = [row[0] for row in counts]
    batch.imported_entries = statuses.count(ImportEntryStatus.IMPORTED.value) + statuses.count(
        ImportEntryStatus.MERGED.value
    )
    batch.skipped_entries = statuses.count(ImportEntryStatus.SKIPPED.value)
    batch.failed_entries = statuses.count(ImportEntryStatus.FAILED.value)
    undecided = statuses.count(ImportEntryStatus.PROPOSED.value) + statuses.count(
        ImportEntryStatus.APPROVED.value
    )
    batch.status = (
        ImportStatus.COMPLETED.value
        if undecided == 0 and batch.failed_entries == 0
        else ImportStatus.REVIEW.value
    )
    if batch.status == ImportStatus.COMPLETED.value:
        batch.completed_at = datetime.now(UTC)
    batch.metadata_json = {
        **(batch.metadata_json or {}),
        "last_apply": {
            "created": created,
            "merged": merged,
            "skipped": skipped,
            "rejected": rejected,
            "failed": failed,
        },
    }
    db.commit()
    return ImportApplyResult(
        batch=_batch_detail(db, batch),
        created=created,
        merged=merged,
        skipped=skipped,
        rejected=rejected,
        failed=failed,
        failures=failures,
    )


# A row in one of these states still waits for a decision. A failed row is one: it
# stays in the review and can be corrected and tried again.
_WAITING_ENTRY_STATUSES = {
    ImportEntryStatus.PROPOSED.value,
    ImportEntryStatus.APPROVED.value,
    ImportEntryStatus.FAILED.value,
}


def save_import_entry_draft(
    db: Session, batch: ImportBatch, entry_id: uuid.UUID, request: ImportEntryDraftRequest
) -> ImportEntry:
    """Keep the corrections of a row that still waits. Nothing is decided or added.

    The draft is stored where Skip stores it: the edited proposal, with the choices of
    the row inside it. The proposal as it was read before the first correction is kept
    with it. That first reading is what optional AI suggestions were made for, so a
    kept correction does not make them out of date. The status, the error, the counts
    of the batch and the inventory are not touched. A request with no row field puts
    the first reading back.

    Two devices can correct the same row. The draft has a revision, and the request
    says which revision it was made on. ``decide`` says what happens, while the row is
    locked. A conflict raises ``DraftConflict`` and stores nothing.
    """
    # The batch is locked first, so that this cannot run in the middle of an apply.
    batch = db.scalar(
        select(ImportBatch)
        .where(ImportBatch.id == batch.id, ImportBatch.household_id == batch.household_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if batch is None:
        raise ApiError(404, "import_not_found", "Import not found.")
    if batch.status == ImportStatus.APPLYING.value:
        raise ApiError(
            409, "import_busy", "Rows of this import are being added right now. Try again."
        )
    entry = db.scalar(
        select(ImportEntry)
        .where(ImportEntry.id == entry_id, ImportEntry.batch_id == batch.id)
        .with_for_update()
    )
    if entry is None:
        raise ApiError(404, "import_entry_not_found", "Import entry not found.")
    if (
        batch.status not in {ImportStatus.REVIEW.value, ImportStatus.COMPLETED.value}
        or entry.status not in _WAITING_ENTRY_STATUSES
    ):
        raise ApiError(
            409,
            "import_entry_not_pending",
            "This row is no longer waiting. Its corrections were not kept.",
        )
    if (
        "parent_entry_id" in request.model_fields_set
        and request.parent_entry_id is not None
        and (
            request.parent_entry_id == entry.id
            or db.scalar(
                select(ImportEntry.id).where(
                    ImportEntry.id == request.parent_entry_id,
                    ImportEntry.batch_id == batch.id,
                )
            )
            is None
        )
    ):
        raise ApiError(422, "import_draft_invalid", "Choose a parent from this import.")
    # The first reading stays the one that was there before the first correction.
    base = first_reading(entry.proposed)
    kept = kept_draft(entry.proposed)
    revision = draft_revision(entry.proposed) + 1
    if not (request.model_fields_set - {"expected_revision", "writer"}):
        # Take the draft back. Its revision is kept, so that an older correction from
        # another device is still seen as older.
        stored = (
            without_draft(base, revision=revision, writer=request.writer)
            if base is not None and not is_stub(kept)
            else None
        )
    else:
        proposed = request.proposed or ProposedItem.model_validate(entry.proposed)
        data = _proposed_json(proposed, request)
        stored = with_draft(
            data,
            data["relationships"][REVIEW_DRAFT_KEY],
            base or source_proposed(entry.proposed),
            revision=revision,
            writer=request.writer,
        )
    outcome = decide(
        kept,
        expected=request.expected_revision,
        writer=request.writer,
        same=stored is None or same_draft(stored, entry.proposed),
    )
    if outcome == "conflict":
        raise DraftConflict(revision - 1)
    if outcome == "store" and stored is not None:
        entry.proposed = stored
    db.commit()
    return entry


def restore_import_entry(db: Session, batch: ImportBatch, entry_id: uuid.UUID) -> ImportBatch:
    """Put a skipped or rejected entry back into the review, with its saved edits.

    Skip and Reject are remembered so that a row does not come back by itself. This is
    the explicit way back. An imported or merged entry is never reopened. The proposal,
    with the review draft inside it, is left exactly as it was saved with the skip.
    """
    entry = db.scalar(
        select(ImportEntry)
        .where(ImportEntry.id == entry_id, ImportEntry.batch_id == batch.id)
        .with_for_update()
    )
    if entry is None:
        raise ApiError(404, "import_entry_not_found", "Import entry not found.")
    if entry.status not in {
        ImportEntryStatus.SKIPPED.value,
        ImportEntryStatus.REJECTED.value,
    }:
        raise ApiError(
            409,
            "import_entry_not_skipped",
            "Only a skipped row can be restored. Refresh the review.",
        )
    entry.status = ImportEntryStatus.PROPOSED.value
    entry.duplicate_resolution = None
    entry.error = None
    db.flush()
    statuses = list(
        db.scalars(select(ImportEntry.status).where(ImportEntry.batch_id == batch.id)).all()
    )
    batch.skipped_entries = statuses.count(ImportEntryStatus.SKIPPED.value)
    # A finished batch has an open row again, so it is back in review.
    if batch.status == ImportStatus.COMPLETED.value:
        batch.status = ImportStatus.REVIEW.value
        batch.completed_at = None
    db.commit()
    return batch
