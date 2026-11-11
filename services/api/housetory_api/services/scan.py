"""Bounded multi-page document scanning and cleanup.

Draft scan pages live under the household's private uploads directory until the
user commits or cancels. Each page keeps its exact uploaded bytes; the editable
preview is a separate JPEG derivative generated from a four-corner crop,
rotation and conservative contrast/grayscale adjustments.
"""

from __future__ import annotations

import hashlib
import io
import logging
import math
import uuid
import warnings
from datetime import UTC, datetime, timedelta

import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageOps
from pydantic import ValidationError
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload
from starlette.datastructures import Headers, UploadFile

from ..api.errors import ApiError
from ..domain import OcrStatus
from ..models import Document, DocumentScan, DocumentScanPage
from ..schemas.documents import (
    DocumentPageOut,
    DocumentScanCommit,
    DocumentScanOut,
    DocumentScanPageUpdate,
    ScanAdjustments,
    ScanPoint,
)
from . import storage
from .document_ocr import enqueue_ocr
from .documents import get_document, resolve_document_items
from .serializers import document_page_out

logger = logging.getLogger("housetory.scan")

SCAN_MAX_PAGES = 20
SCAN_MAX_TOTAL_BYTES = 100 * 1024 * 1024
SCAN_MAX_OUTPUT_EDGE = 3500
SCAN_STALE_HOURS = 24
SCAN_MAX_ACTIVE = 5
SCAN_DETECTION_EDGE = 1200

cv2.setNumThreads(0)
cv2.ocl.setUseOpenCL(False)

FULL_CORNERS = [
    ScanPoint(x=0.0, y=0.0),
    ScanPoint(x=1.0, y=0.0),
    ScanPoint(x=1.0, y=1.0),
    ScanPoint(x=0.0, y=1.0),
]
DEFAULT_ADJUSTMENTS = ScanAdjustments(corners=FULL_CORNERS)


def _scan_query(household_id: uuid.UUID, scan_id: uuid.UUID):
    return (
        select(DocumentScan)
        .options(selectinload(DocumentScan.pages))
        .where(DocumentScan.id == scan_id, DocumentScan.household_id == household_id)
    )


