from enum import StrEnum


class MemberRole(StrEnum):
    OWNER = "owner"
    MEMBER = "member"
    VIEWER = "viewer"


class LocationKind(StrEnum):
    ROOM = "room"
    CLOSET = "closet"
    CABINET = "cabinet"
    SHELF = "shelf"
    DRAWER = "drawer"
    BOX = "box"
    BIN = "bin"
    CRATE = "crate"
    SUITCASE = "suitcase"
    BAG = "bag"
    OTHER = "other"


class ContainerType(StrEnum):
    BOX = "box"
    BIN = "bin"
    CRATE = "crate"
    SUITCASE = "suitcase"
    BAG = "bag"
    OTHER = "other"


CONTAINER_PREFIXES: dict[str, str] = {
    ContainerType.BOX.value: "BOX",
    ContainerType.BIN.value: "BIN",
    ContainerType.CRATE.value: "CRATE",
    ContainerType.SUITCASE.value: "SUITCASE",
    ContainerType.BAG.value: "BAG",
    ContainerType.OTHER.value: "CONT",
}

FIXED_LOCATION_PREFIXES: dict[str, str] = {
    LocationKind.CLOSET.value: "CLOSET",
    LocationKind.CABINET.value: "CABINET",
    LocationKind.SHELF.value: "SHELF",
    LocationKind.DRAWER.value: "DRAWER",
    LocationKind.OTHER.value: "LOC",
    LocationKind.ROOM.value: "LOC",
}


def prefix_for_container_type(container_type: str) -> str:
    return CONTAINER_PREFIXES.get(container_type, "CONT")


def prefix_for_location_kind(kind: str) -> str:
    if kind in CONTAINER_PREFIXES:
        return CONTAINER_PREFIXES[kind]
    return FIXED_LOCATION_PREFIXES.get(kind, "LOC")


class StocktakeStatus(StrEnum):
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    ABANDONED = "abandoned"


class StocktakeObservationStatus(StrEnum):
    PRESENT = "present"
    MISSING = "missing"
    MOVED = "moved"
    QUANTITY_DISCREPANCY = "quantity_discrepancy"
    UNKNOWN = "unknown"
    UNEXPECTED = "unexpected"


class ItemCondition(StrEnum):
    NEW = "new"
    EXCELLENT = "excellent"
    GOOD = "good"
    FAIR = "fair"
    POOR = "poor"
    UNKNOWN = "unknown"


class CustomFieldType(StrEnum):
    TEXT = "text"
    NUMBER = "number"
    DATE = "date"
    BOOLEAN = "boolean"
    SELECT = "select"


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class DocumentType(StrEnum):
    RECEIPT = "receipt"
    INVOICE = "invoice"
    WARRANTY_CERTIFICATE = "warranty_certificate"
    MANUAL = "manual"
    SPECIFICATION = "specification"
    OTHER = "other"


class OcrStatus(StrEnum):
    NOT_REQUESTED = "not_requested"
    QUEUED = "queued"
    PROCESSING = "processing"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class WarrantyStatus(StrEnum):
    ACTIVE = "active"
    EXPIRING = "expiring"
    EXPIRED = "expired"
    UNKNOWN = "unknown"


class PurchaseInfoStatus(StrEnum):
    RECORDED = "recorded"
    UNRECORDED = "unrecorded"
    UNKNOWN = "unknown"
    NOT_APPLICABLE = "not_applicable"


class PurchaseInfoFilter(StrEnum):
    MISSING = "missing"
    UNKNOWN = "unknown"
    NOT_APPLICABLE = "not_applicable"
    RECORDED = "recorded"
    MISSING_DATE = "missing_date"
    MISSING_PRICE = "missing_price"


class ImportSourceType(StrEnum):
    TEXT = "text"
    FILE = "file"
    VAULT = "vault"
    IMAGE = "image"


class ImportStatus(StrEnum):
    QUEUED = "queued"
    PROCESSING = "processing"
    REVIEW = "review"
    APPLYING = "applying"
    COMPLETED = "completed"
    FAILED = "failed"


