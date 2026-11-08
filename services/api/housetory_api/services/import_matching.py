"""Location/category matching and duplicate detection for import proposals."""

import re
import uuid
from dataclasses import dataclass
from difflib import SequenceMatcher

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from ..models import Category, Item, Room, StorageLocation, Tag
from ..schemas.imports import (
    DuplicateCandidate,
    LocationCandidate,
    LocationProposal,
    NamedMatch,
    ProposedItem,
    ProposedPurchase,
    ProposedWarranty,
)
from .import_parse import ProposalDraft

ROOM_THRESHOLD = 70
LOCATION_THRESHOLD = 68
CATEGORY_THRESHOLD = 72


@dataclass
class InventoryIndex:
    rooms: list[Room]
    locations: list[StorageLocation]
    categories: list[Category]
    tags: list[Tag]


def build_index(
    db: Session,
    household_id: uuid.UUID,
    property_id: uuid.UUID | None = None,
) -> InventoryIndex:
    room_conditions = [Room.household_id == household_id]
    if property_id is not None:
        room_conditions.append(Room.property_id == property_id)
    room_query = select(Room).where(*room_conditions)
    location_query = select(StorageLocation).where(
        StorageLocation.household_id == household_id,
        StorageLocation.active(),
    )
    if property_id is not None:
        location_query = location_query.join(Room, Room.id == StorageLocation.room_id).where(
            Room.property_id == property_id
        )
    return InventoryIndex(
        rooms=list(db.scalars(room_query.order_by(Room.sort_order, Room.name)).all()),
        locations=list(
            db.scalars(
                location_query.order_by(StorageLocation.sort_order, StorageLocation.name)
            ).all()
        ),
        categories=list(
            db.scalars(
                select(Category)
                .where(Category.household_id == household_id)
                .order_by(Category.name)
            ).all()
        ),
        tags=list(
            db.scalars(select(Tag).where(Tag.household_id == household_id).order_by(Tag.name)).all()
        ),
    )


def _normalize(value: str) -> str:
    from .query_text import normalize_for_match

    lowered = re.sub(r"[^\w]+", " ", normalize_for_match(value), flags=re.UNICODE).strip()
    return re.sub(r"\s+", " ", lowered)


def _singular(token: str) -> str:
    if len(token) <= 3:
        return token
    if token.endswith("ies"):
        return f"{token[:-3]}y"
    if (
        token.endswith("ses")
        or token.endswith("xes")
        or token.endswith("ches")
        or token.endswith("shes")
    ):
        return token[:-2]
    if token.endswith("s") and not token.endswith("ss"):
        return token[:-1]
    return token


def _token_score(left: str, right: str) -> float:
    left_tokens = [_singular(token) for token in _normalize(left).split() if token]
    right_tokens = [_singular(token) for token in _normalize(right).split() if token]
    if not left_tokens or not right_tokens:
        return 0.0
    matched = 0
    for token in left_tokens:
        for other in right_tokens:
            if token == other or (
                len(token) >= 3
                and len(other) >= 3
                and (token.startswith(other) or other.startswith(token))
            ):
                matched += 1
                break
    return matched / max(len(left_tokens), len(right_tokens))


def _similarity(left: str, right: str) -> int:
    normalized_left, normalized_right = _normalize(left), _normalize(right)
    if not normalized_left or not normalized_right:
        return 0
    if normalized_left == normalized_right:
        return 100
    if _singular(normalized_left) == _singular(normalized_right):
        return 97
    ratio = SequenceMatcher(None, normalized_left, normalized_right).ratio()
    token = _token_score(left, right)
    score = max(ratio * 82, token * 90)
    if normalized_left in normalized_right or normalized_right in normalized_left:
        score = max(score, 86)
    return int(round(score))


def _candidate_from_room(room: Room, score: int) -> LocationCandidate:
    return LocationCandidate(
        id=room.id,
        name=room.name,
        kind="room",
        room_id=room.id,
        parent_id=room.parent_id,
        score=score,
    )


def _candidate_from_location(location: StorageLocation, score: int) -> LocationCandidate:
    return LocationCandidate(
        id=location.id,
        name=location.name,
        identifier=location.identifier,
        kind=location.kind,
        room_id=location.room_id,
        parent_id=location.parent_id,
        score=score,
    )


