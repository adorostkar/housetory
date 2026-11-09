"""Search scope, per-household outcome and AI status helpers."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from ...domain import AiTask
from ...models import Household
from ...schemas.ai import (
    AiStatus,
    AssistantPlan,
)
from .. import ai, global_assistant, global_search
from ..ai_tools import ToolResult

PROPERTY_AWARE_TOOLS = global_assistant.PROPERTY_AWARE_TOOLS | {"get_loan_history"}


@dataclass
class HouseholdOutcome:
    household: Household
    role: str
    result: ToolResult | None = None
    answer: str | None = None
    plan: AssistantPlan | None = None
    interpretation: str = ""
    ai_used: bool = False
    ai_attempted: bool = False
    ai_status: AiStatus | None = None
    structured: bool = False
    notices: list[str] = field(default_factory=list)


def _scope_key(scope: global_search.SearchScope) -> str:
    household_ids = ",".join(sorted(str(household.id) for household, _role in scope.households))
    property_id = str(scope.property.id) if scope.property is not None else ""
    return f"{household_ids}|{property_id}"


def _status_for_household(
    db: Session, household_id: uuid.UUID
) -> tuple[AiStatus, str]:
    """Reuse a configured search task, else the configured assistant task.

    This does not create or override settings; it only avoids demanding a
    separate search-provider assignment when the household already consented to
    an assistant model.
    """
    search_status = ai.status_for(db, household_id, AiTask.SEARCH.value, probe=False)
    if search_status.configured:
        return search_status, AiTask.SEARCH.value
    assistant_status = ai.status_for(
        db, household_id, AiTask.ASSISTANT.value, probe=False
    )
    if assistant_status.configured:
        return assistant_status, AiTask.ASSISTANT.value
    return search_status, AiTask.SEARCH.value


def _disabled_status(note: str | None = None) -> AiStatus:
    return AiStatus(
        provider="none",
        mode="disabled",
        model=None,
        configured=False,
        available=False,
        error=None,
        privacy_note=note
        or (
            "No configured AI provider is available for this scope. Direct "
            "inventory lookup and read-only deterministic retrieval still work."
        ),
    )


def _aggregate_status(
    db: Session, scope: global_search.SearchScope
) -> tuple[AiStatus, list[str]]:
    statuses: list[AiStatus] = []
    configured_labels: list[str] = []
    for household, _role in scope.households:
        status, _task = _status_for_household(db, household.id)
        statuses.append(status)
        if status.configured:
            configured_labels.append(household.name)
    if not statuses:
        return _disabled_status(), []
    configured = [status for status in statuses if status.configured]
    if not configured:
        return statuses[0], []
    first = configured[0]
    return first.model_copy(
        update={
            "available": False,
            "privacy_note": (
                "AI interpretation is executed per household using that household's "
                "own provider and consent. Configured for: "
                + ", ".join(configured_labels)
                + ". No records are sent through another household's provider."
            ),
        }
    ), configured_labels
