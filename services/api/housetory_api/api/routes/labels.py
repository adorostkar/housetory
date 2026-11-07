import re
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...db import get_db
from ...models import StorageLocation
from ...schemas.containers import (
    LabelCalibrationRequest,
    LabelPrintRequest,
    LabelTemplateList,
)
from ...services.labels import (
    build_calibration_pdf,
    build_labels_pdf,
    label_data,
    preset_models,
    resolve_geometry,
)
from ..deps import AuthContext, require_auth
from ..errors import ApiError

router = APIRouter(prefix="/labels", tags=["labels"])


def _ordered_locations(
    db: Session, household_id: uuid.UUID, location_ids: list[uuid.UUID]
) -> list[StorageLocation]:
    unique_ids = list(dict.fromkeys(location_ids))
    locations = list(
        db.scalars(
            select(StorageLocation).where(
                StorageLocation.household_id == household_id,
                StorageLocation.id.in_(unique_ids),
                StorageLocation.active(),
            )
        ).all()
    )
    by_id = {location.id: location for location in locations}
    missing = [str(location_id) for location_id in unique_ids if location_id not in by_id]
    if missing:
        raise ApiError(404, "container_not_found", "One of the selected containers was not found.")
    return [by_id[location_id] for location_id in unique_ids]


def _label_for_location(location: StorageLocation):
    """Labels intentionally contain only stable identity, name and live QR."""
    return label_data(
        identifier=location.identifier or location.name,
        name=location.name,
        location_id=str(location.id),
    )


def _render_labels(
    db: Session,
    household_id: uuid.UUID,
    payload: LabelPrintRequest,
    *,
    persist: bool,
) -> bytes:
    locations = _ordered_locations(db, household_id, payload.location_ids)
    try:
        resolve_geometry(payload.template, payload.custom)
    except ValueError as exc:
        raise ApiError(422, "invalid_label_geometry", str(exc)) from None
    labels = [_label_for_location(location) for location in locations]
    try:
        pdf = build_labels_pdf(
            labels,
            template=payload.template,
            layout=payload.layout,
            copies=payload.copies,
            start_slot=payload.start_slot,
            offset_x_mm=payload.offset_x_mm,
            offset_y_mm=payload.offset_y_mm,
            custom=payload.custom,
        )
    except ValueError as exc:
        raise ApiError(422, "invalid_label_layout", str(exc)) from None
    if persist:
        for location in locations:
            location.label_generated_at = func.now()
        db.commit()
    return pdf


@router.get("/templates", response_model=LabelTemplateList)
def label_templates(auth: AuthContext = Depends(require_auth)) -> LabelTemplateList:
    return LabelTemplateList(items=preset_models(), default="L7165")


@router.post("/pdf")
def labels_pdf(
    payload: LabelPrintRequest,
    auth: AuthContext = Depends(require_auth),
    db: Session = Depends(get_db),
) -> Response:
    try:
        pdf = _render_labels(
            db,
            auth.household.id,
            payload,
            persist=payload.record,
        )
    except Exception:
        db.rollback()
        raise
    filename = f"housetory-labels-{re.sub(r'[^A-Za-z0-9._-]+', '-', payload.template)}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/calibration.pdf")
def calibration_pdf(
    template: Annotated[str, Query(max_length=40)] = "L7165",
    offset_x_mm: Annotated[float, Query(ge=-15, le=15)] = 0,
    offset_y_mm: Annotated[float, Query(ge=-15, le=15)] = 0,
    start_slot: Annotated[int, Query(ge=0, le=999)] = 0,
    auth: AuthContext = Depends(require_auth),
) -> Response:
    try:
        pdf = build_calibration_pdf(
            template=template,
            offset_x_mm=offset_x_mm,
            offset_y_mm=offset_y_mm,
            start_slot=start_slot,
        )
    except ValueError as exc:
        raise ApiError(422, "invalid_label_geometry", str(exc)) from None
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="housetory-calibration-{template}.pdf"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/calibration.pdf")
def custom_calibration_pdf(
    payload: LabelCalibrationRequest,
    auth: AuthContext = Depends(require_auth),
) -> Response:
    try:
        pdf = build_calibration_pdf(
            template=payload.template,
            offset_x_mm=payload.offset_x_mm,
            offset_y_mm=payload.offset_y_mm,
            custom=payload.custom,
            start_slot=payload.start_slot,
        )
    except ValueError as exc:
        raise ApiError(422, "invalid_label_geometry", str(exc)) from None
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'attachment; filename="housetory-calibration.pdf"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