def _pick(
    candidates: list[LocationCandidate],
) -> tuple[str, LocationCandidate | None, list[LocationCandidate]]:
    candidates = sorted(candidates, key=lambda entry: entry.score, reverse=True)[:5]
    if not candidates:
        return "missing", None, []
    best = candidates[0]
    close = [entry for entry in candidates[1:] if best.score - entry.score <= 6]
    if len(close) >= 1:
        return "ambiguous", None, candidates
    return "matched", best, candidates


def match_room(text: str | None, index: InventoryIndex) -> LocationProposal | None:
    if not text or not text.strip():
        return None
    cleaned = _strip_article(text)
    candidates = [
        _candidate_from_room(room, _similarity(cleaned, room.name)) for room in index.rooms
    ]
    candidates = [entry for entry in candidates if entry.score >= ROOM_THRESHOLD]
    status, best, ranked = _pick(candidates)
    return LocationProposal(
        text=cleaned,
        entity_type="room",
        status=status,
        matched_id=best.id if best else None,
        name=best.name if best else _display_name(cleaned),
        room_id=best.id if best else None,
        parent_id=best.parent_id if best else None,
        candidates=ranked,
    )


def _location_candidates(
    text: str, index: InventoryIndex, room_id: uuid.UUID | None = None
) -> list[LocationCandidate]:
    candidates = []
    normalized = _normalize(text).upper()
    for location in index.locations:
        if room_id is not None and location.room_id != room_id:
            continue
        if location.identifier and location.identifier.upper() == normalized.replace(" ", "-"):
            candidates.append(_candidate_from_location(location, 100))
            continue
        score = _similarity(text, location.name)
        if score >= LOCATION_THRESHOLD:
            candidates.append(_candidate_from_location(location, score))
    return candidates


def match_location(
    text: str | None,
    index: InventoryIndex,
    *,
    room_id: uuid.UUID | None = None,
    preposition: str | None = None,
) -> LocationProposal | None:
    if not text or not text.strip():
        return None
    cleaned = _strip_article(text)
    candidates = _location_candidates(cleaned, index, room_id)
    status, best, ranked = _pick(candidates)
    if best is not None:
        return LocationProposal(
            text=cleaned,
            entity_type="storage_location",
            status=status,
            matched_id=best.id,
            name=best.name,
            identifier=best.identifier,
            room_id=best.room_id,
            parent_id=best.parent_id,
            candidates=ranked,
        )
    display = _display_name(cleaned)
    if preposition in {"under", "on", "behind"}:
        display = f"{preposition.title()} the {display[:1].lower() + display[1:]}"
    return LocationProposal(
        text=cleaned,
        entity_type="storage_location",
        status="missing",
        name=display,
        room_id=room_id,
        candidates=[],
    )


ROOM_WORDS = {
    "attic",
    "basement",
    "bathroom",
    "bedroom",
    "cellar",
    "closet",
    "dining",
    "garage",
    "garden",
    "hall",
    "hallway",
    "kitchen",
    "laundry",
    "library",
    "living",
    "loft",
    "office",
    "pantry",
    "playroom",
    "shed",
    "storage",
    "study",
    "utility",
    "wardrobe",
}


def _looks_like_room(text: str) -> bool:
    tokens = _normalize(text).split()
    if not tokens:
        return False
    if any(token in ROOM_WORDS for token in tokens):
        return True
    return tokens[-1] in {"room", "bedroom", "garage", "attic", "loft", "office", "closet"}


def _strip_article(value: str) -> str:
    return re.sub(r"^(?:the|a|an|my|our)\s+", "", value.strip(), flags=re.IGNORECASE).strip(
        " .,;:-"
    )


def _display_name(value: str) -> str:
    cleaned = _strip_article(value)
    return cleaned[:1].upper() + cleaned[1:] if cleaned else ""


def match_category(text: str | None, index: InventoryIndex) -> NamedMatch | None:
    if not text or not text.strip():
        return None
    cleaned = _strip_article(text)
    candidates = [
        LocationCandidate(
            id=category.id,
            name=category.name,
            kind="category",
            score=_similarity(cleaned, category.name),
        )
        for category in index.categories
    ]
    candidates = [entry for entry in candidates if entry.score >= CATEGORY_THRESHOLD]
    status, best, ranked = _pick(candidates)
    return NamedMatch(
        text=cleaned,
        status=status,
        matched_id=best.id if best else None,
        name=best.name if best else _display_name(cleaned),
        candidates=ranked,
    )


