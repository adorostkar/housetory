export type UUID = string;

export type MemberRole = "owner" | "member" | "viewer";

export type LocationKind =
  | "room"
  | "closet"
  | "cabinet"
  | "shelf"
  | "drawer"
  | "box"
  | "bin"
  | "crate"
  | "suitcase"
  | "bag"
  | "other";

export type ContainerType = "box" | "bin" | "crate" | "suitcase" | "bag" | "other";

export type ItemCondition = "new" | "excellent" | "good" | "fair" | "poor" | "unknown";

export type DocumentType =
  | "receipt"
  | "invoice"
  | "warranty_certificate"
  | "manual"
  | "specification"
  | "other";

export type OcrStatus =
  | "not_requested"
  | "queued"
  | "processing"
  | "succeeded"
  | "failed";

export type WarrantyStatus = "active" | "expiring" | "expired" | "unknown";
