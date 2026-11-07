"""Authenticated item image sources, reference lookup and illustration jobs."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...db import get_db
from ...domain import JobStatus
from ...jobs import enqueue
from ...models import Item, ItemImage, Job
from ...schemas.item_images import (
    ItemImageBatchJobOut,
    ItemImageBatchPreview,
    ItemImageBatchPreviewRequest,
    ItemImageBatchRequest,
    ItemImageFindRequest,
    ItemImageState,
)
from ...services import item_image_search as image_search
from ...services import item_images as image_service
from ...services import storage
from ...services.items import get_item
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(tags=["item-images"])


def _search_availability(db: Session, household_id: uuid.UUID):
    provider = image_search.resolve_image_search_provider(db, household_id)
    if not provider.configured:
        return False, provider.label, provider.reason
    return True, provider.label, None


def _search_state(db: Session, household_id: uuid.UUID):
    search_configured, search_label, search_reason = _search_availability(db, household_id)
    return {
        "search_configured": search_configured,
        "search_provider_label": search_label,
        "search_reason": search_reason,
    }


def _state(db: Session, item: Item) -> ItemImageState:
    return image_service.state_out(item, **_search_state(db, item.household_id))


def _item(db: Session, household_id: uuid.UUID, item_id: uuid.UUID) -> Item:
    return get_item(db, household_id, item_id)


def _authorized_image(db: Session, household_id: uuid.UUID, image_id: uuid.UUID) -> ItemImage:
    image = db.scalar(
        select(ItemImage)
        .join(Item, Item.id == ItemImage.item_id)
        .where(ItemImage.id == image_id, Item.household_id == household_id)
    )
    if image is None:
        raise ApiError(404, "item_image_not_found", "Item image not found.")
    return image


@router.get("/items/{item_id}/image", response_model=ItemImageState)
def read_item_image(
    item_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemImageState:
    return _state(db, _item(db, auth.household.id, item_id))


@router.post("/items/{item_id}/image/find", response_model=ItemImageState)
def find_item_image(
    item_id: uuid.UUID,
    payload: ItemImageFindRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemImageState:
    item = _item(db, auth.household.id, item_id)
    image_search.find_and_select_reference(
        db,
        auth.household.id,
        item,
        actor_user_id=auth.user.id,
        force=payload.force,
    )
    db.commit()
    db.refresh(item)
    return _state(db, item)


@router.delete("/items/{item_id}/image", response_model=ItemImageState)
def remove_item_image(
    item_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemImageState:
    item = _item(db, auth.household.id, item_id)
    selected = image_service.active_image(item)
    if selected is not None:
        image_service.delete_item_image(db, auth.household.id, item.id, selected.id)
    db.commit()
    db.refresh(item)
    return _state(db, item)


@router.post("/items/{item_id}/image/reset", response_model=ItemImageState)
def reset_item_image(
    item_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemImageState:
    return remove_item_image(item_id, auth, db)


@router.post("/items/{item_id}/illustration")
def generate_item_illustration(
    item_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
) -> None:
    del item_id, auth
    raise ApiError(
        410,
        "feature_retired",
        "Item illustration generation was retired. Existing AI illustrations remain "
        "viewable and removable, and public reference-image lookup is unchanged.",
    )


@router.post("/items/{item_id}/images/{image_id}/accept")
def accept_item_image(
    item_id: uuid.UUID,
    image_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
) -> None:
    del item_id, image_id, auth
    raise ApiError(
        410,
        "feature_retired",
        "Pending illustration acceptance was retired. Existing AI illustrations "
        "remain viewable and removable.",
    )


@router.delete("/items/{item_id}/images/{image_id}", response_model=ItemImageState)
def delete_item_image(
    item_id: uuid.UUID,
    image_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemImageState:
    image_service.delete_item_image(db, auth.household.id, item_id, image_id)
    db.commit()
    item = _item(db, auth.household.id, item_id)
    return _state(db, item)


def _items_for_batch(db: Session, household_id: uuid.UUID, item_ids: list[uuid.UUID]) -> list[Item]:
    unique = list(dict.fromkeys(item_ids))
    items = db.scalars(
        select(Item).where(Item.id.in_(unique), Item.household_id == household_id)
    ).all()
    if len(items) != len(unique):
        raise ApiError(404, "item_not_found", "One or more selected items were not found.")
    return list(items)


def _preview(
    db: Session,
    household_id: uuid.UUID,
    item_ids: list[uuid.UUID],
    action: str,
) -> ItemImageBatchPreview:
    if action != "reference":
        raise ApiError(
            410,
            "feature_retired",
            "Bulk illustration generation was retired. Choose public reference-image "
            "lookup instead.",
        )
    items = _items_for_batch(db, household_id, item_ids)
    search_ready, _search_label, search_reason = _search_availability(db, household_id)
    eligible = 0
    has_photo = 0
    unavailable = 0
    for item in items:
        if item.photos:
            has_photo += 1
            continue
        if item.is_archived:
            unavailable += 1
            continue
        if not search_ready or not image_search.reference_search_ready(item):
            unavailable += 1
            continue
        eligible += 1
    notices = []
    if not search_ready:
        notices.append(search_reason or "Reference-image search is not configured.")
    return ItemImageBatchPreview(
        action="reference",
        selected_count=len(items),
        eligible_count=eligible,
        skipped_has_photo=has_photo,
        skipped_unavailable=unavailable,
        notices=notices,
    )


@router.post("/items/images/batch/preview", response_model=ItemImageBatchPreview)
def preview_image_batch(
    payload: ItemImageBatchPreviewRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemImageBatchPreview:
    return _preview(db, auth.household.id, payload.item_ids, payload.action)


def _job_out(job: Job) -> ItemImageBatchJobOut:
    result = job.result or {}
    payload = job.payload or {}
    return ItemImageBatchJobOut(
        job_id=job.id,
        status=job.status,
        action=str(payload.get("action") or ""),
        total=int(payload.get("total") or 0),
        completed=int(result.get("completed") or 0),
        failed=int(result.get("failed") or 0),
        skipped=int(result.get("skipped") or 0),
        error=job.last_error,
        created_at=job.created_at,
        finished_at=job.finished_at,
    )


@router.post("/items/images/batch", response_model=ItemImageBatchJobOut, status_code=202)
def create_image_batch(
    payload: ItemImageBatchRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemImageBatchJobOut:
    preview = _preview(db, auth.household.id, payload.item_ids, payload.action)
    if preview.eligible_count == 0:
        raise ApiError(
            422,
            "no_eligible_items",
            "No selected item can use this image action. " + " ".join(preview.notices),
        )
    existing = db.scalar(
        select(Job).where(
            Job.task == "item_images.batch",
            Job.payload["request_id"].astext == str(payload.request_id),
        )
    )
    if existing is not None:
        if existing.payload.get("action") != payload.action or existing.payload.get("item_ids") != [
            str(value) for value in payload.item_ids
        ]:
            raise ApiError(
                409,
                "request_id_reused",
                "That request id was used for a different image batch.",
            )
        return _job_out(existing)
    job = enqueue(
        db,
        "item_images.batch",
        {},
        max_attempts=1,
        commit=False,
    )
    job.payload = {
        "job_id": str(job.id),
        "household_id": str(auth.household.id),
        "created_by_user_id": str(auth.user.id),
        "action": payload.action,
        "item_ids": [str(value) for value in payload.item_ids],
        "total": preview.eligible_count,
        "request_id": str(payload.request_id),
    }
    db.commit()
    db.refresh(job)
    return _job_out(job)


@router.get("/items/images/batch/{job_id}", response_model=ItemImageBatchJobOut)
def read_image_batch(
    job_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemImageBatchJobOut:
    job = db.get(Job, job_id)
    if (
        job is None
        or job.task != "item_images.batch"
        or (job.payload or {}).get("household_id") != str(auth.household.id)
    ):
        raise ApiError(404, "image_job_not_found", "Image batch job not found.")
    return _job_out(job)


@router.post("/items/images/batch/{job_id}/cancel", response_model=ItemImageBatchJobOut)
def cancel_image_batch(
    job_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ItemImageBatchJobOut:
    job = db.get(Job, job_id)
    if (
        job is None
        or job.task != "item_images.batch"
        or (job.payload or {}).get("household_id") != str(auth.household.id)
    ):
        raise ApiError(404, "image_job_not_found", "Image batch job not found.")
    if job.status in {JobStatus.QUEUED.value, JobStatus.RUNNING.value}:
        job.status = JobStatus.CANCELLED.value
        job.finished_at = datetime.now(UTC)
        db.commit()
        db.refresh(job)
    return _job_out(job)


@router.get("/item-images/{image_id}/file")
def item_image_file(
    image_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    image = _authorized_image(db, auth.household.id, image_id)
    if not image.storage_key:
        raise ApiError(404, "file_not_found", "File not found.")
    return FileResponse(
        storage.resolve_key(image.storage_key),
        media_type=image.content_type or "application/octet-stream",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )


@router.get("/item-images/{image_id}/thumbnail")
def item_image_thumbnail(
    image_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    image = _authorized_image(db, auth.household.id, image_id)
    key = image.thumbnail_key or image.storage_key
    if not key:
        raise ApiError(404, "file_not_found", "File not found.")
    return FileResponse(
        storage.resolve_key(key),
        media_type="image/webp" if image.thumbnail_key else (image.content_type or "image/jpeg"),
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )
