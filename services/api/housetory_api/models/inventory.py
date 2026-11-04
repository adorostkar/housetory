import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Table,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..domain import (
    CustomFieldType,
    DocumentType,
    ItemCondition,
    LocationKind,
    OcrStatus,
)
from .base import Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from .auth import Household


class Room(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "rooms"
    __table_args__ = (
        CheckConstraint("parent_id IS NULL OR parent_id <> id", name="not_own_parent"),
        CheckConstraint("length(name) between 1 and 120", name="name_length"),
        Index("ix_rooms_household_parent", "household_id", "parent_id"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="SET NULL")
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    household: Mapped["Household"] = relationship(back_populates="rooms")
    parent: Mapped["Room | None"] = relationship(remote_side="Room.id", back_populates="children")
    children: Mapped[list["Room"]] = relationship(back_populates="parent")
    storage_locations: Mapped[list["StorageLocation"]] = relationship(
        back_populates="room", cascade="all, delete-orphan"
    )
    items: Mapped[list["Item"]] = relationship(back_populates="room")


class StorageLocation(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "storage_locations"
    __table_args__ = (
        CheckConstraint("parent_id IS NULL OR parent_id <> id", name="not_own_parent"),
        CheckConstraint("length(name) between 1 and 120", name="name_length"),
        CheckConstraint(
            "kind in ('room', 'closet', 'cabinet', 'shelf', 'drawer', 'box', 'bin', "
            "'crate', 'suitcase', 'bag', 'other')",
            name="valid_kind",
        ),
        CheckConstraint(
            "container_type is null or container_type in "
            "('box', 'bin', 'crate', 'suitcase', 'bag', 'other')",
            name="valid_container_type",
        ),
        CheckConstraint(
            "identifier is null or identifier ~ '^[A-Z]{2,12}-[0-9]{3,6}$'",
            name="identifier_format",
        ),
        CheckConstraint(
            "is_container = false or container_type is not null",
            name="container_type_required",
        ),
        UniqueConstraint(
            "household_id", "identifier", name="uq_storage_locations_household_identifier"
        ),
        Index("ix_storage_locations_household_room", "household_id", "room_id"),
        Index("ix_storage_locations_household_container", "household_id", "is_container"),
        Index("ix_storage_locations_parent_id", "parent_id"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    room_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("storage_locations.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=LocationKind.SHELF.value
    )
    is_container: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    container_type: Mapped[str | None] = mapped_column(String(20))
    identifier: Mapped[str | None] = mapped_column(String(32))
    summary_short: Mapped[str | None] = mapped_column(Text)
    summary_detailed: Mapped[str | None] = mapped_column(Text)
    summary_headline: Mapped[str | None] = mapped_column(Text)
    summary_source: Mapped[str | None] = mapped_column(String(20))
    summary_generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    summary_contents_hash: Mapped[str | None] = mapped_column(String(64))
    label_generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    household: Mapped["Household"] = relationship(back_populates="storage_locations")
    room: Mapped[Room] = relationship(back_populates="storage_locations")
    parent: Mapped["StorageLocation | None"] = relationship(
        remote_side="StorageLocation.id", back_populates="children"
    )
    children: Mapped[list["StorageLocation"]] = relationship(
        back_populates="parent", cascade="all, delete-orphan"
    )
    items: Mapped[list["Item"]] = relationship(back_populates="storage_location")


class LocationIdentifierCounter(Base):
    """Append-only allocator for permanent human-readable location identifiers.

    Updates are atomic and transaction-scoped. The row is never decremented on
    deletion, so identifiers are never reused within a household.
    """

    __tablename__ = "location_identifier_counters"
    __table_args__ = (CheckConstraint("last_value >= 0", name="last_value_non_negative"),)

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("households.id", ondelete="CASCADE"),
        primary_key=True,
    )
    prefix: Mapped[str] = mapped_column(String(16), primary_key=True)
    last_value: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")


class Category(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "categories"
    __table_args__ = (
        CheckConstraint("parent_id IS NULL OR parent_id <> id", name="not_own_parent"),
        CheckConstraint("length(name) between 1 and 80", name="name_length"),
        Index("ix_categories_household_parent", "household_id", "parent_id"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("categories.id", ondelete="SET NULL")
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    color: Mapped[str | None] = mapped_column(String(7))
    description: Mapped[str | None] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    household: Mapped["Household"] = relationship(back_populates="categories")
    parent: Mapped["Category | None"] = relationship(
        remote_side="Category.id", back_populates="children"
    )
    children: Mapped[list["Category"]] = relationship(back_populates="parent")
    items: Mapped[list["Item"]] = relationship(back_populates="category")


class Tag(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "tags"
    __table_args__ = (
        CheckConstraint("length(name) between 1 and 60", name="name_length"),
        UniqueConstraint("household_id", "name", name="uq_tags_household_name"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    household: Mapped["Household"] = relationship(back_populates="tags")
    items: Mapped[list["Item"]] = relationship(secondary="item_tags", back_populates="tags")


item_tags = Table(
    "item_tags",
    Base.metadata,
    Column(
        "item_id",
        UUID(as_uuid=True),
        ForeignKey("items.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "tag_id",
        UUID(as_uuid=True),
        ForeignKey("tags.id", ondelete="CASCADE"),
        primary_key=True,
    ),
)

item_documents = Table(
    "item_documents",
    Base.metadata,
    Column(
        "item_id",
        UUID(as_uuid=True),
        ForeignKey("items.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "document_id",
        UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
)


class Item(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "items"
    __table_args__ = (
        CheckConstraint("quantity >= 0", name="quantity_non_negative"),
        CheckConstraint(
            "condition in ('new', 'excellent', 'good', 'fair', 'poor', 'unknown')",
            name="valid_condition",
        ),
        CheckConstraint("length(name) between 1 and 200", name="name_length"),
        Index("ix_items_household_created", "household_id", "created_at"),
        Index("ix_items_household_room", "household_id", "room_id"),
        Index("ix_items_household_location", "household_id", "storage_location_id"),
        Index("ix_items_household_category", "household_id", "category_id"),
        Index("ix_items_household_purchase", "household_id", "purchase_id"),
        CheckConstraint(
            "current_value_cents IS NULL OR current_value_cents >= 0",
            name="current_value_non_negative",
        ),
        CheckConstraint(
            "char_length(current_value_currency) = 3",
            name="current_value_currency_length",
        ),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    room_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="SET NULL")
    )
    storage_location_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("storage_locations.id", ondelete="SET NULL")
    )
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("categories.id", ondelete="SET NULL")
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    brand: Mapped[str | None] = mapped_column(String(120))
    model: Mapped[str | None] = mapped_column(String(120))
    serial_number: Mapped[str | None] = mapped_column(String(200))
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    condition: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=ItemCondition.GOOD.value
    )
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    purchase_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("purchases.id", ondelete="SET NULL")
    )
    current_value_cents: Mapped[int | None] = mapped_column(BigInteger)
    current_value_currency: Mapped[str] = mapped_column(
        String(3), nullable=False, server_default="USD"
    )

    household: Mapped["Household"] = relationship(back_populates="items")
    room: Mapped[Room | None] = relationship(back_populates="items")
    storage_location: Mapped[StorageLocation | None] = relationship(back_populates="items")
    category: Mapped[Category | None] = relationship(back_populates="items")
    tags: Mapped[list[Tag]] = relationship(secondary=item_tags, back_populates="items")
    purchase: Mapped["Purchase | None"] = relationship(back_populates="items")
    warranty: Mapped["Warranty | None"] = relationship(
        back_populates="item", cascade="all, delete-orphan", uselist=False
    )
    photos: Mapped[list["ItemPhoto"]] = relationship(
        back_populates="item", cascade="all, delete-orphan", order_by="ItemPhoto.sort_order"
    )
    documents: Mapped[list["Document"]] = relationship(
        secondary=item_documents, back_populates="items"
    )
    custom_values: Mapped[list["ItemCustomValue"]] = relationship(
        back_populates="item", cascade="all, delete-orphan"
    )


class Purchase(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "purchases"
    __table_args__ = (
        CheckConstraint("price_cents IS NULL OR price_cents >= 0", name="price_non_negative"),
        CheckConstraint("char_length(currency) = 3", name="currency_length"),
        Index("ix_purchases_household_date", "household_id", "purchase_date"),
        Index("ix_purchases_receipt_document_id", "receipt_document_id"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    receipt_document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="SET NULL")
    )
    vendor: Mapped[str | None] = mapped_column(String(160))
    purchase_date: Mapped[date | None] = mapped_column(Date)
    price_cents: Mapped[int | None] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, server_default="USD")
    order_number: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)

    items: Mapped[list[Item]] = relationship(back_populates="purchase")
    receipt_document: Mapped["Document | None"] = relationship(foreign_keys=[receipt_document_id])


class Warranty(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "warranties"
    __table_args__ = (
        CheckConstraint(
            "start_date IS NULL OR end_date IS NULL OR end_date >= start_date",
            name="dates_in_order",
        ),
        CheckConstraint(
            "duration_months IS NULL OR duration_months between 1 and 1200",
            name="duration_months_range",
        ),
        CheckConstraint(
            "reminder_days IS NULL OR reminder_days between 1 and 3650",
            name="reminder_days_range",
        ),
        Index("ix_warranties_end_date", "end_date"),
        Index("ix_warranties_document_id", "document_id"),
    )

    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("items.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="SET NULL")
    )
    provider: Mapped[str | None] = mapped_column(String(160))
    start_date: Mapped[date | None] = mapped_column(Date)
    duration_months: Mapped[int | None] = mapped_column(Integer)
    end_date: Mapped[date | None] = mapped_column(Date)
    reminder_days: Mapped[int | None] = mapped_column(Integer)
    notes: Mapped[str | None] = mapped_column(Text)

    item: Mapped[Item] = relationship(back_populates="warranty")
    document: Mapped["Document | None"] = relationship(foreign_keys=[document_id])


class ItemPhoto(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "item_photos"
    __table_args__ = (
        CheckConstraint("byte_size > 0", name="byte_size_positive"),
        Index("ix_item_photos_item_id", "item_id"),
    )

    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="CASCADE"), nullable=False
    )
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False, unique=True)
    thumbnail_key: Mapped[str | None] = mapped_column(String(500), unique=True)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    byte_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    item: Mapped[Item] = relationship(back_populates="photos")


class Document(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "documents"
    __table_args__ = (
        CheckConstraint("byte_size > 0", name="byte_size_positive"),
        CheckConstraint("original_byte_size > 0", name="original_byte_size_positive"),
        CheckConstraint(
            "document_type in ('receipt', 'invoice', 'warranty_certificate', 'manual', "
            "'specification', 'other')",
            name="valid_document_type",
        ),
        CheckConstraint(
            "ocr_status in ('not_requested', 'queued', 'processing', 'succeeded', 'failed')",
            name="valid_ocr_status",
        ),
        CheckConstraint(
            "ocr_confidence IS NULL OR ocr_confidence between 0 and 100",
            name="ocr_confidence_range",
        ),
        Index("ix_documents_household_type", "household_id", "document_type"),
        Index("ix_documents_household_created", "household_id", "created_at"),
        Index("ix_documents_ocr_status", "ocr_status"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False, unique=True)
    original_storage_key: Mapped[str] = mapped_column(String(500), nullable=False, unique=True)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    original_content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    byte_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    original_byte_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    document_type: Mapped[str] = mapped_column(
        String(24), nullable=False, server_default=DocumentType.OTHER.value
    )
    document_date: Mapped[date | None] = mapped_column(Date)
    merchant: Mapped[str | None] = mapped_column(String(160))
    notes: Mapped[str | None] = mapped_column(Text)
    extracted_text: Mapped[str | None] = mapped_column(Text)
    extracted_metadata: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default="{}"
    )
    ocr_status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=OcrStatus.NOT_REQUESTED.value
    )
    ocr_error: Mapped[str | None] = mapped_column(Text)
    ocr_confidence: Mapped[int | None] = mapped_column(Integer)
    ocr_processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    household: Mapped["Household"] = relationship(back_populates="documents")
    items: Mapped[list[Item]] = relationship(secondary=item_documents, back_populates="documents")


class CustomFieldDefinition(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "custom_field_definitions"
    __table_args__ = (
        CheckConstraint(
            "field_type in ('text', 'number', 'date', 'boolean', 'select')",
            name="valid_field_type",
        ),
        UniqueConstraint("household_id", "key", name="uq_custom_fields_household_key"),
    )

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    key: Mapped[str] = mapped_column(String(80), nullable=False)
    field_type: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=CustomFieldType.TEXT.value
    )
    options: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default="[]")
    required: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")


class ItemCustomValue(Base):
    __tablename__ = "item_custom_values"

    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("items.id", ondelete="CASCADE"), primary_key=True
    )
    field_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("custom_field_definitions.id", ondelete="CASCADE"),
        primary_key=True,
    )
    value: Mapped[Any] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    item: Mapped[Item] = relationship(back_populates="custom_values")
    field: Mapped[CustomFieldDefinition] = relationship()


__all__ = [
    "Category",
    "CustomFieldDefinition",
    "Document",
    "Item",
    "ItemCustomValue",
    "ItemPhoto",
    "Purchase",
    "Room",
    "StorageLocation",
    "Tag",
    "Warranty",
    "item_documents",
    "item_tags",
]