def get_scan(
    db: Session,
    household_id: uuid.UUID,
    scan_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> DocumentScan:
    query = _scan_query(household_id, scan_id)
    if for_update:
        query = query.with_for_update()
    scan = db.scalar(query)
    if scan is None:
        raise ApiError(404, "scan_not_found", "Scan session not found.")
    return scan


def page_out(page: DocumentScanPage) -> DocumentPageOut:
    return document_page_out(page)


def scan_out(scan: DocumentScan) -> DocumentScanOut:
    pages = sorted(scan.pages, key=lambda page: page.page_index)
    return DocumentScanOut(
        id=scan.id,
        status=scan.status,
        target_document_id=scan.target_document_id,
        pages=[page_out(page) for page in pages],
        created_at=scan.created_at,
        updated_at=scan.updated_at,
    )


def _adjustments_for(page: DocumentScanPage) -> ScanAdjustments:
    try:
        return ScanAdjustments.model_validate(page.adjustments or {})
    except ValidationError:
        return DEFAULT_ADJUSTMENTS


def _ensure_draft(scan: DocumentScan) -> None:
    if scan.status != "draft":
        raise ApiError(409, "scan_committed", "This scan has already been saved.")


def _ensure_new_scan(scan: DocumentScan) -> None:
    if scan.target_document_id is not None:
        raise ApiError(
            409, "cleanup_pages_fixed", "Existing cleanup cannot add, remove or reorder pages."
        )


def _touch(scan: DocumentScan) -> None:
    scan.updated_at = datetime.now(UTC)


def _open_scan_image(path) -> Image.Image:  # noqa: ANN001
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(path, formats=list(storage.SUPPORTED_IMAGE_FORMATS)) as source:
            image = ImageOps.exif_transpose(source)
            image.load()
            return image.copy()


def _apply_rotation(image: Image.Image, rotation: int) -> Image.Image:
    if rotation == 90:
        return image.transpose(Image.Transpose.ROTATE_270)
    if rotation == 180:
        return image.transpose(Image.Transpose.ROTATE_180)
    if rotation == 270:
        return image.transpose(Image.Transpose.ROTATE_90)
    return image


def _quad_is_full(corners: list[ScanPoint]) -> bool:
    return all(
        math.isclose(point.x, expected.x, abs_tol=0.001)
        and math.isclose(point.y, expected.y, abs_tol=0.001)
        for point, expected in zip(corners, FULL_CORNERS, strict=True)
    )


def _quad_cross(points: list[tuple[float, float]], index: int) -> float:
    ax, ay = points[index]
    bx, by = points[(index + 1) % 4]
    cx, cy = points[(index + 2) % 4]
    return (bx - ax) * (cy - by) - (by - ay) * (cx - bx)


def _ordered_quad(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    center_x = sum(point[0] for point in points) / 4
    center_y = sum(point[1] for point in points) / 4
    ordered = sorted(
        points,
        key=lambda point: math.atan2(point[1] - center_y, point[0] - center_x),
    )
    start = min(range(4), key=lambda index: ordered[index][0] + ordered[index][1])
    ordered = ordered[start:] + ordered[:start]
    crosses = [_quad_cross(ordered, index) for index in range(4)]
    if any(abs(value) < 1e-6 for value in crosses):
        raise ApiError(
            422,
            "invalid_scan_corners",
            "Choose a page area with four distinct corners.",
        )
    if not (all(value > 0 for value in crosses) or all(value < 0 for value in crosses)):
        raise ApiError(422, "invalid_scan_corners", "The page crop must be a convex shape.")
    return ordered


def _apply_corners(image: Image.Image, corners: list[ScanPoint]) -> Image.Image:
    if _quad_is_full(corners):
        return image
    width, height = image.size
    points = [(point.x * width, point.y * height) for point in corners]
    ordered = _ordered_quad(points)
    top_left, top_right, bottom_right, bottom_left = ordered
    output_width = round(
        max(
            math.dist(top_left, top_right),
            math.dist(bottom_left, bottom_right),
        )
    )
    output_height = round(
        max(
            math.dist(top_left, bottom_left),
            math.dist(top_right, bottom_right),
        )
    )
    scale = min(1.0, SCAN_MAX_OUTPUT_EDGE / max(output_width, output_height, 1))
    output_width = max(1, round(output_width * scale))
    output_height = max(1, round(output_height * scale))
    transform = cv2.getPerspectiveTransform(
        np.float32(ordered),
        np.float32(
            [
                (0, 0),
                (output_width - 1, 0),
                (output_width - 1, output_height - 1),
                (0, output_height - 1),
            ]
        ),
    )
    return Image.fromarray(
        cv2.warpPerspective(
            np.asarray(image),
            transform,
            (output_width, output_height),
            flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(255, 255, 255),
        )
    )


def detect_page(path) -> tuple[ScanAdjustments, str]:  # noqa: ANN001
    """Propose only clearly inset, bright paper; uncertainty keeps every pixel."""
    with _open_scan_image(path) as source:
        image = source.convert("RGB")
    image.thumbnail((SCAN_DETECTION_EDGE, SCAN_DETECTION_EDGE), Image.Resampling.LANCZOS)
    rgb = np.asarray(image)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    height, width = gray.shape
    area = width * height
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:12]:
        quad = cv2.approxPolyDP(contour, 0.02 * cv2.arcLength(contour, True), True)
        coverage = cv2.contourArea(quad) / area
        if len(quad) != 4 or not cv2.isContourConvex(quad) or not 0.2 < coverage < 0.9:
            continue
        points = quad.reshape(4, 2)
        # A near-frame border or a colour block is not evidence of a separate page.
        if any(
            x < width * 0.025 or x > width * 0.975 or y < height * 0.025 or y > height * 0.975
            for x, y in points
        ):
            continue
        mask = np.zeros_like(gray)
        cv2.fillConvexPoly(mask, points, 255)
        inside = rgb[mask > 0]
        outside = gray[mask == 0]
        if (
            np.median(inside) < 155
            or np.median(np.max(inside, axis=1) - np.min(inside, axis=1)) > 45
            or np.median(gray[mask > 0]) - np.median(outside) < 25
        ):
            continue
        ordered = _ordered_quad([(float(x) / width, float(y) / height) for x, y in points])
        lengths = [math.dist(ordered[i], ordered[(i + 1) % 4]) for i in range(4)]
        if min(lengths) < 0.12 or max(lengths) / min(lengths) > 5:
            continue
        return ScanAdjustments(
            corners=[ScanPoint(x=x, y=y) for x, y in ordered], contrast=1.05
        ), "detected"
    return DEFAULT_ADJUSTMENTS.model_copy(deep=True), "manual_required"


def render_cleaned_image(path, adjustments: ScanAdjustments) -> Image.Image:  # noqa: ANN001
    image = _open_scan_image(path).convert("RGB")
    image.thumbnail((SCAN_MAX_OUTPUT_EDGE, SCAN_MAX_OUTPUT_EDGE), Image.Resampling.LANCZOS)
    image = _apply_rotation(image, adjustments.rotation)
    image = _apply_corners(image, adjustments.corners)
    if adjustments.color_mode in {"grayscale", "document"}:
        image = ImageOps.grayscale(image)
    if adjustments.color_mode == "document":
        image = ImageOps.autocontrast(image, cutoff=1)
    image = ImageEnhance.Contrast(image).enhance(adjustments.contrast)
    if adjustments.color_mode == "document":
        image = ImageEnhance.Sharpness(image).enhance(1.08)
    image = image.convert("RGB")
    image.thumbnail((SCAN_MAX_OUTPUT_EDGE, SCAN_MAX_OUTPUT_EDGE), Image.Resampling.LANCZOS)
    return image


def _pdf_bytes(paths: list, title: str) -> bytes:
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pageCompression=1)
    pdf.setTitle(title[:200])
    pdf.setAuthor("Housetory")
    for path in paths:
        image = _open_scan_image(path).convert("RGB")
        image.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
        page_width, page_height = A4
        if image.width > image.height:
            page_width, page_height = landscape(A4)
        margin = 18
        scale = min(
            (page_width - margin * 2) / image.width,
            (page_height - margin * 2) / image.height,
        )
        draw_width = image.width * scale
        draw_height = image.height * scale
        pdf.setPageSize((page_width, page_height))
        pdf.drawImage(
            ImageReader(image),
            (page_width - draw_width) / 2,
            (page_height - draw_height) / 2,
            width=draw_width,
            height=draw_height,
            preserveAspectRatio=True,
            anchor="c",
        )
        pdf.showPage()
        image.close()
    pdf.save()
    return buffer.getvalue()