def _split_phrase(
    phrase: str, index: InventoryIndex
) -> tuple[LocationProposal | None, LocationProposal | None]:
    words = _strip_article(phrase).split()
    if len(words) < 2:
        return None, None
    for split_at in range(len(words) - 1, 0, -1):
        left = " ".join(words[:split_at])
        right = " ".join(words[split_at:])
        room_match = match_room(left, index)
        if room_match and room_match.status == "matched":
            location_match = match_location(right, index, room_id=room_match.matched_id)
            if location_match is None:
                return room_match, None
            if location_match.status in {"matched", "ambiguous"}:
                return room_match, location_match
            return room_match, location_match
    return None, None


def resolve_locations(
    draft: ProposalDraft, index: InventoryIndex
) -> tuple[LocationProposal | None, LocationProposal | None]:
    room_match = match_room(draft.room_text, index) if draft.room_text else None
    location_match = None
    phrases = [phrase for phrase in draft.location_phrases if phrase]
    if draft.storage_text:
        location_match = match_location(
            draft.storage_text,
            index,
            room_id=room_match.matched_id if room_match else None,
            preposition=draft.location_preposition,
        )
    elif phrases and room_match is None:
        if len(phrases) == 1 and draft.location_preposition in {"under", "on", "behind"}:
            phrase = phrases[0]
            inferred_room = match_room(phrase, index)
            location_text = phrase
            if inferred_room and inferred_room.status == "matched":
                room_match = inferred_room
                words = phrase.split()
                if len(words) > 1:
                    location_text = words[-1]
            location_match = match_location(
                location_text,
                index,
                room_id=room_match.matched_id if room_match else None,
                preposition=draft.location_preposition,
            )
        elif len(phrases) >= 2:
            room_match = match_room(phrases[-1], index)
            location_match = match_location(
                phrases[0],
                index,
                room_id=room_match.matched_id if room_match else None,
                preposition=draft.location_preposition,
            )
        else:
            phrase = phrases[0]
            phrase_room = match_room(phrase, index)
            phrase_location = match_location(phrase, index, preposition=draft.location_preposition)
            if (
                phrase_location
                and phrase_location.status in {"matched", "ambiguous"}
                and len(_strip_article(phrase).split()) > 1
            ):
                location_match = phrase_location
                if location_match.room_id:
                    room_match = LocationProposal(
                        text=phrase,
                        entity_type="room",
                        status="matched",
                        matched_id=location_match.room_id,
                        name=next(
                            (
                                entry.name
                                for entry in index.rooms
                                if entry.id == location_match.room_id
                            ),
                            None,
                        ),
                        room_id=location_match.room_id,
                    )
            elif phrase_room and (
                phrase_room.status in {"matched", "ambiguous"}
                or (phrase_room.status == "missing" and _looks_like_room(phrase))
            ):
                room_match = phrase_room
            elif phrase_location and phrase_location.status in {"matched", "ambiguous"}:
                location_match = phrase_location
                if location_match.room_id:
                    room_match = LocationProposal(
                        text=location_match.text,
                        entity_type="room",
                        status="matched",
                        matched_id=location_match.room_id,
                        name=next(
                            (
                                entry.name
                                for entry in index.rooms
                                if entry.id == location_match.room_id
                            ),
                            None,
                        ),
                        room_id=location_match.room_id,
                    )
            else:
                split_room, split_location = _split_phrase(phrase, index)
                if split_room:
                    room_match = split_room
                    location_match = split_location
                else:
                    location_match = phrase_location
    elif phrases and room_match is not None and location_match is None:
        location_match = match_location(
            phrases[0],
            index,
            room_id=room_match.matched_id,
            preposition=draft.location_preposition,
        )
    if location_match and location_match.room_id and room_match is None:
        room = next((entry for entry in index.rooms if entry.id == location_match.room_id), None)
        if room:
            room_match = LocationProposal(
                text=room.name,
                entity_type="room",
                status="matched",
                matched_id=room.id,
                name=room.name,
                room_id=room.id,
                parent_id=room.parent_id,
            )
    return room_match, location_match


