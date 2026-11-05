import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ...db import get_db
from ...schemas.documents import DocumentOut
from ...schemas.manuals import (
    ManualAnswerOut,
    ManualAskRequest,
    ManualCandidateList,
    ManualDownloadIn,
    ManualDownloadOut,
    ManualOnlineAnswerOut,
    ManualOnlineAskRequest,
    ManualProfileIn,
    ManualProfileOut,
    ManualsOut,
)
from ...services import manuals as manual_service
from ...services.serializers import document_out
from ..deps import AuthContext, require_auth

router = APIRouter(tags=["manuals"])


@router.get("/items/{item_id}/manuals", response_model=ManualsOut)
def read_item_manuals(
    item_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ManualsOut:
    return manual_service.manuals_for_item(db, auth.household.id, item_id)


@router.put("/items/{item_id}/manual-profile", response_model=ManualProfileOut)
def save_item_manual_profile(
    item_id: uuid.UUID,
    payload: ManualProfileIn,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ManualProfileOut:
    return manual_service.save_profile(db, auth.household.id, item_id, auth.user.id, payload)


@router.post("/items/{item_id}/manuals/{document_id}", response_model=DocumentOut)
def attach_existing_manual(
    item_id: uuid.UUID,
    document_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> DocumentOut:
    document = manual_service.link_manual(db, auth.household.id, item_id, document_id)
    return document_out(document)


@router.post("/items/{item_id}/manual-questions", response_model=ManualAnswerOut)
def ask_about_item_manual(
    item_id: uuid.UUID,
    payload: ManualAskRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ManualAnswerOut:
    return manual_service.ask_manual_question(db, auth.household.id, item_id, payload.question)


@router.get("/items/{item_id}/manual-search", response_model=ManualCandidateList)
def read_manual_candidates(
    item_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ManualCandidateList:
    return manual_service.list_candidates(db, auth.household.id, item_id)


@router.post("/items/{item_id}/manual-search", response_model=ManualCandidateList)
def search_online_manuals(
    item_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ManualCandidateList:
    return manual_service.search_candidates(db, auth.household.id, item_id, auth.user.id)


@router.post(
    "/items/{item_id}/manual-search/{candidate_id}/download",
    response_model=ManualDownloadOut,
)
def download_reviewed_manual(
    item_id: uuid.UUID,
    candidate_id: uuid.UUID,
    payload: ManualDownloadIn,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ManualDownloadOut:
    return manual_service.download_candidate(
        db,
        auth.household.id,
        item_id,
        candidate_id,
        auth.user.id,
        payload.request_id,
    )


@router.post("/items/{item_id}/manual-questions/online", response_model=ManualOnlineAnswerOut)
def ask_online_about_item(
    item_id: uuid.UUID,
    payload: ManualOnlineAskRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> ManualOnlineAnswerOut:
    return manual_service.ask_online_question(db, auth.household.id, item_id, payload.question)
