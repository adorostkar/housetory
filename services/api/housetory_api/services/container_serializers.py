"""Serialization helpers shared by container routes and label generation."""

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Item, StorageLocation
from ..schemas.containers import (
    ContainerBrief,
    ContainerDetail,
    ContainerOut,
    ContainerSummaryOut,
)
from ..schemas.items import LocationBrief, RoomBrief
from ..schemas.properties import PropertyBrief
from .containers import (
    container_children,
    contents_updated_at,
    label_is_stale,
    load_container_items,
    location_breadcrumb,
    location_rows,
    related_documents,
    room_ancestors,
    summary_for_location,
    summary_is_stale,
)
from .hierarchy import descendant_ids
from .lending import loan_quantities_for_items
from .serializers import document_brief, item_summary


def qr_urls(location: StorageLocation) -> tuple[str, str, str | None]:
    settings = get_settings()
    payload = f"{settings.qr_effective_base_url}/containers/{location.id}"
    return (
        payload,
        f"{settings.api_prefix}/containers/{location.id}/qr.svg",
        settings.qr_base_url_warning,
    )


def location_path_map(db: Session, household_id: uuid.UUID) -> dict[uuid.UUID, list[LocationBrief]]:
    locations = list(
        db.scalars(
            select(StorageLocation).where(
                StorageLocation.household_id == household_id,
                StorageLocation.active(),
            )
        ).all()
    )
    by_id = {location.id: location for location in locations}
    result: dict[uuid.UUID, list[LocationBrief]] = {}

    def path_for(location_id: uuid.UUID) -> list[LocationBrief]:
        if location_id in result:
            return result[location_id]
        path: list[StorageLocation] = []
        cursor = by_id.get(location_id)
        seen: set[uuid.UUID] = set()
        while cursor is not None and cursor.id not in seen:
            path.append(cursor)
            seen.add(cursor.id)
            cursor = by_id.get(cursor.parent_id) if cursor.parent_id else None
        path.reverse()
        briefs = [
            LocationBrief(
                id=location.id,
                name=location.name,
                kind=location.kind,
                parent_id=location.parent_id,
                identifier=location.identifier,
                container_type=location.container_type,
                is_container=location.is_container,
            )
            for location in path
        ]
        result[location_id] = briefs
        return briefs

    for location in locations:
        path_for(location.id)
    return result


def _counts(
    db: Session, household_id: uuid.UUID, location: StorageLocation
) -> tuple[int, int, int, int, int, int]:
    subtree = descendant_ids(location_rows(db, household_id), location.id)
    direct_items = list(
        db.scalars(
            select(Item).where(
                Item.household_id == household_id,
                Item.storage_location_id == location.id,
                Item.is_archived.is_(False),
            )
        ).all()
    )
    total_items = list(
        db.scalars(
            select(Item).where(
                Item.household_id == household_id,
                Item.storage_location_id.in_(subtree),
                Item.is_archived.is_(False),
            )
        ).all()
    )
    child_count = int(
        db.scalar(
            select(func.count(StorageLocation.id)).where(
                StorageLocation.household_id == household_id,
                StorageLocation.parent_id == location.id,
                StorageLocation.active(),
            )
        )
        or 0
    )
    container_count = int(
        db.scalar(
            select(func.count(StorageLocation.id)).where(
                StorageLocation.household_id == household_id,
                StorageLocation.id.in_(subtree),
                StorageLocation.active(),
                StorageLocation.is_container.is_(True),
            )
        )
        or 0
    )
    all_subtree = descendant_ids(location_rows(db, household_id, include_deleted=True), location.id)
    recoverable_deleted_child_count = len(
        set(
            db.scalars(
                select(StorageLocation.id).where(
                    StorageLocation.household_id == household_id,
                    StorageLocation.id.in_(all_subtree),
                    StorageLocation.deleted_at.is_not(None),
                )
            ).all()
        )
    )
    return (
        len(direct_items),
        len(total_items),
        sum(item.quantity for item in total_items),
        child_count,
        container_count,
        recoverable_deleted_child_count,
    )