def to_proposed_item(draft: ProposalDraft, index: InventoryIndex) -> ProposedItem:
    room_match, location_match = resolve_locations(draft, index)
    category_match = match_category(draft.category_text, index)
    field_sources = dict(draft.field_sources)
    if room_match:
        field_sources["room"] = "explicit"
    if location_match:
        field_sources["storage_location"] = "explicit"
    if draft.brand:
        field_sources["brand"] = "explicit"
    if draft.model:
        field_sources["model"] = "explicit"
    if category_match:
        field_sources["category"] = "explicit"
    confidence = draft.confidence
    if (room_match and room_match.status == "ambiguous") or (
        location_match and location_match.status == "ambiguous"
    ):
        confidence = max(0, (confidence or 70) - 12)
    purchase = None
    if any(
        value is not None
        for value in (
            draft.purchase_date,
            draft.price_cents,
            draft.currency,
            draft.merchant,
            draft.order_number,
        )
    ):
        purchase = ProposedPurchase(
            purchase_date=draft.purchase_date,
            price_cents=draft.price_cents,
            currency=draft.currency,
            merchant=draft.merchant,
            order_number=draft.order_number,
        )
        for key in ("purchase_date", "price_cents", "currency", "merchant", "order_number"):
            if getattr(draft, key) is not None:
                field_sources[key] = "explicit"
    warranty = None
    if any(
        value is not None
        for value in (
            draft.warranty_provider,
            draft.warranty_start,
            draft.warranty_end,
            draft.warranty_duration_months,
            draft.warranty_notes,
        )
    ):
        warranty = ProposedWarranty(
            provider=draft.warranty_provider,
            start_date=draft.warranty_start,
            end_date=draft.warranty_end,
            duration_months=draft.warranty_duration_months,
            notes=draft.warranty_notes,
        )
        for key in ("provider", "start_date", "end_date", "duration_months", "notes"):
            if getattr(draft, f"warranty_{key}") is not None:
                field_sources[f"warranty_{key}"] = "explicit"
    return ProposedItem(
        name=draft.name,
        description=draft.description,
        quantity=draft.quantity,
        category=category_match,
        brand=draft.brand,
        model=draft.model,
        serial_number=draft.serial_number,
        room=room_match,
        storage_location=location_match,
        purchase=purchase,
        warranty=warranty,
        tags=draft.tags,
        notes=draft.notes,
        collection=draft.collection,
        relationships=draft.relationships,
        field_sources=field_sources,
        confidence=confidence,
    )


def _duplicate_score(proposed: ProposedItem, item: Item) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []
    if (
        proposed.serial_number
        and item.serial_number
        and _normalize(proposed.serial_number) == _normalize(item.serial_number)
    ):
        score += 70
        reasons.append("matching serial number")
    name_score = _similarity(proposed.name, item.name)
    if name_score >= 95:
        score += 55
        reasons.append("same name")
    elif name_score >= 75:
        score += 32
        reasons.append("similar name")
    if proposed.brand and item.brand and _normalize(proposed.brand) == _normalize(item.brand):
        score += 12
        reasons.append("same brand")
    if proposed.model and item.model and _normalize(proposed.model) == _normalize(item.model):
        score += 16
        reasons.append("same model")
    if proposed.room and proposed.room.matched_id and item.room_id == proposed.room.matched_id:
        score += 6
        reasons.append("same room")
    if (
        proposed.storage_location
        and proposed.storage_location.matched_id
        and item.storage_location_id == proposed.storage_location.matched_id
    ):
        score += 6
        reasons.append("same storage place")
    return min(score, 100), reasons


def find_duplicates(
    db: Session,
    household_id: uuid.UUID,
    proposed: ProposedItem,
    *,
    limit: int = 3,
) -> list[DuplicateCandidate]:
    items = db.scalars(
        select(Item)
        .options(joinedload(Item.room), joinedload(Item.storage_location))
        .where(Item.household_id == household_id, Item.is_archived.is_(False))
    ).all()
    candidates: list[DuplicateCandidate] = []
    for item in items:
        score, reasons = _duplicate_score(proposed, item)
        if score < 45:
            continue
        candidates.append(
            DuplicateCandidate(
                item_id=item.id,
                name=item.name,
                brand=item.brand,
                model=item.model,
                serial_number=item.serial_number,
                room_name=item.room.name if item.room else None,
                location_name=item.storage_location.name if item.storage_location else None,
                purchase_date=None,
                score=score,
                reasons=reasons,
            )
        )
    candidates.sort(key=lambda entry: (-entry.score, entry.name.lower()))
    return candidates[:limit]
