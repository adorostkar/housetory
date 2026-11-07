import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from ..domain import ContainerType
from ..schemas.common import Description, Name, ORMModel, trimmed
from ..schemas.documents import DocumentBrief
from ..schemas.items import ItemSummary, LocationBrief, RoomBrief
from ..schemas.properties import PropertyBrief


class ContainerCategoryCount(BaseModel):
    name: str
    item_count: int = 0
    total_quantity: int = 0


class ContainerSummaryOut(BaseModel):
    """Live counts derived from current items; no saved snapshot is used."""

    item_count: int = 0
    total_quantity: int = 0
    direct_item_count: int = 0
    direct_total_quantity: int = 0
    empty: bool = True
    categories: list[ContainerCategoryCount] = Field(default_factory=list)
    label_generated_at: datetime | None = None


class ContainerCreate(BaseModel):
    room_id: uuid.UUID
    parent_id: uuid.UUID | None = None
    container_type: ContainerType = ContainerType.BOX
    name: trimmed(1, 120) | None = None
    description: Description | None = None
    sort_order: int = Field(default=0, ge=-10000, le=10000)


class ContainerBulkCreate(BaseModel):
    room_id: uuid.UUID
    parent_id: uuid.UUID | None = None
    container_type: ContainerType = ContainerType.BOX
    quantity: int = Field(default=1, ge=1, le=100)
    name: Name | None = None
    description: Description | None = None


class ContainerUpdate(BaseModel):
    name: Name | None = None
    description: Description | None = None
    container_type: ContainerType | None = None
    sort_order: int | None = Field(default=None, ge=-10000, le=10000)


class ContainerMove(BaseModel):
    room_id: uuid.UUID
    parent_id: uuid.UUID | None = None


class ContainerConvert(BaseModel):
    location_id: uuid.UUID
    container_type: ContainerType = ContainerType.BOX


class ContainerBrief(ORMModel):
    id: uuid.UUID
    identifier: str | None
    legacy_identifier: str | None = None
    aliases: list[str] = Field(default_factory=list)
    name: str
    kind: str
    container_type: str | None
    is_container: bool
    room_id: uuid.UUID
    parent_id: uuid.UUID | None
    item_count: int = 0
    total_item_count: int = 0
    total_quantity: int = 0
    child_count: int = 0


class ContainerOut(ORMModel):
    id: uuid.UUID
    property: PropertyBrief
    identifier: str | None
    legacy_identifier: str | None = None
    aliases: list[str] = Field(default_factory=list)
    name: str
    description: str | None
    kind: str
    container_type: str | None
    is_container: bool
    room_id: uuid.UUID
    parent_id: uuid.UUID | None
    room: RoomBrief
    path: list[LocationBrief] = Field(default_factory=list)
    item_count: int = 0
    total_item_count: int = 0
    total_quantity: int = 0
    child_count: int = 0
    container_count: int = 0
    recoverable_deleted_child_count: int = 0
    qr_payload: str
    qr_url: str
    qr_warning: str | None = None
    label_generated_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class ContainerDetail(ContainerOut):
    room_path: list[RoomBrief] = Field(default_factory=list)
    items: list[ItemSummary] = Field(default_factory=list)
    children: list[ContainerBrief] = Field(default_factory=list)
    documents: list[DocumentBrief] = Field(default_factory=list)
    summary: ContainerSummaryOut


class ContainerList(BaseModel):
    items: list[ContainerOut]
    total: int
    qr_base_url: str
    qr_warning: str | None = None


class ContainerBulkResult(BaseModel):
    items: list[ContainerOut]
    identifiers: list[str]


class LabelGeometry(BaseModel):
    paper_width_mm: float = Field(default=210.0, gt=0, le=1000)
    paper_height_mm: float = Field(default=297.0, gt=0, le=1000)
    label_width_mm: float = Field(gt=0, le=1000)
    label_height_mm: float = Field(gt=0, le=1000)
    columns: int = Field(ge=1, le=20)
    rows: int = Field(ge=1, le=30)
    top_margin_mm: float = Field(ge=0, le=1000)
    left_margin_mm: float = Field(ge=0, le=1000)
    horizontal_pitch_mm: float = Field(gt=0, le=1000)
    vertical_pitch_mm: float = Field(gt=0, le=1000)

    @model_validator(mode="after")
    def _validate_geometry(self) -> "LabelGeometry":
        if self.horizontal_pitch_mm < self.label_width_mm:
            raise ValueError("Horizontal pitch cannot be smaller than the label width.")
        if self.vertical_pitch_mm < self.label_height_mm:
            raise ValueError("Vertical pitch cannot be smaller than the label height.")
        right = (
            self.left_margin_mm
            + (self.columns - 1) * self.horizontal_pitch_mm
            + self.label_width_mm
        )
        bottom = (
            self.top_margin_mm + (self.rows - 1) * self.vertical_pitch_mm + self.label_height_mm
        )
        if right > self.paper_width_mm + 0.05:
            raise ValueError("Label columns overflow the paper width.")
        if bottom > self.paper_height_mm + 0.05:
            raise ValueError("Label rows overflow the paper height.")
        return self

    @property
    def labels_per_sheet(self) -> int:
        return self.columns * self.rows


class LabelPresetOut(LabelGeometry):
    code: str
    name: str
    description: str
    manufacturer_code: str | None = None
    default_layout: Literal["compact", "standard", "detailed"] = "standard"


class LabelTemplateList(BaseModel):
    items: list[LabelPresetOut]
    default: str


class LabelCalibrationRequest(BaseModel):
    template: str = "L7165"
    custom: LabelGeometry | None = None
    offset_x_mm: float = Field(default=0, ge=-15, le=15)
    offset_y_mm: float = Field(default=0, ge=-15, le=15)
    start_slot: int = Field(default=0, ge=0, le=999)


class LabelPrintRequest(BaseModel):
    location_ids: list[uuid.UUID] = Field(min_length=1, max_length=200)
    template: str = "L7165"
    layout: Literal["compact", "standard", "detailed"] = "standard"
    copies: int = Field(default=1, ge=1, le=100)
    start_slot: int = Field(default=0, ge=0, le=999)
    offset_x_mm: float = Field(default=0, ge=-15, le=15)
    offset_y_mm: float = Field(default=0, ge=-15, le=15)
    record: bool = True
    custom: LabelGeometry | None = None

    @model_validator(mode="after")
    def _limit_total_labels(self) -> "LabelPrintRequest":
        if len(set(self.location_ids)) * self.copies > 1000:
            raise ValueError("A single print job is limited to 1000 labels.")
        return self


class ContainerQrConfig(BaseModel):
    base_url: str
    warning: str | None = None
    local_only: bool
