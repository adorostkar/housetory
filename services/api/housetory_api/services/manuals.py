"""Manual attachment and reviewed online discovery.

Attached manuals are ordinary household ``Document`` rows with
``document_type="manual"``. Questions about a manual are answered by the main
assistant, which reads the manual's pages (``assistant_tools.manual_tools``) and uses
the online steps below as a tool (``assistant_tools.online_manuals``); nothing here
interprets manual or web text. Online search is only possible when a
real search provider is configured and the product identity is confirmed, and
every download must be explicitly reviewed first.
"""

from __future__ import annotations

import io
import uuid
from datetime import UTC, datetime

from fastapi import UploadFile
from sqlalchemy import case, or_, select
from sqlalchemy.orm import Session
from starlette.datastructures import Headers

from ..api.errors import ApiError
from ..domain import DocumentType
from ..models import (
    Document,
    Item,
    ItemManualProfile,
    ManualSearchCandidate,
)
from ..schemas.manuals import (
    ManualCandidateList,
    ManualCandidateOut,
    ManualDownloadOut,
    ManualProfileIn,
    ManualProfileOut,
    ManualSearchStatusOut,
    ManualsOut,
    validate_manual_identifiers,
)
from . import document_pages, manual_web
from .document_pages import DOCUMENTATION_TYPES
from .documents import create_document, get_document
from .serializers import document_out

MAX_MANUAL_SOURCES = 8
# Documentation a household files on an item. Purchase and warranty paperwork is
# never read as a manual.
MANUAL_SOURCE_TYPES = DOCUMENTATION_TYPES


def get_item(db: Session, household_id: uuid.UUID, item_id: uuid.UUID) -> Item:
    item = db.scalar(select(Item).where(Item.id == item_id, Item.household_id == household_id))
    if item is None:
        raise ApiError(404, "item_not_found", "Item not found.")
    return item


def get_profile(
    db: Session, household_id: uuid.UUID, item_id: uuid.UUID
) -> ItemManualProfile | None:
    return db.scalar(
        select(ItemManualProfile).where(
            ItemManualProfile.household_id == household_id,
            ItemManualProfile.item_id == item_id,
        )
    )


def profile_out(profile: ItemManualProfile) -> ManualProfileOut:
    return ManualProfileOut.model_validate(profile)


def manual_documents(db: Session, household_id: uuid.UUID, item_id: uuid.UUID) -> list[Document]:
    return list(
        db.scalars(
            select(Document)
            .where(
                Document.household_id == household_id,
                Document.document_type == DocumentType.MANUAL.value,
                Document.items.any(Item.id == item_id),
            )
            .order_by(Document.created_at.desc(), Document.title.asc())
        ).all()
    )


def _downloads_for_item(household_id: uuid.UUID, item_id: uuid.UUID):
    """Documents that a reviewed online download saved for this item."""
    return select(ManualSearchCandidate.document_id).where(
        ManualSearchCandidate.household_id == household_id,
        ManualSearchCandidate.item_id == item_id,
        ManualSearchCandidate.document_id.is_not(None),
    )


def item_manual_sources(db: Session, household_id: uuid.UUID, item_id: uuid.UUID) -> list[Document]:
    """Every document that can serve as this item's manual, Manual-library ones first.

    ``manual_documents`` is the strict Manual-library view the item page lists. A
    manual also reaches an item in two other ways. A reviewed online download
    records the item in ``manual_search_candidates``; the file may already have
    been stored under another type, and its item link can be removed later. The
    item page's plain upload attaches documentation as "other" or "specification".
    """
    return list(
        db.scalars(
            select(Document)
            .where(
                Document.household_id == household_id,
                Document.document_type.in_(MANUAL_SOURCE_TYPES),
                or_(
                    Document.items.any(Item.id == item_id),
                    Document.id.in_(_downloads_for_item(household_id, item_id)),
                ),
            )
            .order_by(
                case((Document.document_type == DocumentType.MANUAL.value, 0), else_=1),
                Document.created_at.desc(),
                Document.title.asc(),
            )
            .limit(MAX_MANUAL_SOURCES)
        ).all()
    )


def manual_relations(
    db: Session, household_id: uuid.UUID, item_id: uuid.UUID, documents: list[Document]
) -> dict[uuid.UUID, str]:
    """How each document is tied to the item, read from stored records only.

    ``attached`` is a link in ``item_documents``. ``online_download`` is a reviewed
    download recorded for this very item. These are the two ties that
    ``item_manual_sources`` follows; a document with neither is left out.
    """
    downloaded = set(
        db.scalars(
            _downloads_for_item(household_id, item_id).where(
                ManualSearchCandidate.document_id.in_([document.id for document in documents])
            )
        )
    )
    relations = {}
    for document in documents:
        if any(entry.id == item_id for entry in document.items):
            relations[document.id] = "attached"
        elif document.id in downloaded:
            relations[document.id] = "online_download"
    return relations


def _search_status(
    db: Session, household_id: uuid.UUID, item_id: uuid.UUID
) -> ManualSearchStatusOut:
    provider = manual_web.resolve_search_provider(db, household_id)
    configured = provider.configured
    reason = provider.reason
    profile = get_profile(db, household_id, item_id)
    if profile is None:
        if configured:
            reason = (
                "Confirm the exact manufacturer and complete model identifier for this "
                "item before searching online."
            )
        return ManualSearchStatusOut(
            configured=configured,
            provider=provider.kind if configured else None,
            provider_label=provider.label,
            reason=reason,
            profile=None,
            can_search=False,
        )
    if not configured:
        return ManualSearchStatusOut(
            configured=False,
            provider=None,
            provider_label=None,
            reason=reason,
            profile=profile_out(profile),
            can_search=False,
        )
    return ManualSearchStatusOut(
        configured=True,
        provider=provider.kind,
        provider_label=provider.label,
        reason=None,
        profile=profile_out(profile),
        can_search=True,
    )


def manuals_for_item(db: Session, household_id: uuid.UUID, item_id: uuid.UUID) -> ManualsOut:
    get_item(db, household_id, item_id)
    documents = manual_documents(db, household_id, item_id)
    return ManualsOut(
        item_id=item_id,
        manuals=[document_out(document) for document in documents],
        reading={
            document.id: document_pages.reading_out(db, document) for document in documents
        },
        search=_search_status(db, household_id, item_id),
    )


def save_profile(
    db: Session,
    household_id: uuid.UUID,
    item_id: uuid.UUID,
    user_id: uuid.UUID,
    payload: ManualProfileIn,
) -> ManualProfileOut:
    get_item(db, household_id, item_id)
    try:
        manufacturer, model_identifier, variant = validate_manual_identifiers(
            payload.manufacturer, payload.model_identifier, payload.variant
        )
    except ValueError as exc:
        raise ApiError(422, "incomplete_manual_identity", str(exc)) from exc
    profile = get_profile(db, household_id, item_id)
    if profile is None:
        profile = ItemManualProfile(
            household_id=household_id,
            item_id=item_id,
            manufacturer=manufacturer,
            model_identifier=model_identifier,
            variant=variant,
            confirmed_by_user_id=user_id,
            confirmed_at=datetime.now(UTC),
        )
        db.add(profile)
    else:
        profile.manufacturer = manufacturer
        profile.model_identifier = model_identifier
        profile.variant = variant
        profile.confirmed_by_user_id = user_id
        profile.confirmed_at = datetime.now(UTC)
    db.commit()
    db.refresh(profile)
    return profile_out(profile)


def link_manual(
    db: Session, household_id: uuid.UUID, item_id: uuid.UUID, document_id: uuid.UUID
) -> Document:
    get_item(db, household_id, item_id)
    document = get_document(db, household_id, document_id)
    if document.document_type != DocumentType.MANUAL.value:
        raise ApiError(
            422,
            "not_a_manual",
            "Only documents in the Manual library can be attached to an item.",
        )
    if all(item.id != item_id for item in document.items):
        item = get_item(db, household_id, item_id)
        document.items = [*document.items, item]
        # A manual attached to an item is read to its last page, if it is not already.
        document_pages.request_reading(db, document, commit=False)
        db.commit()
    return get_document(db, household_id, document_id)


def _require_profile(db: Session, household_id: uuid.UUID, item_id: uuid.UUID) -> ItemManualProfile:
    get_item(db, household_id, item_id)
    profile = get_profile(db, household_id, item_id)
    if profile is None:
        raise ApiError(
            409,
            "manual_identity_required",
            "Confirm the exact manufacturer and complete model identifier, and review "
            "them, before searching online or asking an online product question.",
        )
    try:
        validate_manual_identifiers(profile.manufacturer, profile.model_identifier, profile.variant)
    except ValueError as exc:
        raise ApiError(409, "incomplete_manual_identity", str(exc)) from exc
    return profile


def _require_search(db: Session, household_id: uuid.UUID, item_id: uuid.UUID) -> ItemManualProfile:
    profile = _require_profile(db, household_id, item_id)
    provider = manual_web.resolve_search_provider(db, household_id)
    if not provider.configured:
        raise ApiError(
            409,
            "manual_search_unconfigured",
            provider.reason or "Manual search is not configured.",
        )
    return profile


def _candidate_out(candidate: ManualSearchCandidate) -> ManualCandidateOut:
    direct_file = candidate.file_url != candidate.source_url or manual_web.is_pdf_url(
        candidate.file_url
    )
    return ManualCandidateOut.model_validate(candidate).model_copy(
        update={"direct_file": direct_file}
    )


def search_candidates(
    db: Session,
    household_id: uuid.UUID,
    item_id: uuid.UUID,
    user_id: uuid.UUID,
) -> ManualCandidateList:
    profile = _require_search(db, household_id, item_id)
    try:
        outcome = manual_web.search_manual_candidates(
            manufacturer=profile.manufacturer,
            model=profile.model_identifier,
            variant=profile.variant,
            db=db,
            household_id=household_id,
        )
    except manual_web.ManualSearchUnavailable as exc:
        raise ApiError(502, "manual_search_unavailable", str(exc)) from exc
    existing = list(
        db.scalars(
            select(ManualSearchCandidate).where(
                ManualSearchCandidate.household_id == household_id,
                ManualSearchCandidate.item_id == item_id,
            )
        ).all()
    )
    by_source = {entry.source_url: entry for entry in existing}
    for data in outcome.candidates:
        candidate = by_source.get(data.source_url)
        if candidate is None:
            candidate = ManualSearchCandidate(
                household_id=household_id,
                item_id=item_id,
                title=data.title,
                source_url=data.source_url,
                file_url=data.file_url,
                publisher=data.publisher,
                language=data.language,
                source_type=data.source_type,
                model_coverage=data.model_coverage,
                snippet=data.snippet,
                retrieved_at=data.retrieved_at,
                created_by_user_id=user_id,
            )
            db.add(candidate)
            by_source[data.source_url] = candidate
        else:
            candidate.title = data.title
            candidate.file_url = data.file_url
            candidate.publisher = data.publisher
            candidate.language = data.language
            candidate.source_type = data.source_type
            candidate.model_coverage = data.model_coverage
            candidate.snippet = data.snippet
            candidate.retrieved_at = data.retrieved_at
    db.commit()
    stored = list(
        db.scalars(
            select(ManualSearchCandidate)
            .where(
                ManualSearchCandidate.household_id == household_id,
                ManualSearchCandidate.item_id == item_id,
            )
            .order_by(ManualSearchCandidate.created_at.desc())
            .limit(50)
        ).all()
    )
    notices = list(outcome.notices)
    if not stored:
        notices.append(
            "No reviewed candidates were saved. You can still upload a manual from a "
            "source you trust."
        )
    return ManualCandidateList(
        item_id=item_id,
        candidates=[_candidate_out(candidate) for candidate in stored],
        notices=notices,
    )


def list_candidates(
    db: Session, household_id: uuid.UUID, item_id: uuid.UUID
) -> ManualCandidateList:
    get_item(db, household_id, item_id)
    candidates = list(
        db.scalars(
            select(ManualSearchCandidate)
            .where(
                ManualSearchCandidate.household_id == household_id,
                ManualSearchCandidate.item_id == item_id,
            )
            .order_by(ManualSearchCandidate.created_at.desc())
            .limit(50)
        ).all()
    )
    notices: list[str] = []
    provider = manual_web.resolve_search_provider(db, household_id)
    if not provider.configured:
        notices.append(provider.reason or "Manual search is not configured.")
    return ManualCandidateList(
        item_id=item_id,
        candidates=[_candidate_out(candidate) for candidate in candidates],
        notices=notices,
    )


def _get_candidate(
    db: Session, household_id: uuid.UUID, item_id: uuid.UUID, candidate_id: uuid.UUID
) -> ManualSearchCandidate:
    candidate = db.scalar(
        select(ManualSearchCandidate).where(
            ManualSearchCandidate.id == candidate_id,
            ManualSearchCandidate.household_id == household_id,
            ManualSearchCandidate.item_id == item_id,
        )
    )
    if candidate is None:
        raise ApiError(404, "manual_candidate_not_found", "Manual search candidate not found.")
    return candidate


def download_candidate(
    db: Session,
    household_id: uuid.UUID,
    item_id: uuid.UUID,
    candidate_id: uuid.UUID,
    user_id: uuid.UUID,
    request_id: uuid.UUID,
) -> ManualDownloadOut:
    _require_profile(db, household_id, item_id)
    candidate = _get_candidate(db, household_id, item_id, candidate_id)
    get_item(db, household_id, item_id)

    prior = db.scalar(
        select(ManualSearchCandidate).where(
            ManualSearchCandidate.household_id == household_id,
            ManualSearchCandidate.download_request_id == request_id,
        )
    )
    if prior is not None and prior.id != candidate.id:
        if prior.item_id == item_id and prior.document_id is not None:
            document = get_document(db, household_id, prior.document_id)
            return ManualDownloadOut(
                document=document_out(document),
                candidate=_candidate_out(prior),
                duplicate_documents=[],
            )
        raise ApiError(
            409,
            "download_request_conflict",
            "That download request was already used for another manual candidate.",
        )

    if candidate.document_id is not None:
        document = get_document(db, household_id, candidate.document_id)
        return ManualDownloadOut(
            document=document_out(document),
            candidate=_candidate_out(candidate),
            duplicate_documents=[],
        )

    candidate.download_request_id = request_id
    try:
        fetched = manual_web.fetch_manual_pdf(candidate.file_url)
    except manual_web.ManualFetchError as exc:
        db.rollback()
        raise ApiError(422, "manual_download_failed", str(exc)) from exc

    existing = db.scalar(
        select(Document).where(
            Document.household_id == household_id,
            Document.content_sha256 == _sha256(fetched.content),
        )
    )
    if existing is not None:
        if all(item.id != item_id for item in existing.items):
            existing.items = [*existing.items, get_item(db, household_id, item_id)]
        candidate.document_id = existing.id
        candidate.download_request_id = request_id
        db.commit()
        return ManualDownloadOut(
            document=document_out(get_document(db, household_id, existing.id)),
            candidate=_candidate_out(candidate),
            duplicate_documents=[{"id": str(existing.id), "title": existing.title, "reused": True}],
        )

    duplicate_rows = list(
        db.scalars(
            select(Document)
            .where(
                Document.household_id == household_id,
                Document.content_sha256 == _sha256(fetched.content),
            )
            .limit(10)
        ).all()
    )
    upload = UploadFile(
        file=io.BytesIO(fetched.content),
        size=len(fetched.content),
        filename=fetched.filename,
        headers=Headers({"content-type": "application/pdf"}),
    )
    metadata = {
        "manual_source": {
            "candidate_id": str(candidate.id),
            "source_url": candidate.source_url,
            "file_url": candidate.file_url,
            "resolved_file_url": fetched.final_url,
            "publisher": candidate.publisher,
            "language": candidate.language,
            "source_type": candidate.source_type,
            "retrieved_at": candidate.retrieved_at.isoformat(),
            "downloaded_at": fetched.retrieved_at.isoformat(),
            "model_coverage": candidate.model_coverage,
        }
    }
    document = create_document(
        db,
        household_id,
        upload,
        title=candidate.title[:200],
        document_type=DocumentType.MANUAL,
        item_ids=[item_id],
        merchant=candidate.publisher,
        document_date=None,
        notes=None,
        metadata=metadata,
    )
    candidate.document_id = document.id
    candidate.download_request_id = request_id
    candidate.retrieved_at = candidate.retrieved_at
    candidate.created_by_user_id = candidate.created_by_user_id or user_id
    db.commit()
    db.refresh(candidate)
    duplicates = (document.extracted_metadata or {}).get("duplicate_documents", [])
    if duplicate_rows:
        duplicates = [
            *[
                {"id": str(row.id), "title": row.title, "reused": False}
                for row in duplicate_rows
                if row.id != document.id
            ],
            *duplicates,
        ]
    return ManualDownloadOut(
        document=document_out(document),
        candidate=_candidate_out(candidate),
        duplicate_documents=duplicates,
    )


def _sha256(content: bytes) -> str:
    import hashlib

    return hashlib.sha256(content).hexdigest()


# Assistant proposals. The assistant prepares them; the signed-in user reviews the
# card and applies it. Applying runs the same functions as the item page.
PROPOSAL_KINDS = {"confirm_manual_identity", "save_manual"}


def _identity(profile: ItemManualProfile | None) -> dict[str, str | None] | None:
    if profile is None:
        return None
    return {
        "manufacturer": profile.manufacturer,
        "model_identifier": profile.model_identifier,
        "variant": profile.variant,
    }


def _identity_label(identity: dict[str, str | None]) -> str:
    return " ".join(
        part
        for part in (
            identity["manufacturer"],
            identity["model_identifier"],
            identity["variant"],
        )
        if part
    )


def prepare_proposal(
    db: Session, household_id: uuid.UUID, item: Item, kind: str, values: dict
) -> tuple[dict, dict, dict]:
    """Check a manual proposal and return its (changes, before, snapshots).

    Nothing is saved or fetched here. ``changes`` holds what the user reviews.
    """
    profile = get_profile(db, household_id, item.id)
    recorded = {"item_brand": item.brand, "item_model": item.model}
    if kind == "confirm_manual_identity":
        try:
            manufacturer, model_identifier, variant = validate_manual_identifiers(
                values["manufacturer"], values["model_identifier"], values.get("variant")
            )
        except ValueError as exc:
            raise ApiError(422, "incomplete_manual_identity", str(exc)) from exc
        changes = {
            "item_id": str(item.id),
            "manufacturer": manufacturer,
            "model_identifier": model_identifier,
            "variant": variant,
        }
        current = _identity(profile)
        if current == {key: changes[key] for key in current or {}}:
            raise ApiError(
                409,
                "manual_identity_confirmed",
                f"{_identity_label(current)} is already the confirmed identity of "
                f"{item.name}. No proposal is needed: search with find_manuals_online.",
            )
        return (
            changes,
            {**(current or {}), **recorded},
            {"profile_updated_at": profile.updated_at.isoformat() if profile else None},
        )
    profile = _require_profile(db, household_id, item.id)
    candidate = _get_candidate(db, household_id, item.id, uuid.UUID(str(values["candidate_id"])))
    if candidate.document_id is not None:
        saved = get_document(db, household_id, candidate.document_id)
        raise ApiError(
            409,
            "manual_already_saved",
            f"That manual is already saved for {item.name} as “{saved.title}”. Read it "
            "with read_manual; do not save it again.",
        )
    out = _candidate_out(candidate)
    if not out.direct_file:
        raise ApiError(
            422,
            "manual_source_page_only",
            "That source shows no PDF file to download, and a file address is never "
            "guessed. Choose a candidate with a direct file, or tell the user to open "
            "the source page and add the manual with Add manual on the item page.",
        )
    identity = _identity(profile)
    changes = {
        "item_id": str(item.id),
        "candidate_id": str(candidate.id),
        "title": candidate.title,
        "publisher": candidate.publisher,
        "source_type": candidate.source_type,
        "language": candidate.language,
        "model_coverage": candidate.model_coverage,
        "source_url": candidate.source_url,
        "file_url": candidate.file_url,
    }
    return (
        changes,
        {**identity, **recorded},
        {
            "identity": identity,
            "file_url": candidate.file_url,
            "domain_request_id": str(uuid.uuid4()),
        },
    )


def apply_proposal(
    db: Session,
    household_id: uuid.UUID,
    user_id: uuid.UUID,
    item: Item,
    kind: str,
    changes: dict,
    snapshots: dict,
) -> str:
    """Carry out a reviewed manual proposal and return the message for the user."""
    name = item.name
    profile = get_profile(db, household_id, item.id)
    if kind == "confirm_manual_identity":
        if (profile.updated_at.isoformat() if profile else None) != snapshots["profile_updated_at"]:
            raise ApiError(
                409, "proposal_stale", "The confirmed identity changed. Refresh the proposal."
            )
        saved = save_profile(
            db,
            household_id,
            item.id,
            user_id,
            ManualProfileIn(
                manufacturer=changes["manufacturer"],
                model_identifier=changes["model_identifier"],
                variant=changes.get("variant"),
                confirmed=True,
            ),
        )
        return f"Confirmed {saved.display} as the exact product of {name}."
    candidate = _get_candidate(db, household_id, item.id, uuid.UUID(changes["candidate_id"]))
    if _identity(profile) != snapshots["identity"] or candidate.file_url != snapshots["file_url"]:
        raise ApiError(
            409,
            "proposal_stale",
            "The confirmed identity or the source changed since this was prepared. "
            "Refresh the proposal and review it again.",
        )
    already = candidate.document_id is not None
    result = download_candidate(
        db,
        household_id,
        item.id,
        candidate.id,
        user_id,
        uuid.UUID(snapshots["domain_request_id"]),
    )
    title = result.document.title
    if already:
        return f"“{title}” was already saved for {name}. Nothing was downloaded again."
    if any(entry.get("reused") for entry in result.duplicate_documents):
        return (
            f"The same file was already in the library as “{title}”. It is now attached "
            f"to {name}; nothing was stored twice."
        )
    return f"Saved “{title}” and attached it to {name}. Its pages are being read."
