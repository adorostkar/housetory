import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...db import get_db
from ...domain import RETIRED_AI_TASKS, RecognitionStatus
from ...models import AiRecognition
from ...schemas.ai import (
    AiRecognitionApplyRequest,
    AiRecognitionApplyResult,
    AiRecognitionList,
    AiRecognitionOut,
    AiStatus,
    AssistantRequest,
    AssistantResponse,
    DocumentRelations,
    DocumentRelationSuggestion,
    NaturalSearchRequest,
    NaturalSearchResponse,
)
from ...schemas.items import ItemSummary
from ...services import ai as ai_service
from ...services import global_assistant, global_search, storage, unified_search
from ...services.ai_tools import document_relations
from ...services.assistant import answer_question, natural_search
from ...services.documents import get_document
from ...services.items import resolve_location
from ...services.query_text import contains_non_latin
from ...services.recognition import (
    apply_recognition,
    enqueue_recognition,
    serialize_recognition,
)
from ..abuse import enforce_search_limit
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


def _unified_assistant_response(response) -> AssistantResponse:  # noqa: ANN001
    return AssistantResponse(
        answer=response.answer or "No grounded answer was produced.",
        mode="ai" if response.ai_used else "deterministic",
        tool=response.tool,
        filters=response.filters.model_dump(mode="json", exclude_none=True),
        items=response.items,
        borrowed=response.borrowed,
        documents=response.documents,
        locations=response.locations,
        references=response.references,
        notices=response.notices,
        facts=response.facts,
        ai_status=response.ai_status,
        scope_label=response.scope_label,
        households=response.households,
        property=response.property,
    )


def _unified_natural_response(response) -> NaturalSearchResponse:  # noqa: ANN001
    return NaturalSearchResponse(
        question=response.query,
        interpretation=response.interpretation,
        filters=response.filters,
        items=response.items,
        borrowed=response.borrowed,
        borrowed_total=response.borrowed_total,
        total=response.total,
        mode="ai" if response.ai_used else "deterministic",
        ai_available=response.ai_status.configured,
        answer=response.answer,
        answer_kind=response.answer_kind,
        tool=response.tool,
        facts=response.facts,
        notices=response.notices,
        references=response.references,
        needs_assistant=response.mode == "fallback"
        and not response.items
        and not response.borrowed,
        suggested_question=response.query,
        scope_label=response.scope_label,
        households=response.households,
        property=response.property,
    )


@router.post("/assistant/query", response_model=AssistantResponse)
def assistant_query(
    payload: AssistantRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> AssistantResponse:
    enforce_search_limit(auth.user.id)
    if contains_non_latin(payload.question):
        return _unified_assistant_response(
            unified_search.execute_search(
                db,
                user_id=auth.user.id,
                query=payload.question,
                explicit_ask=True,
                history=payload.history,
                household_id=payload.household_id,
                property_id=payload.property_id,
            )
        )
    scope = global_search.resolve_search_scope(
        db,
        auth.user.id,
        household_id=payload.household_id,
        property_id=payload.property_id,
    )
    if len(scope.households) == 1 and scope.property is None:
        household, _role = scope.households[0]
        response = answer_question(
            db,
            household.id,
            payload,
            household_reminder_days=household.warranty_reminder_days,
        )
        return response.model_copy(
            update={
                "scope_label": household.name,
                "households": global_search.scope_households(scope),
                "property": global_search.scope_property(scope.property),
            }
        )
    return global_assistant.answer_all_places(db, scope, payload)


@router.post("/search/natural", response_model=NaturalSearchResponse)
def natural_search_route(
    payload: NaturalSearchRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> NaturalSearchResponse:
    enforce_search_limit(auth.user.id)
    if contains_non_latin(payload.question):
        return _unified_natural_response(
            unified_search.execute_search(
                db,
                user_id=auth.user.id,
                query=payload.question,
                explicit_ask=False,
                limit=payload.limit,
                household_id=payload.household_id,
                property_id=payload.property_id,
            )
        )
    scope = global_search.resolve_search_scope(
        db,
        auth.user.id,
        household_id=payload.household_id,
        property_id=payload.property_id,
    )
    if len(scope.households) == 1 and scope.property is None:
        household, _role = scope.households[0]
        response = natural_search(
            db,
            household.id,
            payload.question,
            household_reminder_days=household.warranty_reminder_days,
            limit=payload.limit,
        )
        return response.model_copy(
            update={
                "scope_label": household.name,
                "households": global_search.scope_households(scope),
                "property": global_search.scope_property(scope.property),
            }
        )
    return global_assistant.natural_search_all_places(
        db,
        scope,
        payload.question,
        limit=payload.limit,
    )


@router.post("/ai/recognitions", response_model=AiRecognitionOut, status_code=201)
def create_recognition(
    file: Annotated[UploadFile, File()],
    location_id: Annotated[uuid.UUID | None, Form()] = None,
    room_id: Annotated[uuid.UUID | None, Form()] = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> AiRecognitionOut:
    room_id, location_record = resolve_location(db, auth.household.id, room_id, location_id)
    location_id = location_record.id if location_record is not None else None
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
        result={},
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


@router.get("/ai/recognitions", response_model=AiRecognitionList)
def list_recognitions(
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> AiRecognitionList:
    recognitions = db.scalars(
        select(AiRecognition)
        .where(AiRecognition.household_id == auth.household.id)
        .order_by(AiRecognition.created_at.desc())
        .limit(limit)
    ).all()
    return AiRecognitionList(
        items=[
            serialize_recognition(recognition, db, auth.household.id)
            for recognition in recognitions
        ]
    )


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
