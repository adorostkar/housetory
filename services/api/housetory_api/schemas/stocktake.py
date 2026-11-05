import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from ..schemas.common import trimmed

StocktakeObservationStatus = Literal[
    "present",
    "missing",
    "moved",
    "quantity_discrepancy",
    "unknown",
    "unexpected",
]
StocktakeSessionStatus = Literal["in_progress", "completed", "abandoned"]


class StocktakeStartIn(BaseModel):
    room_ids: list[uuid.UUID] = Field(default_factory=list, max_length=20)
    container_ids: list[uuid.UUID] = Field(default_factory=list, max_length=20)
    include_descendants: bool = True
    request_id: uuid.UUID

    @model_validator(mode="after")
    def _scope_required(self) -> "StocktakeStartIn":
        if not self.room_ids and not self.container_ids:
            raise ValueError("Choose a room or container to stocktake.")
        return self


class StocktakeObservationIn(BaseModel):
    request_id: uuid.UUID
    status: StocktakeObservationStatus
    snapshot_item_id: uuid.UUID | None = None
    counted_quantity: int | None = Field(default=None, ge=0, le=1_000_000)
    room_id: uuid.UUID | None = None
    container_id: uuid.UUID | None = None
    unexpected_name: trimmed(1, 200) | None = None
    linked_item_id: uuid.UUID | None = None
    notes: trimmed(1, 2000) | None = None
    expected_item_updated_at: datetime | None = None
    expected_on_loan_quantity: int | None = Field(default=None, ge=0, le=1_000_000)

    @model_validator(mode="after")
    def _shape(self) -> "StocktakeObservationIn":
        if self.status == "unexpected":
            if self.snapshot_item_id is not None:
                raise ValueError("An unexpected finding cannot target an expected item.")
            if not self.unexpected_name:
                raise ValueError("Enter a name for the unexpected finding.")
            if self.counted_quantity is None:
                raise ValueError("Record how many units were found.")
            return self
        if self.snapshot_item_id is None:
            raise ValueError("Choose an expected item to record an observation.")
        if self.unexpected_name is not None or self.linked_item_id is not None:
            raise ValueError("Unexpected fields only apply to an unexpected finding.")
        if (
            self.status in {"present", "moved", "quantity_discrepancy"}
            and self.counted_quantity is None
        ):
            raise ValueError("Record how many units were counted at home.")
        if self.status == "missing" and self.counted_quantity not in (None, 0):
            raise ValueError("A missing observation records zero units at home.")
        if self.status == "moved":
            if self.room_id is None:
                raise ValueError("Choose the existing room where the item was found.")
        elif self.room_id is not None or self.container_id is not None:
            raise ValueError("A destination only applies to a moved item.")
        if self.status == "unknown" and self.counted_quantity is not None:
            raise ValueError("An unchecked observation cannot record a counted quantity.")
        if self.expected_item_updated_at is None:
            raise ValueError("Reload the item before recording this observation.")
        return self


class StocktakeRefreshIn(BaseModel):
    request_id: uuid.UUID


class StocktakeApplyIn(BaseModel):
    request_id: uuid.UUID
    review_fingerprint: str = Field(min_length=1, max_length=64)
    observation_ids: list[uuid.UUID] = Field(default_factory=list, max_length=500)


class StocktakeCompleteIn(BaseModel):
    request_id: uuid.UUID
    acknowledge_partial: bool = False


class StocktakeAbandonIn(BaseModel):
    request_id: uuid.UUID


class StocktakeSessionOut(BaseModel):
    id: uuid.UUID
    status: StocktakeSessionStatus
    scope_label: str
    scope: dict[str, Any]
    snapshot_fingerprint: str
    expected_item_count: int
    expected_unit_count: int
    expected_at_home_unit_count: int
    expected_on_loan_unit_count: int
    checked_item_count: int
    checked_unit_count: int
    verified_item_count: int
    missing_item_count: int
    quantity_discrepancy_count: int
    unknown_item_count: int
    unexpected_count: int
    coverage: dict[str, Any] = Field(default_factory=dict)
    partial: bool = True
    created_by_name: str
    completed_by_name: str | None = None
    started_at: datetime
    completed_at: datetime | None = None
    abandoned_at: datetime | None = None
    last_refreshed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class StocktakeSessionList(BaseModel):
    items: list[StocktakeSessionOut] = Field(default_factory=list)
    total: int = 0
    limit: int = 20
    offset: int = 0


