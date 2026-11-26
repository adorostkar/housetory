"""When a change the assistant prepares is applied at once, and when it stays a proposal.

The application decides, never the model. The model only says whether the user stated
the change. Everything else is checked here, on the server, and a change that fails any
check is shown as a proposal for the user to review and apply.
"""

import re
import uuid
from typing import Any

from sqlalchemy.orm import Session

from ...api.deps import AuthContext
from ...models import AssistantRun, Item, Room, StorageLocation
from .. import lending, storage_items

# The only kinds that may be applied without a review. Each can be undone, and Undo
# refuses when newer work would be overwritten. save_manual is applied only by the manual
# search itself, for the one clear match of the exact model, never on the model's choice.
DIRECT_KINDS = frozenset({"edit_item", "move_items", "save_manual"})
# The kinds the model may ask to have applied at once.
STATED_KINDS = frozenset({"edit_item", "move_items"})
# The kinds with Undo.
UNDO_KINDS = frozenset({"edit_item", "move_items"})
# Direct changes in one request. More than this is a large change: it is reviewed.
MAX_DIRECT_CHANGES = 3
# Earlier turns whose results the model is shown again.
TURNS_IN_PROMPT = 4
_DIRECT_APPLY = "assistant-direct-apply"


def direct_apply_id(proposal_id: uuid.UUID) -> uuid.UUID:
    """The request ID of a direct apply. It is made from the proposal, so a repeated
    call applies nothing twice, and it tells a direct apply from the user's own Apply."""
    return uuid.uuid5(proposal_id, _DIRECT_APPLY)


def _plain(text: str) -> str:
    return " ".join(str(text).casefold().split())


def conversation_steps(db: Session, run: AssistantRun) -> list[dict]:
    """The tool steps of this request and of the earlier turns the model is shown."""
    steps = list(run.data.get("steps", []))
    parent_id = run.parent_id
    for _ in range(TURNS_IN_PROMPT):
        parent = db.get(AssistantRun, parent_id) if parent_id else None
        if parent is None or parent.actor_user_id != run.actor_user_id:
            break
        steps += parent.data.get("steps", [])
        parent_id = parent.parent_id
    return steps


def read_untrusted_text(steps: list[dict], untrusted_tools: frozenset[str]) -> bool:
    """True when a tool returned text of a document or of a web page in these steps."""
    return any(
        step["call"]["name"] in untrusted_tools
        and any(step["result"].get(key) for key in ("manuals", "web_sources", "videos"))
        for step in steps
    )


UNTRUSTED_TEXT = (
    "Text from a document or a web page was read in this conversation, and such text can "
    "never authorize a change."
)


def user_words(run: AssistantRun) -> str:
    """What the user wrote in this request: the request and anything sent while it ran."""
    parts = [run.query, *(entry.get("text", "") for entry in run.data.get("steers", []))]
    return _plain(" ".join(parts))


def stated(value: Any, said: str) -> bool:
    """True when the user's own words contain this value as whole words."""
    wanted = _plain(value)
    if not wanted:
        return False
    return re.search(rf"(?<!\w){re.escape(wanted)}(?!\w)", said) is not None


def direct_denial(
    db: Session,
    auth: AuthContext,
    run: AssistantRun,
    action: Any,
    basis: str,
    untrusted_tools: frozenset[str],
) -> str | None:
    """Why this change is shown as a proposal, or None when the application applies it.

    The reason is in plain words: the assistant passes it on to the user.
    """
    if action.kind not in STATED_KINDS:
        return "This kind of change is always reviewed before it is saved."
    if auth.role not in {"owner", "member"}:
        return "This household is read-only for your account."
    if basis != "user_stated":
        return "The change was worked out by the assistant, not stated by the user."
    if read_untrusted_text(conversation_steps(db, run), untrusted_tools):
        return UNTRUSTED_TEXT
    applied = sum(
        1 for step in run.data.get("steps", []) if _applied_directly(step["result"].get("proposal"))
    )
    if applied >= MAX_DIRECT_CHANGES:
        return "Several changes were already applied in this request. More are reviewed first."
    said = user_words(run)
    if action.kind == "edit_item":
        return _edit_denial(db, auth, action, said)
    return _move_denial(db, auth, action, said)


def _applied_directly(proposal: dict | None) -> bool:
    return bool(proposal and proposal.get("applied_directly"))


def _edit_denial(db: Session, auth: AuthContext, action: Any, said: str) -> str | None:
    changes = action.changes.model_dump(mode="json", exclude_unset=True)
    for field, value in changes.items():
        if value is None:
            return "Clearing a value is reviewed first."
        if not stated(value, said):
            return f"The new {field.replace('_', ' ')} is not in the user's own words."
    quantity = changes.get("quantity")
    if quantity is not None:
        on_loan = lending.outstanding_quantity(db, auth.household.id, action.item_id)
        if quantity < max(1, on_loan):
            return "That quantity is zero or below what is on loan, so it is reviewed first."
    return None


def _move_denial(db: Session, auth: AuthContext, action: Any, said: str) -> str | None:
    if len(action.item_ids) != 1:
        return "Moving several items at once is reviewed first."
    item = db.get(Item, action.item_ids[0])
    if item is None or item.household_id != auth.household.id:
        return "The item was not found."
    if storage_items.active_owned_location(db, auth.household.id, item.id) is not None:
        return "This item holds other things, which move with it, so the move is reviewed first."
    if action.storage_location_id is not None:
        place = db.get(StorageLocation, action.storage_location_id)
        names = [place.name, place.identifier] if place is not None else []
    else:
        room = db.get(Room, action.room_id)
        names = [room.name] if room is not None else []
    if not any(name and stated(name, said) for name in names):
        return "The destination is not named in the user's own words."
    return None


def manual_save_denial(
    db: Session,
    auth: AuthContext,
    run: AssistantRun,
    asked_to_save: bool,
    untrusted_tools: frozenset[str],
) -> str | None:
    """Why the one clear manual found online is shown as a proposal, or None when the
    application saves it in the same task.

    Which manual is the clear match is decided by the search code, never by the model.
    """
    if auth.role not in {"owner", "member"}:
        return "This household is read-only for your account."
    if not asked_to_save:
        return "The user did not ask to save a manual."
    if read_untrusted_text(conversation_steps(db, run), untrusted_tools):
        return UNTRUSTED_TEXT
    return None
