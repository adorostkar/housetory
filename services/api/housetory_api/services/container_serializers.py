"""Serialization helpers shared by container routes and label generation."""

import uuid
from collections import Counter
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Item, StorageLocation
from ..schemas.common import ItemReference
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
    load_container_items,
    location_breadcrumb,
    location_rows,
    related_documents,
    room_ancestors,
    summary_for_location,
)
from .hierarchy import descendant_ids, descendant_totals
from .lending import loan_quantities_for_items
from .serializers import document_brief, item_load_options, item_summary


def qr_urls(location: StorageLocation) -> tuple[str, str, str | None]:
    settings = get_settings()
    payload = f"{settings.qr_effective_base_url}/containers/{location.id}"
    return (
        payload,
        f"{settings.api_prefix}/containers/{location.id}/qr.svg",
        settings.qr_base_url_warning,
    )


def location_path_map(
    db: Session,
    household_id: uuid.UUID,
    *,
    locations: list[StorageLocation] | None = None,
    requested_ids: set[uuid.UUID] | None = None,
) -> dict[uuid.UUID, list[LocationBrief]]:
    if locations is None:
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

    for location_id in requested_ids if requested_ids is not None else by_id:
        path_for(location_id)
    return result


@dataclass
class ContainerListContext:
    paths: dict[uuid.UUID, list[LocationBrief]]
    counts: dict[uuid.UUID, tuple[int, int, int, int, int, int]]


def container_list_context(db: Session, household_id: uuid.UUID) -> ContainerListContext:
    locations = list(
        db.scalars(
            select(StorageLocation).where(StorageLocation.household_id == household_id)
        ).all()
    )
    live = [location for location in locations if location.deleted_at is None]
    live_rows = [(location.id, location.parent_id) for location in live]
    all_rows = [(location.id, location.parent_id) for location in locations]
    item_rows = db.execute(
        select(StorageLocation.id, func.count(Item.id), func.coalesce(func.sum(Item.quantity), 0))
        .join(Item, Item.storage_location_id == StorageLocation.id)
        .where(
            StorageLocation.household_id == household_id,
            Item.household_id == household_id,
            Item.is_archived.is_(False),
        )
        .group_by(StorageLocation.id)
    ).all()
    direct = {location_id: count for location_id, count, quantity in item_rows}
    quantities = {location_id: quantity for location_id, count, quantity in item_rows}
    totals = descendant_totals(live_rows, direct)
    total_quantities = descendant_totals(live_rows, quantities)
    children = Counter(location.parent_id for location in live)
    containers = descendant_totals(
        live_rows, {location.id: 1 for location in live if location.is_container}
    )
    deleted = descendant_totals(
        all_rows, {location.id: 1 for location in locations if location.deleted_at is not None}
    )
    return ContainerListContext(
        paths=location_path_map(db, household_id, locations=live),
        counts={
            location.id: (
                direct.get(location.id, 0),
                totals.get(location.id, 0),
                total_quantities.get(location.id, 0),
                children.get(location.id, 0),
                containers.get(location.id, 0),
                deleted.get(location.id, 0),
            )
            for location in live
        },
    )


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
    *,
    context: ContainerListContext | None = None,
) -> ContainerOut:
    payload, qr_endpoint, warning = qr_urls(location)
    (
        item_count,
        total_item_count,
        total_quantity,
        child_count,
        container_count,
        recoverable_deleted_child_count,
    ) = context.counts[location.id] if context is not None else _counts(db, household_id, location)
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
        path=(
            context.paths[location.id]
            if context is not None
            else location_breadcrumb(db, household_id, location.id)
        ),
        item_count=item_count,
        total_item_count=total_item_count,
        total_quantity=total_quantity,
        child_count=child_count,
        container_count=container_count,
        recoverable_deleted_child_count=recoverable_deleted_child_count,
        owner_item=(
            ItemReference(id=location.owner_item.id, name=location.owner_item.name)
            if location.owner_item is not None
            else None
        ),
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
    summary = ContainerSummaryOut(
        item_count=live.item_count,
        total_quantity=live.total_quantity,
        direct_item_count=live.direct_item_count,
        direct_total_quantity=live.direct_total_quantity,
        empty=live.empty,
        categories=live.categories,
        label_generated_at=location.label_generated_at,
    )
    room_path = [
        RoomBrief(id=room.id, name=room.name)
        for room in room_ancestors(db, household_id, location.room_id)
    ]
    owner_item_detail = None
    if location.owner_item_id is not None:
        owner_item = db.scalar(
            select(Item)
            .options(*item_load_options())
            .where(Item.id == location.owner_item_id, Item.household_id == household_id)
        )
        if owner_item is not None:
            owner_on_loan = loan_quantities_for_items(db, household_id, [owner_item.id]).get(
                owner_item.id, 0
            )
            owner_item_detail = item_summary(owner_item, on_loan_quantity=owner_on_loan)
    return ContainerDetail(
        **base.model_dump(),
        room_path=room_path,
        items=summaries,
        children=children,
        documents=[document_brief(document) for document in documents],
        summary=summary,
        owner_item_detail=owner_item_detail,
    )
