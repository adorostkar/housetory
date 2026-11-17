import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...db import get_db
from ...domain import RETIRED_AI_TASKS, RecognitionStatus
from ...models import AiRecognition, Room
from ...schemas.ai import (
    AiRecognitionApplyRequest,
    AiRecognitionApplyResult,
    AiRecognitionOut,
    AiStatus,
    DocumentRelations,
    DocumentRelationSuggestion,
)
from ...schemas.items import ItemSummary
from ...services import ai as ai_service
from ...services import properties as property_service
from ...services import storage
from ...services.ai_tools import document_relations
from ...services.documents import get_document
from ...services.items import resolve_location
from ...services.recognition import (
    apply_recognition,
    enqueue_recognition,
    serialize_recognition,
)
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(tags=["ai"])


def _get_recognition(
    db: Session, household_id: uuid.UUID, recognition_id: uuid.UUID
) -> AiRecognition:
    recognition = db.scalar(
        select(AiRecognition).where(
            AiRecognition.id == recognition_id,
            AiRecognition.household_id == household_id,
        )
    )
    if recognition is None:
        raise ApiError(404, "recognition_not_found", "Recognition not found.")
    return recognition


def _reject_linked_recognition(recognition: AiRecognition) -> None:
    if (recognition.result or {}).get("_add_items", {}).get("import_batch_id"):
        raise ApiError(
            409,
            "recognition_already_in_import",
            "This recognition already has an import review. Continue from that review instead.",
        )


@router.get("/ai/status", response_model=AiStatus)
def ai_status(
    task: str = Query(
        default="assistant",
        pattern=(r"^(assistant|imports|documents|search|vision|labels|transcription|item_images)$"),
    ),
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> AiStatus:
    if task in {retired.value for retired in RETIRED_AI_TASKS}:
        raise ApiError(
            410,
            "ai_task_retired",
            "This AI task was retired. Existing results remain readable, but it "
            "cannot be configured or tested anymore.",
        )
    return ai_service.provider_status(
        probe=True,
        db=db,
        household_id=auth.household.id,
        task=task,
    )


@router.post("/ai/recognitions", response_model=AiRecognitionOut, status_code=201)
def create_recognition(
    file: Annotated[UploadFile, File()],
    location_id: Annotated[uuid.UUID | None, Form()] = None,
    room_id: Annotated[uuid.UUID | None, Form()] = None,
    property_id: Annotated[uuid.UUID | None, Form()] = None,
    text: Annotated[str | None, Form(max_length=10_000)] = None,
    assistant_capture: Annotated[bool, Form()] = False,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> AiRecognitionOut:
    room_id, location_record = resolve_location(db, auth.household.id, room_id, location_id)
    location_id = location_record.id if location_record is not None else None
    property_record = (
        property_service.get_property(db, auth.household.id, property_id)
        if property_id is not None
        else None
    )
    if room_id is not None and property_record is not None:
        room = db.get(Room, room_id)
        if room is not None and room.property_id != property_record.id:
            raise ApiError(
                422,
                "context_mismatch",
                "The selected room belongs to a different property.",
            )
    context_text = (text or "").strip()
    add_items = (
        {"text": context_text, "property_id": str(property_record.id) if property_record else None}
        if context_text or property_record is not None or assistant_capture
        else None
    )
    if assistant_capture:
        add_items = {**(add_items or {}), "assistant_capture": True}
    stored = storage.store_ai_image(auth.household.id, file)
    recognition = AiRecognition(
        household_id=auth.household.id,
        storage_key=stored.storage_key,
        original_storage_key=stored.original_storage_key,
        original_filename=stored.original_filename,
        content_type=stored.content_type,
        original_content_type=stored.original_content_type,
        byte_size=stored.byte_size,
        original_byte_size=stored.original_byte_size,
        width=stored.width,
        height=stored.height,
        room_id=room_id,
        location_id=location_id,
        status=RecognitionStatus.QUEUED.value,
        result={"_add_items": add_items} if add_items is not None else {},
        field_sources={},
    )
    db.add(recognition)
    try:
        db.flush()
        enqueue_recognition(db, recognition)
    except Exception:
        db.rollback()
        storage.delete_key(stored.storage_key)
        storage.delete_key(stored.original_storage_key)
        raise
    db.refresh(recognition)
    return serialize_recognition(recognition, db, auth.household.id)


@router.get("/ai/recognitions/{recognition_id}", response_model=AiRecognitionOut)
def read_recognition(
    recognition_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> AiRecognitionOut:
    return serialize_recognition(
        _get_recognition(db, auth.household.id, recognition_id), db, auth.household.id
    )


@router.get("/ai/recognitions/{recognition_id}/image")
def recognition_image(
    recognition_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    recognition = _get_recognition(db, auth.household.id, recognition_id)
    path = storage.resolve_key(recognition.storage_key)
    return FileResponse(
        path,
        media_type=recognition.content_type,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )


@router.get("/ai/recognitions/{recognition_id}/original")
def recognition_original(
    recognition_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> FileResponse:
    recognition = _get_recognition(db, auth.household.id, recognition_id)
    path = storage.resolve_key(recognition.original_storage_key)
    filename = recognition.original_filename.replace('"', "")
    return FileResponse(
        path,
        media_type=recognition.original_content_type,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


@router.post(
    "/ai/recognitions/{recognition_id}/apply",
    response_model=AiRecognitionApplyResult,
)
def apply_recognition_route(
    recognition_id: uuid.UUID,
    payload: AiRecognitionApplyRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> AiRecognitionApplyResult:
    recognition = _get_recognition(db, auth.household.id, recognition_id)
    _reject_linked_recognition(recognition)
    try:
        return apply_recognition(db, auth.household.id, recognition, payload)
    except ValueError as exc:
        db.rollback()
        raise ApiError(422, "recognition_apply_failed", str(exc)) from None


@router.post("/ai/recognitions/{recognition_id}/retry", response_model=AiRecognitionOut)
def retry_recognition(
    recognition_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> AiRecognitionOut:
    recognition = _get_recognition(db, auth.household.id, recognition_id)
    _reject_linked_recognition(recognition)
    if recognition.status == RecognitionStatus.QUEUED.value:
        raise ApiError(409, "recognition_in_progress", "This photo is already queued.")
    enqueue_recognition(db, recognition)
    db.refresh(recognition)
    return serialize_recognition(recognition, db, auth.household.id)


@router.delete("/ai/recognitions/{recognition_id}", status_code=204)
def delete_recognition(
    recognition_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    recognition = _get_recognition(db, auth.household.id, recognition_id)
    keys = [recognition.storage_key, recognition.original_storage_key]
    db.delete(recognition)
    db.commit()
    for key in keys:
        storage.delete_key(key)
    return Response(status_code=204)


@router.get("/documents/{document_id}/related-items", response_model=DocumentRelations)
def document_related_items(
    document_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> DocumentRelations:
    document = get_document(db, auth.household.id, document_id)
    suggestions = document_relations(
        db,
        auth.household.id,
        document,
        household_reminder_days=auth.household.warranty_reminder_days,
    )
    items = [
        DocumentRelationSuggestion(
            item=ItemSummary.model_validate(suggestion["item"]),
            score=suggestion["score"],
            reasons=suggestion["reasons"],
        )
        for suggestion in suggestions
    ]
    return DocumentRelations(
        items=items,
        suggested_item_ids=[entry.item.id for entry in items],
    )