def prune_expired_scans(
    db: Session,
    *,
    household_id: uuid.UUID | None = None,
    older_than_hours: int = SCAN_STALE_HOURS,
    limit: int = 200,
) -> dict[str, int]:
    cutoff = datetime.now(UTC) - timedelta(hours=older_than_hours)
    query = (
        select(DocumentScan)
        .options(selectinload(DocumentScan.pages))
        .where(DocumentScan.status == "draft", DocumentScan.updated_at < cutoff)
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    if household_id is not None:
        query = query.where(DocumentScan.household_id == household_id)
    scans = list(db.scalars(query).all())
    keys = [
        key
        for scan in scans
        for page in scan.pages
        for key in (page.original_storage_key, page.cleaned_storage_key)
    ]
    for scan in scans:
        db.delete(scan)
    db.commit()
    for key in keys:
        storage.delete_key(key)
    if scans:
        logger.info("Pruned %s abandoned scan session(s)", len(scans))
    return {"scans": len(scans), "files": len(keys)}


def create_scan(
    db: Session,
    household_id: uuid.UUID,
    *,
    actor_user_id: uuid.UUID | None,
    target_document_id: uuid.UUID | None = None,
) -> DocumentScan:
    prune_expired_scans(db, household_id=household_id)
    active = int(
        db.scalar(
            select(func.count(DocumentScan.id)).where(
                DocumentScan.household_id == household_id,
                DocumentScan.status == "draft",
            )
        )
        or 0
    )
    if active >= SCAN_MAX_ACTIVE:
        raise ApiError(
            409,
            "too_many_scan_sessions",
            "Finish or cancel an existing scan before starting another.",
        )
    scan = DocumentScan(
        id=uuid.uuid4(),
        household_id=household_id,
        status="draft",
        created_by_user_id=actor_user_id,
    )
    target = None
    sources = []
    if target_document_id is not None:
        target = get_document(db, household_id, target_document_id)
        if target.scan is not None and target.scan.pages:
            sources = [
                (
                    page.original_storage_key,
                    page.original_filename,
                    page.original_content_type,
                    page.id,
                )
                for page in sorted(target.scan.pages, key=lambda page: page.page_index)
            ]
        elif target.original_content_type.startswith("image/"):
            sources = [
                (
                    target.original_storage_key,
                    target.original_filename,
                    target.original_content_type,
                    None,
                )
            ]
        else:
            raise ApiError(
                422,
                "cleanup_unsupported",
                "Cleanup requires an image document or retained scan page images.",
            )
        if len(sources) > SCAN_MAX_PAGES:
            raise ApiError(409, "scan_page_limit", "This document contains too many pages.")
        scan.target_document_id = target.id
        scan.base_generation = target.source_generation
    db.add(scan)
    owned_keys: list[str] = []
    try:
        total_bytes = 0
        for index, (key, filename, content_type, source_page_id) in enumerate(sources):
            page_id = uuid.uuid4()
            with storage.resolve_key(key).open("rb") as source:
                upload = UploadFile(
                    source, filename=filename, headers=Headers({"content-type": content_type})
                )
                stored = storage.store_scan_page_original(household_id, scan.id, page_id, upload)
            owned_keys.append(stored.storage_key)
            total_bytes += stored.byte_size
            if total_bytes > SCAN_MAX_TOTAL_BYTES:
                raise ApiError(413, "scan_size_limit", "This document is too large to clean up.")
            path = storage.resolve_key(stored.storage_key)
            adjustments, detection_status = detect_page(path)
            image = render_cleaned_image(path, adjustments)
            try:
                cleaned_key, cleaned_type, cleaned_size, width, height = storage.save_scan_cleaned(
                    household_id, scan.id, page_id, image
                )
            finally:
                image.close()
            owned_keys.append(cleaned_key)
            scan.pages.append(
                DocumentScanPage(
                    id=page_id,
                    household_id=household_id,
                    page_index=index,
                    original_storage_key=stored.storage_key,
                    original_filename=stored.original_filename,
                    original_content_type=stored.content_type,
                    original_byte_size=stored.byte_size,
                    cleaned_storage_key=cleaned_key,
                    cleaned_content_type=cleaned_type,
                    cleaned_byte_size=cleaned_size,
                    width=width,
                    height=height,
                    adjustments=adjustments.model_dump(mode="json"),
                    detection_status=detection_status,
                    source_page_id=source_page_id,
                )
            )
        db.commit()
    except Exception:
        db.rollback()
        for key in owned_keys:
            storage.delete_key(key)
        raise
    return get_scan(db, household_id, scan.id)


def add_page(
    db: Session,
    household_id: uuid.UUID,
    scan_id: uuid.UUID,
    upload,
) -> DocumentScanPage:  # noqa: ANN001
    scan = get_scan(db, household_id, scan_id, for_update=True)
    _ensure_draft(scan)
    _ensure_new_scan(scan)
    if len(scan.pages) >= SCAN_MAX_PAGES:
        raise ApiError(
            409,
            "scan_page_limit",
            f"Scans can contain at most {SCAN_MAX_PAGES} pages.",
        )
    page_id = uuid.uuid4()
    stored = storage.store_scan_page_original(household_id, scan_id, page_id, upload)
    cleaned_key: str | None = None
    try:
        total_bytes = sum(page.original_byte_size for page in scan.pages) + stored.byte_size
        if total_bytes > SCAN_MAX_TOTAL_BYTES:
            raise ApiError(
                413,
                "scan_size_limit",
                "This scan is too large. Remove a page or start a new document.",
            )
        adjustments, detection_status = detect_page(storage.resolve_key(stored.storage_key))
        image = render_cleaned_image(storage.resolve_key(stored.storage_key), adjustments)
        try:
            cleaned_key, cleaned_type, cleaned_size, width, height = storage.save_scan_cleaned(
                household_id, scan_id, page_id, image
            )
        finally:
            image.close()
        page = DocumentScanPage(
            scan_id=scan.id,
            household_id=household_id,
            page_index=len(scan.pages),
            original_storage_key=stored.storage_key,
            cleaned_storage_key=cleaned_key,
            original_filename=stored.original_filename,
            original_content_type=stored.content_type,
            cleaned_content_type=cleaned_type,
            original_byte_size=stored.byte_size,
            cleaned_byte_size=cleaned_size,
            width=width,
            height=height,
            adjustments=adjustments.model_dump(mode="json"),
            detection_status=detection_status,
        )
        scan.pages.append(page)
        _touch(scan)
        db.commit()
        db.refresh(page)
        return page
    except Exception:
        db.rollback()
        storage.delete_key(stored.storage_key)
        if cleaned_key:
            storage.delete_key(cleaned_key)
        raise


def get_page(
    db: Session,
    household_id: uuid.UUID,
    scan_id: uuid.UUID,
    page_id: uuid.UUID,
    *,
    scan: DocumentScan | None = None,
) -> DocumentScanPage:
    scan = scan or get_scan(db, household_id, scan_id)
    page = next((entry for entry in scan.pages if entry.id == page_id), None)
    if page is None:
        raise ApiError(404, "scan_page_not_found", "Scan page not found.")
    return page


def update_page(
    db: Session,
    household_id: uuid.UUID,
    scan_id: uuid.UUID,
    page_id: uuid.UUID,
    payload: DocumentScanPageUpdate,
) -> DocumentScanPage:
    scan = get_scan(db, household_id, scan_id, for_update=True)
    _ensure_draft(scan)
    page = get_page(db, household_id, scan_id, page_id, scan=scan)
    current = _adjustments_for(page).model_dump(mode="json")
    current.update(payload.model_dump(mode="json", exclude_unset=True, exclude_none=True))
    try:
        adjustments = ScanAdjustments.model_validate(current)
    except ValidationError as exc:
        raise ApiError(422, "invalid_scan_adjustments", str(exc.errors()[0]["msg"])) from exc
    image = render_cleaned_image(storage.resolve_key(page.original_storage_key), adjustments)
    try:
        cleaned_key, cleaned_type, cleaned_size, width, height = storage.save_scan_cleaned(
            household_id, scan_id, page.id, image
        )
    finally:
        image.close()
    previous_key = page.cleaned_storage_key
    page.cleaned_storage_key = cleaned_key
    page.cleaned_content_type = cleaned_type
    page.cleaned_byte_size = cleaned_size
    page.width = width
    page.height = height
    page.adjustments = adjustments.model_dump(mode="json")
    if "corners" in payload.model_fields_set:
        page.detection_status = "manual"
    _touch(scan)
    try:
        db.commit()
    except Exception:
        db.rollback()
        storage.delete_key(cleaned_key)
        raise
    storage.delete_key(previous_key)
    db.refresh(page)
    return page


def delete_page(
    db: Session,
    household_id: uuid.UUID,
    scan_id: uuid.UUID,
    page_id: uuid.UUID,
) -> None:
    scan = get_scan(db, household_id, scan_id, for_update=True)
    _ensure_draft(scan)
    _ensure_new_scan(scan)
    page = get_page(db, household_id, scan_id, page_id, scan=scan)
    keys = [page.original_storage_key, page.cleaned_storage_key]
    scan.pages.remove(page)
    for index, remaining in enumerate(sorted(scan.pages, key=lambda entry: entry.page_index)):
        remaining.page_index = index
    _touch(scan)
    db.commit()
    for key in keys:
        storage.delete_key(key)


def reorder_pages(
    db: Session,
    household_id: uuid.UUID,
    scan_id: uuid.UUID,
    page_ids: list[uuid.UUID],
) -> DocumentScan:
    scan = get_scan(db, household_id, scan_id, for_update=True)
    _ensure_draft(scan)
    _ensure_new_scan(scan)
    by_id = {page.id: page for page in scan.pages}
    if len(page_ids) != len(by_id) or set(page_ids) != set(by_id):
        raise ApiError(
            422,
            "scan_page_order",
            "The page order must include every current page exactly once.",
        )
    for index, page_id in enumerate(page_ids):
        by_id[page_id].page_index = index
    _touch(scan)
    db.commit()
    return get_scan(db, household_id, scan_id)


def cancel_scan(
    db: Session,
    household_id: uuid.UUID,
    scan_id: uuid.UUID,
) -> None:
    scan = get_scan(db, household_id, scan_id, for_update=True)
    _ensure_draft(scan)
    keys = [
        key for page in scan.pages for key in (page.original_storage_key, page.cleaned_storage_key)
    ]
    db.delete(scan)
    db.commit()
    for key in keys:
        storage.delete_key(key)


def _clean_title(payload: DocumentScanCommit, scan: DocumentScan) -> str:
    title = (payload.title or "").strip()
    if title:
        return title[:200]
    first = sorted(scan.pages, key=lambda page: page.page_index)[0]
    stem = first.original_filename.rsplit(".", 1)[0].strip()
    return (stem or "Scanned document")[:200]


def commit_scan(
    db: Session,
    household_id: uuid.UUID,
    scan_id: uuid.UUID,
    payload: DocumentScanCommit,
    *,
    actor_user_id: uuid.UUID | None,
    actor_name: str | None,
) -> Document:
    scan = get_scan(db, household_id, scan_id, for_update=True)
    if scan.status == "committed":
        committed_id = scan.target_document_id or scan.document_id
        if scan.request_id == payload.request_id and committed_id is not None:
            return get_document(db, household_id, committed_id)
        raise ApiError(409, "scan_committed", "This scan has already been saved.")
    existing = db.scalar(
        select(DocumentScan).where(
            DocumentScan.household_id == household_id,
            DocumentScan.request_id == payload.request_id,
            DocumentScan.id != scan.id,
        )
    )
    if existing is not None:
        raise ApiError(
            409,
            "request_id_reused",
            "That request id was used for another scan.",
        )
    if not scan.pages:
        raise ApiError(422, "scan_empty", "Add at least one page before saving.")
    if len(scan.pages) > SCAN_MAX_PAGES:
        raise ApiError(409, "scan_page_limit", "This scan contains too many pages.")

    if scan.target_document_id is not None:
        return _commit_cleanup(db, household_id, scan, payload)

    items = resolve_document_items(db, household_id, payload.item_ids)
    title = _clean_title(payload, scan)
    document_id = uuid.uuid4()
    cleaned_key: str | None = None
    original_key: str | None = None
    try:
        cleaned_pdf = _pdf_bytes(
            [
                storage.resolve_key(page.cleaned_storage_key)
                for page in sorted(scan.pages, key=lambda entry: entry.page_index)
            ],
            title,
        )
        original_pdf = _pdf_bytes(
            [
                storage.resolve_key(page.original_storage_key)
                for page in sorted(scan.pages, key=lambda entry: entry.page_index)
            ],
            title,
        )
        cleaned_key, cleaned_size = storage.write_document_pdf(
            household_id, document_id, cleaned_pdf
        )
        original_key, original_size = storage.write_document_pdf(
            household_id, document_id, original_pdf, original=True
        )
        document = Document(
            id=document_id,
            household_id=household_id,
            storage_key=cleaned_key,
            original_storage_key=original_key,
            content_sha256=hashlib.sha256(cleaned_pdf).hexdigest(),
            original_filename=storage.safe_document_filename(title),
            content_type="application/pdf",
            original_content_type="application/pdf",
            byte_size=cleaned_size,
            original_byte_size=original_size,
            title=title,
            document_type=payload.document_type.value,
            document_date=payload.document_date,
            merchant=payload.merchant,
            notes=payload.notes,
            extracted_metadata={
                "scan": {
                    "page_count": len(scan.pages),
                    "source": "scanner",
                }
            },
            ocr_status=OcrStatus.NOT_REQUESTED.value,
        )
        document.items = items
        db.add(document)
        db.flush()
        scan.document_id = document.id
        scan.status = "committed"
        scan.request_id = payload.request_id
        scan.created_by_user_id = actor_user_id
        scan.updated_at = datetime.now(UTC)
        enqueue_ocr(db, document, commit=False)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if cleaned_key:
            storage.delete_key(cleaned_key)
        if original_key:
            storage.delete_key(original_key)
        raise ApiError(
            409,
            "request_id_reused",
            "That request id was already used for another scan.",
        ) from exc
    except Exception:
        db.rollback()
        if cleaned_key:
            storage.delete_key(cleaned_key)
        if original_key:
            storage.delete_key(original_key)
        raise
    logger.info(
        "Committed scan %s as document %s (%s pages, actor=%s)",
        scan_id,
        document_id,
        len(scan.pages),
        actor_name or actor_user_id,
    )
    return get_document(db, household_id, document_id)


def _commit_cleanup(
    db: Session, household_id: uuid.UUID, scan: DocumentScan, payload: DocumentScanCommit
) -> Document:
    target_id = scan.target_document_id
    snapshot = db.get(Document, target_id)
    if snapshot is None or snapshot.household_id != household_id:
        raise ApiError(409, "cleanup_stale", "The source document is no longer available.")
    if snapshot.source_generation != scan.base_generation:
        raise ApiError(409, "cleanup_stale", "The document changed. Start cleanup again.")
    pages = sorted(scan.pages, key=lambda page: page.page_index)
    cleaned_key = None
    obsolete: list[str] = []
    try:
        pdf = _pdf_bytes(
            [storage.resolve_key(page.cleaned_storage_key) for page in pages], snapshot.title
        )
        cleaned_key, cleaned_size = storage.write_document_pdf(
            household_id, target_id, pdf, staged=True
        )
        # Rendering and staging never hold the source document lock.
        document = db.scalar(
            select(Document)
            .where(
                Document.id == target_id,
                Document.household_id == household_id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if document is None or document.source_generation != scan.base_generation:
            raise ApiError(409, "cleanup_stale", "The document changed. Start cleanup again.")
        committed = db.scalar(
            select(DocumentScan)
            .options(selectinload(DocumentScan.pages))
            .where(DocumentScan.document_id == target_id)
        )
        if committed is not None:
            canonical = sorted(committed.pages, key=lambda page: page.page_index)
            if [page.id for page in canonical] != [page.source_page_id for page in pages]:
                raise ApiError(409, "cleanup_stale", "The document pages changed.")
            for edited in pages:
                db.delete(edited)
            db.flush()
            for existing, edited in zip(canonical, pages, strict=True):
                obsolete.extend([existing.cleaned_storage_key, edited.original_storage_key])
                for field in (
                    "cleaned_storage_key",
                    "cleaned_content_type",
                    "cleaned_byte_size",
                    "width",
                    "height",
                    "adjustments",
                    "detection_status",
                ):
                    setattr(existing, field, getattr(edited, field))
        else:
            if len(pages) != 1 or pages[0].source_page_id is not None:
                raise ApiError(409, "cleanup_stale", "The document pages changed.")
            scan.document_id = document.id
        obsolete.append(document.storage_key)
        document.storage_key = cleaned_key
        document.content_type = "application/pdf"
        document.byte_size = cleaned_size
        document.content_sha256 = hashlib.sha256(pdf).hexdigest()
        document.source_generation += 1
        document.extracted_text = None
        document.ocr_confidence = None
        # Preserve reviewed history; all generation-derived proposals are invalid now.
        metadata = dict(document.extracted_metadata or {})
        document.extracted_metadata = {
            key: value
            for key, value in metadata.items()
            if key
            in {
                "applied",
                "applications",
                "review_history",
                "extraction_applied",
                "applied_at",
                "applied_item_ids",
            }
        }
        document.extracted_metadata = {
            **document.extracted_metadata,
            "scan": {"page_count": len(pages), "source": "scanner"},
        }
        scan.status = "committed"
        scan.request_id = payload.request_id
        _touch(scan)
        enqueue_ocr(db, document, commit=False)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if cleaned_key:
            storage.delete_key(cleaned_key)
        raise ApiError(
            409, "request_id_reused", "That request id was already used for another scan."
        ) from exc
    except Exception:
        db.rollback()
        if cleaned_key:
            storage.delete_key(cleaned_key)
        raise
    for key in obsolete:
        _delete_unreferenced_key(db, key)
    return get_document(db, household_id, target_id)


def _delete_unreferenced_key(db: Session, key: str) -> None:
    document_reference = db.scalar(
        select(Document.id)
        .where((Document.storage_key == key) | (Document.original_storage_key == key))
        .limit(1)
    )
    page_reference = db.scalar(
        select(DocumentScanPage.id)
        .where(
            (DocumentScanPage.original_storage_key == key)
            | (DocumentScanPage.cleaned_storage_key == key)
        )
        .limit(1)
    )
    if document_reference is None and page_reference is None:
        storage.delete_key(key)