def serialize_container(
    db: Session,
    household_id: uuid.UUID,
    location: StorageLocation,
) -> ContainerOut:
    payload, qr_endpoint, warning = qr_urls(location)
    (
        item_count,
        total_item_count,
        total_quantity,
        child_count,
        container_count,
        recoverable_deleted_child_count,
    ) = _counts(db, household_id, location)
    return ContainerOut(
        id=location.id,
        property=PropertyBrief(
            id=location.room.property.id,
            name=location.room.property.name,
            is_archived=location.room.property.is_archived,
        ),
        identifier=location.identifier,
        legacy_identifier=location.legacy_identifier,
        aliases=location.aliases or [],
        name=location.name,
        description=location.description,
        kind=location.kind,
        container_type=location.container_type,
        is_container=location.is_container,
        room_id=location.room_id,
        parent_id=location.parent_id,
        room=RoomBrief(id=location.room.id, name=location.room.name),
        path=location_breadcrumb(db, household_id, location.id),
        item_count=item_count,
        total_item_count=total_item_count,
        total_quantity=total_quantity,
        child_count=child_count,
        container_count=container_count,
        recoverable_deleted_child_count=recoverable_deleted_child_count,
        summary_short=location.summary_short,
        summary_headline=location.summary_headline,
        qr_payload=payload,
        qr_url=qr_endpoint,
        qr_warning=warning,
        label_generated_at=location.label_generated_at,
        created_at=location.created_at,
        updated_at=location.updated_at,
    )


def serialize_container_detail(
    db: Session,
    household_id: uuid.UUID,
    location: StorageLocation,
) -> ContainerDetail:
    base = serialize_container(db, household_id, location)
    items = load_container_items(db, household_id, location.id)
    path_map = location_path_map(db, household_id)
    loan_quantities = loan_quantities_for_items(db, household_id, [item.id for item in items])
    summaries = []
    for item in items:
        summary = item_summary(item, on_loan_quantity=loan_quantities.get(item.id, 0))
        if item.storage_location_id:
            summary = summary.model_copy(
                update={"location_path": path_map.get(item.storage_location_id, [])}
            )
        summaries.append(summary)
    children = [
        ContainerBrief(
            id=child.id,
            identifier=child.identifier,
            legacy_identifier=child.legacy_identifier,
            aliases=child.aliases or [],
            name=child.name,
            kind=child.kind,
            container_type=child.container_type,
            is_container=child.is_container,
            room_id=child.room_id,
            parent_id=child.parent_id,
            item_count=sum(1 for item in items if item.storage_location_id == child.id),
            total_item_count=sum(
                1
                for item in items
                if item.storage_location_id
                and item.storage_location_id
                in descendant_ids(location_rows(db, household_id), child.id)
            ),
            total_quantity=sum(
                item.quantity
                for item in items
                if item.storage_location_id
                and item.storage_location_id
                in descendant_ids(location_rows(db, household_id), child.id)
            ),
            child_count=int(
                db.scalar(
                    select(func.count(StorageLocation.id)).where(
                        StorageLocation.household_id == household_id,
                        StorageLocation.parent_id == child.id,
                        StorageLocation.active(),
                    )
                )
                or 0
            ),
        )
        for child in container_children(db, household_id, location.id)
    ]
    documents = related_documents(db, household_id, [item.id for item in items])
    live = summary_for_location(db, household_id, location, live_items=items)
    stale = summary_is_stale(location, live)
    label_stale = label_is_stale(location, items)
    latest = contents_updated_at(items, location)
    summary = ContainerSummaryOut(
        short=live.short,
        detailed=live.detailed,
        headline=live.headline,
        lines=live.lines,
        detailed_lines=live.detailed_lines,
        item_count=live.item_count,
        total_quantity=live.total_quantity,
        empty=live.empty,
        stale=stale,
        needs_refresh=(not live.stored) or stale,
        stored=live.stored,
        source=live.source,
        contents_hash=live.contents_hash,
        generated_at=live.generated_at,
        label_generated_at=location.label_generated_at,
        label_stale=label_stale,
        contents_updated_at=latest,
    )
    room_path = [
        RoomBrief(id=room.id, name=room.name)
        for room in room_ancestors(db, household_id, location.room_id)
    ]
    return ContainerDetail(
        **base.model_dump(),
        room_path=room_path,
        items=summaries,
        children=children,
        documents=[document_brief(document) for document in documents],
        summary=summary,
    )
