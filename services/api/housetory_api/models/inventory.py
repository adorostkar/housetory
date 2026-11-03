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

from ..domain import CustomFieldType, ItemCondition, LocationKind
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
            "kind in ('room', 'closet', 'cabinet', 'shelf', 'drawer', 'box', 'bin', 'other')",
            name="valid_kind",
        ),
        Index("ix_storage_locations_household_room", "household_id", "room_id"),
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

    household: Mapped["Household"] = relationship(back_populates="items")
    room: Mapped[Room | None] = relationship(back_populates="items")
    storage_location: Mapped[StorageLocation | None] = relationship(back_populates="items")
    category: Mapped[Category | None] = relationship(back_populates="items")
    tags: Mapped[list[Tag]] = relationship(secondary=item_tags, back_populates="items")
    purchase: Mapped["Purchase | None"] = relationship(
        back_populates="item", cascade="all, delete-orphan", uselist=False
    )
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
    )

    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("items.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    vendor: Mapped[str | None] = mapped_column(String(160))
    purchase_date: Mapped[date | None] = mapped_column(Date)
    price_cents: Mapped[int | None] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, server_default="USD")
    order_number: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)

    item: Mapped[Item] = relationship(back_populates="purchase")


class Warranty(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "warranties"
    __table_args__ = (
        CheckConstraint(
            "start_date IS NULL OR end_date IS NULL OR end_date >= start_date",
            name="dates_in_order",
        ),
    )

    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("items.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    provider: Mapped[str | None] = mapped_column(String(160))
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)

    item: Mapped[Item] = relationship(back_populates="warranty")


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
    __table_args__ = (CheckConstraint("byte_size > 0", name="byte_size_positive"),)

    household_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("households.id", ondelete="CASCADE"), nullable=False
    )
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False, unique=True)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    byte_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
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
