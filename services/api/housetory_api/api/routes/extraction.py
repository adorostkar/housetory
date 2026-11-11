import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ...db import get_db
from ...domain import OcrStatus
from ...schemas.extraction import (
    ExtractionApplyRequest,
    ExtractionApplyResult,
    ExtractionMatchOut,
    ExtractionMatchRequest,
    ExtractionRefinementOut,
    ExtractionReviewOut,
    LineMatchInput,
)
from ...services import (
    document_extraction,
    document_extraction_apply,
    document_matching,
    document_refinement,
)
from ...services.documents import get_document
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
    return document_extraction.extraction_review(db, document)


@router.post("/{document_id}/extraction/refine", response_model=ExtractionRefinementOut)
def refine_extraction(
    document_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ExtractionRefinementOut:
    document = _review_document(db, auth.household.id, document_id)
    document_extraction.ensure_extraction(db, document)
    return document_refinement.refine_extraction(db, auth.household.id, document)


@router.post("/{document_id}/extraction/enhancement/retry", response_model=ExtractionReviewOut)
def retry_document_enhancement(
    document_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ExtractionReviewOut:
    from ...services.enrichment import retry_enhancement

    document = _review_document(db, auth.household.id, document_id)
    retry_enhancement(db, document)
    return document_extraction.extraction_review(db, document)


@router.post("/{document_id}/extraction/enhancement/cancel", response_model=ExtractionReviewOut)
def cancel_document_enhancement(
    document_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ExtractionReviewOut:
    from ...services.enrichment import cancel_enhancement

    document = _review_document(db, auth.household.id, document_id)
    cancel_enhancement(db, document)
    return document_extraction.extraction_review(db, document)


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