class StocktakeCurrentItemOut(BaseModel):
    exists: bool = True
    name: str | None = None
    quantity: int | None = None
    on_loan_quantity: int = 0
    at_home_quantity: int = 0
    room_id: uuid.UUID | None = None
    location_id: uuid.UUID | None = None
    location_path: str = ""
    is_archived: bool = False
    updated_at: datetime | None = None
    photo_thumbnail_url: str | None = None


class StocktakeObservationOut(BaseModel):
    id: uuid.UUID
    status: StocktakeObservationStatus
    snapshot_item_id: uuid.UUID | None = None
    item_id: uuid.UUID | None = None
    linked_item_id: uuid.UUID | None = None
    counted_quantity: int | None = None
    observed_room_id: uuid.UUID | None = None
    observed_location_id: uuid.UUID | None = None
    observed_room_name: str | None = None
    observed_location_name: str | None = None
    observed_location_identifier: str | None = None
    observed_location_path: str | None = None
    unexpected_name: str | None = None
    notes: str | None = None
    owned_quantity_at_observation: int | None = None
    on_loan_quantity_at_observation: int = 0
    at_home_quantity_at_observation: int = 0
    verifier_name: str
    observed_at: datetime
    applied: bool = False


class StocktakeItemOut(BaseModel):
    snapshot_item_id: uuid.UUID
    item_id: uuid.UUID | None
    item_name: str
    expected_quantity: int
    expected_at_home_quantity: int
    expected_on_loan_quantity: int
    expected_location_path: str
    item_updated_at: datetime
    changed_since_snapshot: bool = False
    deleted: bool = False
    latest_observation: StocktakeObservationOut | None = None
    correction_applied: bool = False
    current: StocktakeCurrentItemOut


class StocktakeSessionDetail(StocktakeSessionOut):
    items: list[StocktakeItemOut] = Field(default_factory=list)
    unexpected_findings: list[StocktakeObservationOut] = Field(default_factory=list)


class StocktakeProposalOut(BaseModel):
    observation_id: uuid.UUID
    snapshot_item_id: uuid.UUID
    item_id: uuid.UUID | None
    item_name: str
    status: StocktakeObservationStatus
    action: Literal["none", "move", "set_quantity", "move_and_quantity"]
    current_quantity: int | None = None
    proposed_quantity: int | None = None
    current_room_id: uuid.UUID | None = None
    current_room_name: str | None = None
    current_location_id: uuid.UUID | None = None
    current_location_name: str | None = None
    current_location_path: str = ""
    proposed_room_id: uuid.UUID | None = None
    proposed_room_name: str | None = None
    proposed_location_id: uuid.UUID | None = None
    proposed_location_name: str | None = None
    proposed_location_path: str = ""
    on_loan_quantity: int = 0
    counted_quantity: int | None = None
    conflict: str | None = None
    warnings: list[str] = Field(default_factory=list)


class StocktakeReviewOut(BaseModel):
    session_id: uuid.UUID
    fingerprint: str
    proposals: list[StocktakeProposalOut] = Field(default_factory=list)
    actionable_count: int = 0
    conflict_count: int = 0
    can_apply: bool = False
    checked_item_count: int = 0
    expected_item_count: int = 0


class StocktakeApplyOut(BaseModel):
    application_id: uuid.UUID
    session: StocktakeSessionOut
    applied_count: int = 0
    skipped_count: int = 0
    proposals: list[StocktakeProposalOut] = Field(default_factory=list)
    message: str


class StocktakeScopeSummaryOut(BaseModel):
    scope_label: str
    room_id: uuid.UUID | None = None
    container_id: uuid.UUID | None = None
    active_session: StocktakeSessionOut | None = None
    last_completed_session: StocktakeSessionOut | None = None
    last_checked_at: datetime | None = None


__all__ = [
    "StocktakeAbandonIn",
    "StocktakeApplyIn",
    "StocktakeApplyOut",
    "StocktakeCompleteIn",
    "StocktakeCurrentItemOut",
    "StocktakeItemOut",
    "StocktakeObservationIn",
    "StocktakeObservationOut",
    "StocktakeProposalOut",
    "StocktakeRefreshIn",
    "StocktakeReviewOut",
    "StocktakeScopeSummaryOut",
    "StocktakeSessionDetail",
    "StocktakeSessionList",
    "StocktakeSessionOut",
    "StocktakeStartIn",
]
