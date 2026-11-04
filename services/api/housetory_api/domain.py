from enum import StrEnum


class MemberRole(StrEnum):
    OWNER = "owner"
    MEMBER = "member"


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


class ImportEntityType(StrEnum):
    ITEM = "item"
    ROOM = "room"
    CONTAINER = "container"
    LOCATION = "location"
