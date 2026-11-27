import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ...db import get_db
from ...domain import OcrStatus
from ...schemas.extraction import (
    ExtractionApplyRequest,
    ExtractionApplyResult,
    ExtractionHeaderDraftRequest,
    ExtractionHeaderDraftState,
    ExtractionLineDraftRequest,
    ExtractionLineSkipRequest,
    ExtractionLineState,
    ExtractionLineStatesOut,
    ExtractionMatchOut,
    ExtractionMatchRequest,
    ExtractionReviewOut,
    LineMatchInput,
)
from ...services import (
    document_extraction,
    document_extraction_apply,
    document_matching,
)
from ...services.documents import get_document
from ...services.draft_revisions import DraftConflict, conflict
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(prefix="/documents", tags=["document-extraction"])


def _review_document(db: Session, household_id: uuid.UUID, document_id: uuid.UUID):
    document = get_document(db, household_id, document_id)
    if document.ocr_status in {OcrStatus.QUEUED.value, OcrStatus.PROCESSING.value}:
        raise ApiError(
            409,
            "extraction_in_progress",
            "OCR is still running. Wait for the document read to finish.",
        )
    if document.ocr_status == OcrStatus.FAILED.value:
        raise ApiError(
            409,
            "extraction_unavailable",
            "OCR failed. Retry OCR with a clearer or better-oriented document "
            "before reviewing extraction.",
        )
    if not (document.extracted_text or "").strip():
        raise ApiError(
            409,
            "extraction_unavailable",
            "This document has no readable OCR text yet.",
        )
    return document


def _line_states(db: Session, document) -> ExtractionLineStatesOut:
    states, version = document_extraction_apply.line_states(db, document)
    return ExtractionLineStatesOut(
        line_states={
            line_id: ExtractionLineState.model_validate(state) for line_id, state in states.items()
        },
        applied_version=version,
    )


def _review(db: Session, document) -> ExtractionReviewOut:
    review = document_extraction.extraction_review(db, document)
    states = _line_states(db, document)
    review.line_states = states.line_states
    review.applied_version = states.applied_version
    header = _header_draft(document)
    review.header_draft = header.header_draft
    review.header_revision = header.header_revision
    review.header_writer = header.header_writer
    return review


def _header_draft(document) -> ExtractionHeaderDraftState:
    revision, writer = document_extraction_apply.header_revision(document)
    return ExtractionHeaderDraftState.model_validate(
        {
            "header_draft": document_extraction_apply.header_draft(document),
            "header_revision": revision,
            "header_writer": writer,
        }
    )


def _line_inputs(document, request: ExtractionMatchRequest | None = None) -> list[LineMatchInput]:
    extraction = (document.extracted_metadata or {}).get("extraction") or {}
    fields = extraction.get("fields") or {}
    stored = {
        str(line.get("id")): line
        for line in extraction.get("lines", [])
        if line.get("kind") == "product"
    }
    if request is not None and request.lines is not None:
        inputs = []
        for line in request.lines:
            source = stored.get(line.line_id)
            if source is None:
                raise ApiError(
                    422,
                    "extraction_line_not_found",
                    "A reviewed line is no longer part of this extraction. Refresh and try again.",
                )
            inputs.append(line)
        return inputs
    product_lines = list(stored.values())
    return [
        LineMatchInput(
            line_id=str(line["id"]),
            description=str(line.get("description") or "Item"),
            quantity=line.get("quantity"),
            brand=fields.get("brand") if len(product_lines) == 1 else None,
            model=fields.get("model") if len(product_lines) == 1 else None,
            serial_numbers=(
                list(fields.get("serial_numbers") or []) if len(product_lines) == 1 else []
            ),
        )
        for line in product_lines
    ]


