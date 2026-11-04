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
    OTHER = "other"


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
