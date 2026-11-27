"""The kept correction of an import row that still waits, and the row as it was read.

A waiting row can hold a draft: the edited proposal, with the choices of the row in
``relationships.review_draft``. The proposal as it was read before the first
correction is kept there too, under ``base``. Optional AI suggestions are made for
that first reading, so a correction that is only kept does not make them out of date.
"""

from typing import Any, get_args

from ..schemas.imports import EDITABLE_PROPOSAL_FIELDS
from .draft_revisions import REVISION_KEY, WRITER_KEY, revision_of, writer_of

REVIEW_DRAFT_KEY = "review_draft"
BASE_KEY = "base"
# The draft of a row was taken back: only its first reading and its revision are kept.
STUB_KEY = "stub"
_PRIVATE = {BASE_KEY, REVISION_KEY, WRITER_KEY, STUB_KEY}
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


def _without_meta(proposed: dict[str, Any]) -> dict[str, Any]:
    """A stored row without the revision and the writer of its draft."""
    draft = kept_draft(proposed)
    if draft is None or not ({REVISION_KEY, WRITER_KEY} & draft.keys()):
        return proposed
    kept = {key: value for key, value in draft.items() if key not in {REVISION_KEY, WRITER_KEY}}
    return {**proposed, "relationships": {**proposed["relationships"], REVIEW_DRAFT_KEY: kept}}


def source_proposed(proposed: dict[str, Any]) -> dict[str, Any]:
    """The proposal as it was read. A correction that is only kept is not part of it.

    The revision and the writer of a draft are never part of it either.
    """
    return first_reading(proposed) or _without_meta(proposed)


def is_stub(draft: dict[str, Any] | None) -> bool:
    """True when the draft was taken back and only its revision is still kept."""
    return bool(draft and draft.get(STUB_KEY))


def draft_revision(proposed: dict[str, Any] | None) -> int:
    """How often the kept draft of a row changed. A row without one is at 0."""
    return revision_of(kept_draft(proposed))


def draft_writer(proposed: dict[str, Any] | None) -> str | None:
    """The device that stored the kept draft of a row."""
    return writer_of(kept_draft(proposed))


def public_proposed(proposed: dict[str, Any]) -> dict[str, Any]:
    """The proposal as the review gets it: with the choices of the row and nothing else.

    The first reading, the revision and the writer stay on the server.
    """
    draft = kept_draft(proposed)
    if draft is None or not (_PRIVATE & draft.keys()):
        return proposed
    if is_stub(draft):
        return first_reading(proposed) or {
            **proposed,
            "relationships": _plain_relationships(proposed),
        }
    relationships = {
        **proposed["relationships"],
        REVIEW_DRAFT_KEY: {key: value for key, value in draft.items() if key not in _PRIVATE},
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
    proposed: dict[str, Any],
    choices: dict[str, Any],
    base: dict[str, Any],
    *,
    revision: int = 0,
    writer: str | None = None,
) -> dict[str, Any]:
    """An edited proposal as stored for a waiting row: choices and first reading inside."""
    relationships = {
        **_plain_relationships(proposed),
        REVIEW_DRAFT_KEY: {
            **{key: value for key, value in choices.items() if key not in _PRIVATE},
            BASE_KEY: base,
            REVISION_KEY: revision,
            WRITER_KEY: writer,
        },
    }
    return {**proposed, "relationships": relationships}


def without_draft(base: dict[str, Any], *, revision: int, writer: str | None) -> dict[str, Any]:
    """A row whose draft was taken back: its first reading, and the revision beside it."""
    relationships = {
        **_plain_relationships(base),
        REVIEW_DRAFT_KEY: {
            STUB_KEY: True,
            BASE_KEY: base,
            REVISION_KEY: revision,
            WRITER_KEY: writer,
        },
    }
    return {**base, "relationships": relationships}


def same_draft(left: dict[str, Any], right: dict[str, Any]) -> bool:
    """True when two stored rows say the same, whatever their revision and writer."""
    return _without_meta(left) == _without_meta(right)


def carry_draft_over(current: dict[str, Any], suggested: dict[str, Any]) -> dict[str, Any]:
    """A newer suggestion as stored for a waiting row, with the person's draft on top.

    The fields the person changed keep the person's value; the rest take the
    suggestion. The choices of the row are kept. The suggestion becomes the new first
    reading.
    """
    draft = kept_draft(current)
    if draft is None or is_stub(draft):
        # No correction to keep. The revision still goes up, for the same reason.
        return without_draft(suggested, revision=revision_of(draft) + 1, writer=None)
    edited = edited_fields(current)
    merged = {**suggested, "relationships": _plain_relationships(suggested)}
    for field in edited:
        merged[field] = (
            _plain_relationships(current) if field == "relationships" else current.get(field)
        )
    choices = {key: value for key, value in draft.items() if key != "edited_fields"}
    if edited:
        choices["edited_fields"] = edited
    # The row changed on the server, so a correction made on the older row must not
    # go on top without a question.
    return with_draft(merged, choices, suggested, revision=revision_of(draft) + 1)
