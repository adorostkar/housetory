"""Deterministic grouping of voice transcript mentions into reviewable item suggestions."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any

from sqlalchemy.orm import Session

from ...config import get_settings
from ...schemas.imports import LocationCandidate, LocationProposal, ProposedItem
from ...schemas.voice import (
    AiVoiceMention,
    AiVoiceResult,
    VoiceLocation,
    VoiceSourceSpan,
    VoiceSuggestion,
)
from ..import_matching import (
    LOCATION_THRESHOLD,
    _display_name,
    _normalize,
    _pick,
    _similarity,
    _singular,
    build_index,
    find_duplicates,
    match_category,
    match_room,
)

NUMBER_WORDS = {
    "zero": "0",
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
    "ten": "10",
    "eleven": "11",
    "twelve": "12",
    "thirteen": "13",
    "fourteen": "14",
    "fifteen": "15",
    "sixteen": "16",
    "seventeen": "17",
    "eighteen": "18",
    "nineteen": "19",
    "twenty": "20",
    "thirty": "30",
    "forty": "40",
    "fifty": "50",
    "sixty": "60",
    "seventy": "70",
    "eighty": "80",
    "ninety": "90",
}

LOCATION_PREFIXES = {
    "in",
    "inside",
    "into",
    "at",
    "on",
    "under",
    "behind",
    "from",
    "the",
    "a",
    "an",
    "my",
    "our",
    "of",
    "number",
    "no",
}

ALIASES = {
    "tv": "television",
    "telly": "television",
    "fridge": "refrigerator",
    "couch": "sofa",
    "cable": "cable",
    "cables": "cable",
    "lead": "cable",
    "leads": "cable",
}


@dataclass
class _Group:
    base_name: str
    display_name: str
    variant: str | None
    brand: str | None
    model: str | None
    serial_number: str | None
    key: str
    quantity: int = 0
    mention_count: int = 0
    quantity_explicit: bool = False
    sources: list[VoiceSourceSpan] = field(default_factory=list)
    room: VoiceLocation | None = None
    storage_location: VoiceLocation | None = None
    category_text: str | None = None
    description: str | None = None
    notes: str | None = None
    tags: list[str] = field(default_factory=list)
    confidence: int | None = None
    warnings: list[str] = field(default_factory=list)
    first_position: int = 0


def _clean_location_text(value: str) -> str:
    cleaned = value.strip().strip(" .,;:-")
    words = cleaned.split()
    while words and words[0].casefold().strip(".,;:-") in LOCATION_PREFIXES:
        words.pop(0)
    return " ".join(words).strip(" .,;:-")


def _canonical_location_text(value: str) -> str:
    cleaned = _clean_location_text(value)
    tokens = [
        NUMBER_WORDS.get(token.casefold(), token) for token in re.findall(r"[A-Za-z0-9]+", cleaned)
    ]
    return "".join(token.casefold() for token in tokens)


def _match_voice_location(
    text: str,
    index,
    *,
    room_id: uuid.UUID | None = None,
) -> VoiceLocation | None:
    if not text or not text.strip():
        return None
    cleaned = _clean_location_text(text)
    target = _canonical_location_text(cleaned)
    candidates: list[LocationCandidate] = []
    for location in index.locations:
        if room_id is not None and location.room_id != room_id:
            continue
        score = 0
        values = [location.identifier, location.name]
        values.extend(str(alias) for alias in (location.aliases or []) if isinstance(alias, str))
        if target and any(value and _canonical_location_text(value) == target for value in values):
            score = 100
        else:
            score = _similarity(cleaned, location.name)
            if location.identifier:
                score = max(score, _similarity(cleaned, location.identifier))
        if score >= LOCATION_THRESHOLD:
            candidates.append(
                LocationCandidate(
                    id=location.id,
                    name=location.name,
                    identifier=location.identifier,
                    kind=location.kind,
                    room_id=location.room_id,
                    parent_id=location.parent_id,
                    score=score,
                )
            )
    status, best, ranked = _pick(candidates)
    if best is not None or status == "ambiguous":
        chosen = best or ranked[0]
        return VoiceLocation(
            text=cleaned,
            entity_type="storage_location",
            status=status,
            matched_id=best.id if best is not None else None,
            name=chosen.name,
            identifier=chosen.identifier,
            room_id=chosen.room_id,
            parent_id=chosen.parent_id,
            candidates=ranked,
            evidence=text[:500],
        )
    return VoiceLocation(
        text=cleaned,
        entity_type="storage_location",
        status="missing",
        name=_display_name(cleaned),
        room_id=room_id,
        candidates=[],
        evidence=text[:500],
    )


def _room_from_id(index, room_id: uuid.UUID | None) -> VoiceLocation | None:
    if room_id is None:
        return None
    room = next((entry for entry in index.rooms if entry.id == room_id), None)
    if room is None:
        return None
    return VoiceLocation(
        text=room.name,
        entity_type="room",
        status="matched",
        matched_id=room.id,
        name=room.name,
        room_id=room.id,
        parent_id=room.parent_id,
        evidence=None,
    )


def _location_from_id(index, location_id: uuid.UUID | None) -> VoiceLocation | None:
    if location_id is None:
        return None
    location = next(
        (entry for entry in index.locations if entry.id == location_id),
        None,
    )
    if location is None:
        return None
    return VoiceLocation(
        text=location.name,
        entity_type="storage_location",
        status="matched",
        matched_id=location.id,
        name=location.name,
        identifier=location.identifier,
        room_id=location.room_id,
        parent_id=location.parent_id,
        evidence=None,
    )


def _resolve_locations(
    index,
    mention: AiVoiceMention,
    *,
    default_room_id: uuid.UUID | None,
    default_location_id: uuid.UUID | None,
) -> tuple[VoiceLocation | None, VoiceLocation | None, list[str]]:
    warnings: list[str] = []
    room_text = mention.room.strip() if mention.room else None
    location_text = mention.storage_location.strip() if mention.storage_location else None
    room_proposal = match_room(room_text, index) if room_text else None
    if room_proposal is not None:
        room_proposal = VoiceLocation(
            **room_proposal.model_dump(),
            evidence=room_text[:500],
        )
        if room_proposal.status == "ambiguous":
            warnings.append("The spoken room matches more than one room. Choose one.")
        elif room_proposal.status == "missing":
            warnings.append("The spoken room could not be matched. Choose or create it.")

    room_filter = (
        room_proposal.matched_id
        if room_proposal is not None and room_proposal.status == "matched"
        else default_room_id
    )
    location_proposal: VoiceLocation | None = None
    if location_text:
        location_proposal = _match_voice_location(
            location_text,
            index,
            room_id=room_filter,
        )
        if location_proposal is not None:
            if location_proposal.status == "ambiguous":
                warnings.append("The spoken container matches more than one place. Choose one.")
            elif location_proposal.status == "missing":
                warnings.append("The spoken container could not be matched. Choose or create it.")
    elif default_location_id is not None:
        location_proposal = _location_from_id(index, default_location_id)

    if (
        room_proposal is None
        and location_proposal is not None
        and location_proposal.room_id is not None
        and (location_text is None or location_proposal.status == "matched")
    ):
        room_proposal = _room_from_id(index, location_proposal.room_id)
    if room_proposal is None and default_room_id is not None:
        room_proposal = _room_from_id(index, default_room_id)
    if (
        room_proposal is None
        and location_proposal is None
        and room_text is None
        and location_text is None
        and default_room_id is None
        and default_location_id is None
    ):
        warnings.append("No room or storage place was stated. Choose one during review.")
    if (
        room_proposal is not None
        and location_proposal is not None
        and location_proposal.status == "matched"
        and room_proposal.status == "matched"
        and location_proposal.room_id != room_proposal.matched_id
    ):
        warnings.append("The matched container belongs to a different room.")
    return room_proposal, location_proposal, warnings


def _normalize_item_name(value: str) -> str:
    lowered = value.casefold()
    tokens = []
    for token in re.findall(r"[a-z0-9]+", lowered):
        if token in {"a", "an", "the", "another", "some", "more"}:
            continue
        token = ALIASES.get(token, token)
        tokens.append(_singular(token))
    return " ".join(tokens)


def _location_key(
    room: VoiceLocation | None,
    location: VoiceLocation | None,
) -> str:
    if location is not None and location.matched_id is not None:
        location_key = f"l:{location.matched_id}"
    elif location is not None and location.text:
        location_key = f"lt:{_canonical_location_text(location.text)}"
    else:
        location_key = "l:none"
    if room is not None and room.matched_id is not None:
        room_key = f"r:{room.matched_id}"
    elif room is not None and room.text:
        room_key = f"rt:{_canonical_location_text(room.text)}"
    else:
        room_key = "r:none"
    return f"{room_key}|{location_key}"


def _source_span(transcript: str, mention: AiVoiceMention) -> VoiceSourceSpan:
    lowered = transcript.casefold()
    needle = mention.evidence.casefold()
    start = lowered.find(needle) if needle else -1
    end = start + len(mention.evidence) if start >= 0 else None
    return VoiceSourceSpan(
        text=mention.evidence,
        start=start if start >= 0 else None,
        end=end,
        role=mention.role,
        quantity=mention.quantity,
        quantity_explicit=mention.quantity is not None,
    )


def _display_item_name(name: str, variant: str | None) -> str:
    if not variant:
        return name
    if variant.casefold() in name.casefold():
        return name
    return f"{name} ({variant})"


def _merge_group(group: _Group, mention: AiVoiceMention) -> None:
    if not group.category_text and mention.category:
        group.category_text = mention.category
    if not group.description and mention.description:
        group.description = mention.description
    if not group.notes and mention.notes:
        group.notes = mention.notes
    for tag in mention.tags:
        cleaned = tag.strip().lstrip("#")[:60]
        if cleaned and cleaned.casefold() not in {value.casefold() for value in group.tags}:
            group.tags.append(cleaned)
    if mention.confidence is not None:
        group.confidence = (
            mention.confidence
            if group.confidence is None
            else min(group.confidence, mention.confidence)
        )


def _find_target_group(
    groups: list[_Group],
    mention: AiVoiceMention,
    *,
    index,
    default_room_id: uuid.UUID | None,
    default_location_id: uuid.UUID | None,
) -> _Group | None:
    target = (mention.target or mention.name or "").strip()
    target_normalized = _normalize_item_name(target) if target else ""
    room, location, _warnings = _resolve_locations(
        index,
        mention,
        default_room_id=default_room_id,
        default_location_id=default_location_id,
    )
    location_key = _location_key(room, location)
    has_location = bool(mention.room or mention.storage_location)
    candidates: list[_Group] = []
    for group in groups:
        if target_normalized:
            group_key = group.base_name
            score = (
                100
                if group_key == target_normalized
                else int(round(SequenceMatcher(None, group_key, target_normalized).ratio() * 100))
            )
            if score < 82:
                continue
        if has_location and _location_key(group.room, group.storage_location) != location_key:
            continue
        candidates.append(group)
    if not candidates and not target_normalized:
        candidates = list(groups)
    if not candidates:
        return None
    return max(candidates, key=lambda group: group.first_position)


def build_voice_suggestions(
    db: Session,
    household_id: uuid.UUID,
    transcript: str,
    result: AiVoiceResult,
    *,
    default_property_id: uuid.UUID | None = None,
    default_room_id: uuid.UUID | None = None,
    default_location_id: uuid.UUID | None = None,
) -> tuple[list[VoiceSuggestion], list[dict[str, Any]]]:
    """Group structured mentions deterministically.

    AI only supplies individual mentions. Counting, correction replacement,
    summary suppression, location grouping and duplicate detection happen here.
    """
    settings = get_settings()
    index = build_index(db, household_id, default_property_id)
    groups: list[_Group] = []
    warnings: list[dict[str, Any]] = []
    position = 0

    for mention in result.mentions:
        span = _source_span(transcript, mention)
        if mention.role == "correction":
            target = _find_target_group(
                groups,
                mention,
                index=index,
                default_room_id=default_room_id,
                default_location_id=default_location_id,
            )
            if target is None:
                if mention.name:
                    target = _new_group(
                        mention,
                        span,
                        index=index,
                        position=position,
                        default_room_id=default_room_id,
                        default_location_id=default_location_id,
                        warnings=warnings,
                    )
                    groups.append(target)
                    position += 1
                else:
                    warnings.append(
                        {
                            "type": "correction_unmatched",
                            "message": (
                                "A spoken correction could not be matched to an item. "
                                "Review the transcript and try again."
                            ),
                        }
                    )
                continue
            target.sources.append(span)
            if mention.quantity is not None:
                target.quantity = mention.quantity
                target.quantity_explicit = True
            if mention.variant and not target.variant:
                target.variant = mention.variant
            position += 1
            continue

        if mention.role == "summary":
            target = _find_target_group(
                groups,
                mention,
                index=index,
                default_room_id=default_room_id,
                default_location_id=default_location_id,
            )
            if target is not None:
                target.sources.append(span)
                if mention.quantity is not None and not target.quantity_explicit:
                    target.quantity = mention.quantity
                    target.quantity_explicit = True
                position += 1
                continue
            # A summary without an earlier item still describes the only item.
            group = _new_group(
                mention,
                span,
                index=index,
                position=position,
                default_room_id=default_room_id,
                default_location_id=default_location_id,
                warnings=warnings,
            )
            groups.append(group)
            position += 1
            continue

        room, location, location_warnings = _resolve_locations(
            index,
            mention,
            default_room_id=default_room_id,
            default_location_id=default_location_id,
        )
        base_name = _normalize_item_name(mention.name or "")
        if not base_name:
            warnings.append(
                {
                    "type": "item_skipped",
                    "message": "A spoken item had no usable name and was skipped.",
                }
            )
            position += 1
            continue
        variant = mention.variant.strip() if mention.variant else None
        key = "|".join(
            [
                base_name,
                _normalize(variant or ""),
                _normalize(mention.brand or ""),
                _normalize(mention.model or ""),
                _normalize(mention.serial_number or ""),
                _location_key(room, location),
            ]
        )
        group = next((entry for entry in groups if entry.key == key), None)
        if group is None:
            group = _Group(
                base_name=base_name,
                display_name=_display_item_name(mention.name or base_name, variant),
                variant=variant,
                brand=mention.brand,
                model=mention.model,
                serial_number=mention.serial_number,
                key=key,
                room=room,
                storage_location=location,
                first_position=position,
            )
            groups.append(group)
        group.quantity += mention.quantity if mention.quantity is not None else 1
        group.mention_count += 1
        group.quantity_explicit = group.quantity_explicit or mention.quantity is not None
        group.sources.append(span)
        _merge_group(group, mention)
        for message in location_warnings:
            if message not in group.warnings:
                group.warnings.append(message)
        position += 1

    suggestions: list[VoiceSuggestion] = []
    for group in sorted(groups, key=lambda entry: entry.first_position):
        if group.quantity <= 0:
            warnings.append(
                {
                    "type": "zero_quantity",
                    "message": f"{group.display_name} had a count of zero and was skipped.",
                }
            )
            continue
        if len(suggestions) >= settings.voice_max_suggestions:
            warnings.append(
                {
                    "type": "suggestion_limit",
                    "message": (
                        f"Only the first {settings.voice_max_suggestions} item groups are "
                        "shown. Edit the transcript and interpret again for more."
                    ),
                }
            )
            break
        category = match_category(group.category_text, index)
        proposed = ProposedItem(
            name=group.display_name,
            description=group.description,
            quantity=group.quantity,
            category=category,
            brand=group.brand,
            model=group.model,
            serial_number=group.serial_number,
            room=_proposal_from_voice_location(group.room),
            storage_location=_proposal_from_voice_location(group.storage_location),
            tags=group.tags,
            notes=group.notes,
            confidence=group.confidence,
            field_sources={
                "name": "voice",
                "quantity": "voice-explicit" if group.quantity_explicit else "voice-mentions",
            },
        )
        duplicates = find_duplicates(db, household_id, proposed)
        suggestion_warnings: list[str] = list(group.warnings)
        if group.room is not None and group.room.status == "ambiguous":
            suggestion_warnings.append("Choose the intended room.")
        if group.room is not None and group.room.status == "missing":
            suggestion_warnings.append("The spoken room needs a choice or explicit creation.")
        if group.storage_location is not None and group.storage_location.status == "ambiguous":
            suggestion_warnings.append("Choose the intended container or storage place.")
        if group.storage_location is not None and group.storage_location.status == "missing":
            suggestion_warnings.append("The spoken container needs a choice or explicit creation.")
        if any(candidate.score >= 55 for candidate in duplicates):
            suggestion_warnings.append(
                "A possible existing item was found. Choose how to handle it before applying."
            )
        suggestions.append(
            VoiceSuggestion(
                id=uuid.uuid4(),
                name=group.display_name,
                description=group.description,
                quantity=group.quantity,
                variant=group.variant,
                category=category,
                brand=group.brand,
                model=group.model,
                serial_number=group.serial_number,
                tags=group.tags,
                notes=group.notes,
                room=group.room,
                storage_location=group.storage_location,
                confidence=group.confidence,
                mention_count=max(1, group.mention_count),
                quantity_explicit=group.quantity_explicit,
                sources=group.sources,
                duplicate_candidates=duplicates,
                warnings=suggestion_warnings,
            )
        )

    for message in result.warnings:
        warnings.append({"type": "ai_warning", "message": message[:500]})
    for move in result.moves:
        warnings.append(
            {
                "type": "unsupported_move",
                "message": (
                    "Move statements are not supported yet. Use the item or container "
                    f"page to move it manually: {move.text[:500]}"
                ),
                "text": move.text[:1000],
            }
        )
    if not result.mentions and not result.moves:
        warnings.append(
            {
                "type": "no_entries",
                "message": (
                    "No inventory statements were detected. Edit the transcript or "
                    "add the item manually."
                ),
            }
        )
    return suggestions, warnings


def _new_group(
    mention: AiVoiceMention,
    span: VoiceSourceSpan,
    *,
    index,
    position: int,
    default_room_id: uuid.UUID | None,
    default_location_id: uuid.UUID | None,
    warnings: list[dict[str, Any]],
) -> _Group:
    room, location, location_warnings = _resolve_locations(
        index,
        mention,
        default_room_id=default_room_id,
        default_location_id=default_location_id,
    )
    for message in location_warnings:
        warnings.append({"type": "location_review", "message": message})
    name = mention.name or "Item"
    variant = mention.variant.strip() if mention.variant else None
    base_name = _normalize_item_name(name)
    group = _Group(
        base_name=base_name,
        display_name=_display_item_name(name, variant),
        variant=variant,
        brand=mention.brand,
        model=mention.model,
        serial_number=mention.serial_number,
        key="|".join(
            [
                base_name,
                _normalize(variant or ""),
                _normalize(mention.brand or ""),
                _normalize(mention.model or ""),
                _normalize(mention.serial_number or ""),
                _location_key(room, location),
            ]
        ),
        quantity=mention.quantity if mention.quantity is not None else 1,
        mention_count=1,
        quantity_explicit=mention.quantity is not None,
        sources=[span],
        room=room,
        storage_location=location,
        category_text=mention.category,
        description=mention.description,
        notes=mention.notes,
        tags=[tag.strip().lstrip("#")[:60] for tag in mention.tags if tag.strip()],
        confidence=mention.confidence,
        warnings=list(location_warnings),
        first_position=position,
    )
    return group


def _proposal_from_voice_location(
    location: VoiceLocation | None,
) -> LocationProposal | None:
    if location is None:
        return None
    return LocationProposal(
        text=location.text,
        entity_type=location.entity_type,
        identifier=location.identifier,
        status=location.status,
        matched_id=location.matched_id,
        name=location.name,
        room_id=location.room_id,
        parent_id=location.parent_id,
        suggested_parent_id=location.suggested_parent_id,
        candidates=location.candidates,
    )