@router.get("/{document_id}/extraction", response_model=ExtractionReviewOut)
def read_extraction(
    document_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ExtractionReviewOut:
    document = _review_document(db, auth.household.id, document_id)
    return _review(db, document)


@router.post("/{document_id}/extraction/enhancement/retry", response_model=ExtractionReviewOut)
def retry_document_enhancement(
    document_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ExtractionReviewOut:
    from ...services.enrichment import retry_enhancement

    document = _review_document(db, auth.household.id, document_id)
    retry_enhancement(db, document)
    return _review(db, document)


@router.post("/{document_id}/extraction/enhancement/cancel", response_model=ExtractionReviewOut)
def cancel_document_enhancement(
    document_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ExtractionReviewOut:
    from ...services.enrichment import cancel_enhancement

    document = _review_document(db, auth.household.id, document_id)
    cancel_enhancement(db, document)
    return _review(db, document)


@router.post("/{document_id}/extraction/matches", response_model=ExtractionMatchOut)
def match_extraction(
    document_id: uuid.UUID,
    payload: ExtractionMatchRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ExtractionMatchOut:
    document = _review_document(db, auth.household.id, document_id)
    extraction = document_extraction.ensure_extraction(db, document)
    inputs = _line_inputs(document, payload)
    matches, status, ai_used, warnings = document_matching.match_lines(
        db,
        auth.household.id,
        inputs,
        use_ai=payload.use_ai,
    )
    return ExtractionMatchOut(
        document_id=document.id,
        version=str(extraction["version"]),
        matches=matches,
        ai_status=status,
        ai_used=ai_used,
        warnings=warnings,
    )


@router.post("/{document_id}/extraction/apply", response_model=ExtractionApplyResult)
def apply_extraction(
    document_id: uuid.UUID,
    payload: ExtractionApplyRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ExtractionApplyResult:
    document = _review_document(db, auth.household.id, document_id)
    document_extraction.ensure_extraction(db, document)
    return document_extraction_apply.apply_extraction(
        db,
        auth.household.id,
        document,
        payload,
        actor_user_id=auth.user.id,
        actor_name=auth.user.name,
    )


@router.post(
    "/{document_id}/extraction/lines/{line_id}/skip", response_model=ExtractionLineStatesOut
)
def skip_extraction_line(
    document_id: uuid.UUID,
    line_id: str,
    payload: ExtractionLineSkipRequest | None = None,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ExtractionLineStatesOut:
    """Skip one line. It stays out of the pending lines until it is restored."""
    document = _review_document(db, auth.household.id, document_id)
    document_extraction.ensure_extraction(db, document)
    document = document_extraction_apply.change_line_skip(
        db,
        auth.household.id,
        document,
        line_id,
        actor_user_id=auth.user.id,
        edits=payload.model_dump() if payload else None,
    )
    return _line_states(db, document)


@router.put("/{document_id}/extraction/draft", response_model=ExtractionHeaderDraftState)
def save_extraction_header_draft(
    document_id: uuid.UUID,
    payload: ExtractionHeaderDraftRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ExtractionHeaderDraftState:
    """Keep the corrected fields at the top of the review. Nothing is applied."""
    document = _review_document(db, auth.household.id, document_id)
    document_extraction.ensure_extraction(db, document)
    try:
        document = document_extraction_apply.save_header_draft(
            db,
            auth.household.id,
            document,
            version=payload.version,
            draft=payload.draft.model_dump(exclude_none=True) if payload.draft else None,
            actor_user_id=auth.user.id,
            expected_revision=payload.expected_revision,
            writer=payload.writer,
        )
    except DraftConflict as error:
        # The page gets the fields as the server keeps them, and their revision.
        raise conflict(
            error.revision, _header_draft(document).model_dump(mode="json")
        ) from error
    return _header_draft(document)


@router.put(
    "/{document_id}/extraction/lines/{line_id}/draft", response_model=ExtractionLineStatesOut
)
def save_extraction_line_draft(
    document_id: uuid.UUID,
    line_id: str,
    payload: ExtractionLineDraftRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ExtractionLineStatesOut:
    """Keep the corrections of one line that still waits. A body without a draft forgets them."""
    document = _review_document(db, auth.household.id, document_id)
    document_extraction.ensure_extraction(db, document)
    try:
        document = document_extraction_apply.save_line_draft(
            db,
            auth.household.id,
            document,
            line_id,
            actor_user_id=auth.user.id,
            edits=payload.model_dump(exclude={"expected_revision", "writer"}),
            expected_revision=payload.expected_revision,
            writer=payload.writer,
        )
    except DraftConflict as error:
        # The page gets the line as the server keeps it, and its revision.
        state = _line_states(db, document).line_states.get(line_id)
        raise conflict(
            error.revision, state.model_dump(mode="json") if state else {}
        ) from error
    return _line_states(db, document)


@router.post(
    "/{document_id}/extraction/lines/{line_id}/restore", response_model=ExtractionLineStatesOut
)
def restore_extraction_line(
    document_id: uuid.UUID,
    line_id: str,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ExtractionLineStatesOut:
    """Undo Skip for one line. Nothing is applied."""
    document = _review_document(db, auth.household.id, document_id)
    document = document_extraction_apply.change_line_skip(
        db, auth.household.id, document, line_id, actor_user_id=auth.user.id, restore=True
    )
    return _line_states(db, document)