class ImportEntryStatus(StrEnum):
    PROPOSED = "proposed"
    APPROVED = "approved"
    REJECTED = "rejected"
    IMPORTED = "imported"
    SKIPPED = "skipped"
    MERGED = "merged"
    FAILED = "failed"


class DuplicateResolution(StrEnum):
    NEW = "new"
    SKIP = "skip"
    MERGE = "merge"


class RecognitionStatus(StrEnum):
    QUEUED = "queued"
    PROCESSING = "processing"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class AiProviderType(StrEnum):
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GEMINI = "gemini"
    XAI = "xai"
    OPENROUTER = "openrouter"
    OLLAMA = "ollama"


class AiTask(StrEnum):
    ASSISTANT = "assistant"
    IMPORTS = "imports"
    DOCUMENTS = "documents"
    SEARCH = "search"
    VISION = "vision"
    LABELS = "labels"
    TRANSCRIPTION = "transcription"
    ITEM_IMAGES = "item_images"


class VoiceNoteStatus(StrEnum):
    QUEUED = "queued"
    TRANSCRIBING = "transcribing"
    TRANSCRIBED = "transcribed"
    INTERPRETING = "interpreting"
    REVIEW = "review"
    APPLYING = "applying"
    CONFIRMED = "confirmed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class LoanStatus(StrEnum):
    OUTSTANDING = "outstanding"
    PARTIALLY_RETURNED = "partially_returned"
    RETURNED = "returned"
    CANCELLED = "cancelled"


class ActivityAction(StrEnum):
    ITEM_MOVED = "item.moved"
    ITEMS_BULK_MOVED = "items.bulk_moved"
    ITEMS_BULK_TAGGED = "items.bulk_tagged"
    ITEMS_BULK_CATEGORISED = "items.bulk_categorised"
    CONTAINER_MOVED = "container.moved"
    CONTAINER_DELETED = "container.deleted"
    CONTAINER_RESTORED = "container.restored"
    LOAN_CREATED = "loan.created"
    LOAN_RETURNED = "loan.returned"
    LOAN_CORRECTED = "loan.corrected"
    LOAN_CANCELLED = "loan.cancelled"
    ITEM_MOVE_UNDONE = "item.move_undone"
    CONTAINER_MOVE_UNDONE = "container.move_undone"
    LOAN_CREATION_UNDONE = "loan.creation_undone"
    LOAN_RETURN_UNDONE = "loan.return_undone"
    BORROWED_CREATED = "borrowed.created"
    BORROWED_RETURNED = "borrowed.returned"
    BORROWED_CORRECTED = "borrowed.corrected"
    BORROWED_CANCELLED = "borrowed.cancelled"
    BORROWED_PHOTO_UPDATED = "borrowed.photo_updated"
    BORROWED_PHOTO_REMOVED = "borrowed.photo_removed"
    STOCKTAKE_QUANTITY_CORRECTED = "stocktake.quantity_corrected"
    ROOM_MOVED = "room.moved"
    PLACE_CONTENTS_MOVED = "place.contents_moved"
    PLACE_CONTENTS_MOVED_AND_DELETED = "place.contents_moved_and_deleted"
    ROOM_CONTENTS_MOVED = "room.contents_moved"
    ROOM_CONTENTS_MOVED_AND_DELETED = "room.contents_moved_and_deleted"
    INVENTORY_REVIEW_COMPLETED = "inventory_review.completed"
    INVENTORY_REVIEW_CATEGORY_APPLIED = "inventory_review.category_applied"
    INVENTORY_REVIEW_NAME_APPLIED = "inventory_review.name_applied"
    INVENTORY_REVIEW_DISMISSED = "inventory_review.dismissed"
    INVENTORY_REVIEW_CATEGORY_REVERTED = "inventory_review.category_reverted"
    INVENTORY_REVIEW_NAME_REVERTED = "inventory_review.name_reverted"


class ImportEntityType(StrEnum):
    ITEM = "item"
    ROOM = "room"
    CONTAINER = "container"
    LOCATION = "location"
