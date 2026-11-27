"""The kept correction of an import row that still waits, and the row as it was read.

A waiting row can hold a draft: the edited proposal, with the choices of the row in
``relationships.review_draft``. The proposal as it was read before the first
correction is kept there too, under ``base``. Optional AI suggestions are made for
that first reading, so a correction that is only kept does not make them out of date.
"""

from typing import Any, get_args

from ..schemas.imports import EDITABLE_PROPOSAL_FIELDS

REVIEW_DRAFT_KEY = "review_draft"
BASE_KEY = "base"
_EDITABLE = get_args(EDITABLE_PROPOSAL_FIELDS)


def kept_draft(proposed: dict[str, Any] | None) -> dict[str, Any] | None:
    """The choices that are kept with a row, or None."""
    relationships = (proposed or {}).get("relationships")
    draft = relationships.get(REVIEW_DRAFT_KEY) if isinstance(relationships, dict) else None
    return draft if isinstance(draft, dict) else None


def first_reading(proposed: dict[str, Any] | None) -> dict[str, Any] | None:
    """The proposal before the first kept correction, when the row has one."""
    base = (kept_draft(proposed) or {}).get(BASE_KEY)
    return base if isinstance(base, dict) else None


def source_proposed(proposed: dict[str, Any]) -> dict[str, Any]:
    """The proposal as it was read. A correction that is only kept is not part of it."""
    return first_reading(proposed) or proposed


def public_proposed(proposed: dict[str, Any]) -> dict[str, Any]:
    """The proposal as the review gets it: with the choices, without the first reading."""
    draft = kept_draft(proposed)
    if draft is None or BASE_KEY not in draft:
        return proposed
    relationships = {
        **proposed["relationships"],
        REVIEW_DRAFT_KEY: {key: value for key, value in draft.items() if key != BASE_KEY},
    }
    return {**proposed, "relationships": relationships}


def _plain_relationships(proposed: dict[str, Any]) -> dict[str, Any]:
    relationships = proposed.get("relationships")
    if not isinstance(relationships, dict):
        return {}
    return {key: value for key, value in relationships.items() if key != REVIEW_DRAFT_KEY}


def edited_fields(proposed: dict[str, Any]) -> list[str]:
    """The fields a person changed: the ones the draft names, and the ones that differ."""
    draft = kept_draft(proposed) or {}
    named = draft.get("edited_fields")
    edited = {field for field in named if field in _EDITABLE} if isinstance(named, list) else set()
    base = first_reading(proposed)
    if base is not None:
        for field in _EDITABLE:
            if field == "relationships":
                changed = _plain_relationships(proposed) != _plain_relationships(base)
            else:
                changed = proposed.get(field) != base.get(field)
            if changed:
                edited.add(field)
    return [field for field in _EDITABLE if field in edited]


def with_draft(
    proposed: dict[str, Any], choices: dict[str, Any], base: dict[str, Any]
) -> dict[str, Any]:
    """An edited proposal as stored for a waiting row: choices and first reading inside."""
    relationships = {
        **_plain_relationships(proposed),
        REVIEW_DRAFT_KEY: {
            **{key: value for key, value in choices.items() if key != BASE_KEY},
            BASE_KEY: base,
        },
    }
    return {**proposed, "relationships": relationships}


def carry_draft_over(current: dict[str, Any], suggested: dict[str, Any]) -> dict[str, Any] | None:
    """A newer suggestion with the person's draft on top, or None when there is no draft.

    The fields the person changed keep the person's value; the rest take the
    suggestion. The choices of the row are kept. The suggestion becomes the new first
    reading.
    """
    draft = kept_draft(current)
    if draft is None:
        return None
    edited = edited_fields(current)
    merged = {**suggested, "relationships": _plain_relationships(suggested)}
    for field in edited:
        merged[field] = (
            _plain_relationships(current) if field == "relationships" else current.get(field)
        )
    choices = {key: value for key, value in draft.items() if key != "edited_fields"}
    if edited:
        choices["edited_fields"] = edited
    return with_draft(merged, choices, suggested)
