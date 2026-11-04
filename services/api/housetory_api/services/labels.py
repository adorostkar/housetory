"""Printable A4 label sheets with vector QR codes and embedded fonts.

Preset geometry is based on the manufacturer's published label dimensions and
the template measurements for A4 sheets. The PDF uses millimetres throughout,
so 100% printing produces physical labels at the stated size.
"""

import io
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import segno
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from ..config import get_settings
from ..schemas.containers import LabelGeometry, LabelPresetOut

FONT_DIR = Path(__file__).resolve().parent.parent / "assets" / "fonts"
FONT_REGULAR = "HousetorySans"
FONT_BOLD = "HousetorySansBold"
_fonts_registered = False

LAYOUTS = ("compact", "standard", "detailed")

PRESETS: dict[str, dict] = {
    "L7160": {
        "name": "Avery L7160",
        "description": "21 address labels, 63.5 × 38.1 mm",
        "manufacturer_code": "L7160",
        "default_layout": "compact",
        "label_width_mm": 63.5,
        "label_height_mm": 38.1,
        "columns": 3,
        "rows": 7,
        "top_margin_mm": 15.2,
        "left_margin_mm": 7.3,
        "horizontal_pitch_mm": 66.0,
        "vertical_pitch_mm": 38.1,
    },
    "L7163": {
        "name": "Avery L7163",
        "description": "14 parcel labels, 99.1 × 38.1 mm",
        "manufacturer_code": "L7163",
        "default_layout": "standard",
        "label_width_mm": 99.1,
        "label_height_mm": 38.1,
        "columns": 2,
        "rows": 7,
        "top_margin_mm": 15.2,
        "left_margin_mm": 4.7,
        "horizontal_pitch_mm": 101.6,
        "vertical_pitch_mm": 38.1,
    },
    "L7165": {
        "name": "Avery L7165",
        "description": "8 box labels, 99.1 × 67.7 mm",
        "manufacturer_code": "L7165",
        "default_layout": "standard",
        "label_width_mm": 99.1,
        "label_height_mm": 67.7,
        "columns": 2,
        "rows": 4,
        "top_margin_mm": 13.1,
        "left_margin_mm": 4.7,
        "horizontal_pitch_mm": 101.6,
        "vertical_pitch_mm": 67.7,
    },
    "L7651": {
        "name": "Avery L7651",
        "description": "65 mini labels, 38.1 × 21.2 mm",
        "manufacturer_code": "L7651",
        "default_layout": "compact",
        "label_width_mm": 38.1,
        "label_height_mm": 21.2,
        "columns": 5,
        "rows": 13,
        "top_margin_mm": 10.7,
        "left_margin_mm": 4.8,
        "horizontal_pitch_mm": 40.6,
        "vertical_pitch_mm": 21.2,
    },
    "LARGE_A6": {
        "name": "Large A6 labels",
        "description": "4 large labels, 105 × 148 mm",
        "manufacturer_code": None,
        "default_layout": "detailed",
        "label_width_mm": 105.0,
        "label_height_mm": 148.0,
        "columns": 2,
        "rows": 2,
        "top_margin_mm": 0.5,
        "left_margin_mm": 0.0,
        "horizontal_pitch_mm": 105.0,
        "vertical_pitch_mm": 148.0,
    },
}
DEFAULT_PRESET = "L7165"


def preset_models() -> list[LabelPresetOut]:
    return [
        LabelPresetOut(
            code=code,
            name=values["name"],
            description=values["description"],
            manufacturer_code=values["manufacturer_code"],
            default_layout=values["default_layout"],
            paper_width_mm=210.0,
            paper_height_mm=297.0,
            label_width_mm=values["label_width_mm"],
            label_height_mm=values["label_height_mm"],
            columns=values["columns"],
            rows=values["rows"],
            top_margin_mm=values["top_margin_mm"],
            left_margin_mm=values["left_margin_mm"],
            horizontal_pitch_mm=values["horizontal_pitch_mm"],
            vertical_pitch_mm=values["vertical_pitch_mm"],
        )
        for code, values in PRESETS.items()
    ]


def resolve_geometry(template: str, custom: LabelGeometry | None) -> LabelGeometry:
    if template == "custom":
        if custom is None:
            raise ValueError("Custom geometry is required for the custom template.")
        return custom
    preset = PRESETS.get(template)
    if preset is None:
        raise ValueError("Unknown label template.")
    return LabelGeometry(
        paper_width_mm=210.0,
        paper_height_mm=297.0,
        label_width_mm=preset["label_width_mm"],
        label_height_mm=preset["label_height_mm"],
        columns=preset["columns"],
        rows=preset["rows"],
        top_margin_mm=preset["top_margin_mm"],
        left_margin_mm=preset["left_margin_mm"],
        horizontal_pitch_mm=preset["horizontal_pitch_mm"],
        vertical_pitch_mm=preset["vertical_pitch_mm"],
    )


def qr_payload(location_id) -> str:  # noqa: ANN001
    return f"{get_settings().qr_effective_base_url}/containers/{location_id}"


def qr_image_bytes(payload: str, *, scale: int = 8, border: int = 4) -> bytes:
    buffer = io.BytesIO()
    segno.make(payload, error="m").save(
        buffer,
        kind="svg",
        scale=scale,
        border=border,
        dark="#152018",
        light="#ffffff",
        xmldecl=False,
        nl=False,
    )
    return buffer.getvalue()


def _register_fonts() -> None:
    global _fonts_registered
    if _fonts_registered:
        return
    pdfmetrics.registerFont(TTFont(FONT_REGULAR, FONT_DIR / "DejaVuSans.ttf"))
    pdfmetrics.registerFont(TTFont(FONT_BOLD, FONT_DIR / "DejaVuSans-Bold.ttf"))
    _fonts_registered = True


def _clean(text: str | None, limit: int = 4000) -> str:
    if not text:
        return ""
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", str(text))
    return re.sub(r"\s+", " ", cleaned).strip()[:limit]


def _wrap(
    text: str,
    *,
    font: str,
    size: float,
    max_width: float,
    max_lines: int,
) -> list[str]:
    text = _clean(text)
    if not text or max_lines <= 0 or max_width <= 0:
        return []
    words = text.split()
    lines: list[str] = []
    current = ""
    truncated = False
    for word in words:
        if len(lines) >= max_lines:
            truncated = True
            break
        candidate = f"{current} {word}".strip()
        if pdfmetrics.stringWidth(candidate, font, size) <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
            if len(lines) >= max_lines:
                truncated = True
                break
        current = word
        while pdfmetrics.stringWidth(current, font, size) > max_width and len(current) > 1:
            cut = len(current)
            while cut > 1 and pdfmetrics.stringWidth(current[:cut] + "…", font, size) > max_width:
                cut -= 1
            lines.append(current[:cut].rstrip() + "…")
            current = current[cut:].lstrip()
            if len(lines) >= max_lines:
                truncated = True
                break
        if truncated:
            break
    if not truncated and current:
        if len(lines) < max_lines:
            lines.append(current)
        else:
            truncated = True
    if truncated and lines:
        last = lines[-1].rstrip("…")
        while last and pdfmetrics.stringWidth(last + "…", font, size) > max_width:
            last = last[:-1]
        lines[-1] = (last + "…") if last else "…"
    return lines[:max_lines]


def _fit_font_size(
    text: str, *, font: str, max_size: float, min_size: float, max_width: float
) -> float:
    size = max_size
    while size > min_size and pdfmetrics.stringWidth(text, font, size) > max_width:
        size -= 0.15
    return max(min_size, size)


def _fit_single(text: str, *, font: str, size: float, max_width: float) -> str:
    text = _clean(text)
    if pdfmetrics.stringWidth(text, font, size) <= max_width:
        return text
    while text and pdfmetrics.stringWidth(text + "…", font, size) > max_width:
        text = text[:-1]
    return (text + "…") if text else ""


@dataclass(frozen=True)
class LabelData:
    identifier: str
    name: str
    headline: str | None
    short: str
    detailed: str
    location: str
    summary_date: str | None
    qr_payload: str


def label_positions(
    geometry: LabelGeometry,
    *,
    start_slot: int = 0,
    count: int = 1,
    offset_x_mm: float = 0,
    offset_y_mm: float = 0,
) -> list[tuple[int, float, float]]:
    """Return (slot, x_mm, y_mm) for the next labels on a sheet.

    x/y are the bottom-left corner in PDF coordinates. This helper is shared
    with tests so physical template geometry can be verified independently of
    the drawing code.
    """
    positions: list[tuple[int, float, float]] = []
    per_sheet = geometry.labels_per_sheet
    slot = start_slot
    for _ in range(count):
        if slot >= per_sheet:
            slot = 0
        column = slot % geometry.columns
        row = slot // geometry.columns
        x = geometry.left_margin_mm + column * geometry.horizontal_pitch_mm + offset_x_mm
        y = (
            geometry.paper_height_mm
            - geometry.top_margin_mm
            - row * geometry.vertical_pitch_mm
            - geometry.label_height_mm
            + offset_y_mm
        )
        positions.append((slot, x, y))
        slot += 1
    return positions


def _draw_qr(canvas_obj: canvas.Canvas, payload: str, x: float, y: float, size: float) -> None:
    qr = segno.make(payload, error="m")
    matrix = list(qr.matrix_iter(border=4))
    count = len(matrix)
    if count == 0:
        return
    module = size / count
    canvas_obj.setFillColor(colors.black)
    for row_index, row in enumerate(matrix):
        for column_index, value in enumerate(row):
            if value:
                canvas_obj.rect(
                    x + column_index * module,
                    y + (count - row_index - 1) * module,
                    module,
                    module,
                    stroke=0,
                    fill=1,
                )


def _draw_label(
    canvas_obj: canvas.Canvas,
    data: LabelData,
    geometry: LabelGeometry,
    layout: str,
    x: float,
    y: float,
) -> None:
    width = geometry.label_width_mm * mm
    height = geometry.label_height_mm * mm
    pad = min(4.2 * mm, width * 0.055, height * 0.06)
    canvas_obj.saveState()
    clip = canvas_obj.beginPath()
    clip.rect(x, y, width, height)
    canvas_obj.clipPath(clip, stroke=0, fill=0)

    canvas_obj.setFillColor(colors.black)
    if layout == "compact":
        qr_size = min(height - 2 * pad, width * 0.34, 14 * mm)
        qr_size = max(8 * mm, qr_size)
        qr_x = x + width - pad - qr_size
        qr_y = y + pad
        text_x = x + pad
        text_width = qr_x - text_x - pad * 0.5
        id_size = _fit_font_size(
            data.identifier,
            font=FONT_BOLD,
            max_size=min(8.5 * mm, height * 0.36),
            min_size=4.0 * mm,
            max_width=text_width,
        )
        canvas_obj.setFont(FONT_BOLD, id_size)
        canvas_obj.drawString(
            text_x,
            y + height - pad - id_size,
            _fit_single(data.identifier, font=FONT_BOLD, size=id_size, max_width=text_width),
        )
        cursor = y + height - pad - id_size - id_size * 0.55
        if data.name and data.name != data.identifier:
            name_size = min(5.4 * mm, id_size * 0.62)
            line = _fit_single(data.name, font=FONT_REGULAR, size=name_size, max_width=text_width)
            if line:
                canvas_obj.setFont(FONT_REGULAR, name_size)
                canvas_obj.drawString(text_x, cursor, line)
                cursor -= name_size * 1.3
        summary_size = max(4.2 * mm, min(5.2 * mm, id_size * 0.58))
        lines = _wrap(
            data.headline or data.short,
            font=FONT_REGULAR,
            size=summary_size,
            max_width=text_width,
            max_lines=2,
        )
        for line in lines:
            if cursor - summary_size < y + pad:
                break
            canvas_obj.setFont(FONT_REGULAR, summary_size)
            canvas_obj.drawString(text_x, cursor, line)
            cursor -= summary_size * 1.25
        _draw_qr(canvas_obj, data.qr_payload, qr_x, qr_y, qr_size)
        canvas_obj.restoreState()
        return

    qr_size = min(
        height * (0.50 if layout == "standard" else 0.44),
        width * 0.34,
        32 * mm,
    )
    qr_size = max(14 * mm, qr_size)
    qr_x = x + width - pad - qr_size
    qr_y = y + height - pad - qr_size
    text_x = x + pad
    text_width = qr_x - text_x - pad * 0.7
    id_size = _fit_font_size(
        data.identifier,
        font=FONT_BOLD,
        max_size=min(13 * mm, (height if layout == "standard" else height * 0.9) * 0.22),
        min_size=5.2 * mm,
        max_width=text_width,
    )
    canvas_obj.setFont(FONT_BOLD, id_size)
    canvas_obj.drawString(
        text_x,
        y + height - pad - id_size,
        _fit_single(data.identifier, font=FONT_BOLD, size=id_size, max_width=text_width),
    )
    cursor = y + height - pad - id_size - id_size * 0.55

    if data.name and data.name != data.identifier:
        name_size = min(7.2 * mm, id_size * 0.55)
        name_line = _fit_single(data.name, font=FONT_REGULAR, size=name_size, max_width=text_width)
        if name_line:
            canvas_obj.setFont(FONT_BOLD, name_size)
            canvas_obj.drawString(text_x, cursor, name_line)
            cursor -= name_size * 1.35
    if data.headline:
        headline_size = min(6.2 * mm, id_size * 0.48)
        for line in _wrap(
            data.headline,
            font=FONT_REGULAR,
            size=headline_size,
            max_width=text_width,
            max_lines=2,
        ):
            if cursor - headline_size < y + pad + 8 * mm:
                break
            canvas_obj.setFont(FONT_REGULAR, headline_size)
            canvas_obj.drawString(text_x, cursor, line)
            cursor -= headline_size * 1.25
        cursor -= 1.2 * mm

    summary_text = data.detailed if layout == "detailed" else data.short
    summary_size = min(6.0 * mm, id_size * 0.52)
    summary_size = max(4.3 * mm, summary_size)
    available_height = cursor - (y + pad + (7 * mm if layout != "compact" else 0))
    max_lines = max(1, int(available_height / (summary_size * 1.28)))
    summary_lines = _wrap(
        summary_text,
        font=FONT_REGULAR,
        size=summary_size,
        max_width=text_width,
        max_lines=min(max_lines, 14 if layout == "detailed" else 6),
    )
    for line in summary_lines:
        if cursor - summary_size < y + pad + 5 * mm:
            break
        canvas_obj.setFont(FONT_REGULAR, summary_size)
        canvas_obj.drawString(text_x, cursor, line)
        cursor -= summary_size * 1.28

    footer_size = max(3.8 * mm, min(4.8 * mm, id_size * 0.37))
    footer_y = y + pad
    if data.location:
        canvas_obj.setFont(FONT_REGULAR, footer_size)
        canvas_obj.drawString(
            text_x,
            footer_y,
            _fit_single(
                data.location,
                font=FONT_REGULAR,
                size=footer_size,
                max_width=width - 2 * pad - qr_size,
            ),
        )
    if data.summary_date and layout == "detailed":
        canvas_obj.setFont(FONT_REGULAR, footer_size)
        canvas_obj.drawRightString(
            x + width - pad,
            footer_y,
            _fit_single(data.summary_date, font=FONT_REGULAR, size=footer_size, max_width=qr_size),
        )
    _draw_qr(canvas_obj, data.qr_payload, qr_x, qr_y, qr_size)
    canvas_obj.restoreState()


def _draw_calibration_label(
    canvas_obj: canvas.Canvas,
    geometry: LabelGeometry,
    slot: int,
    x: float,
    y: float,
) -> None:
    width = geometry.label_width_mm * mm
    height = geometry.label_height_mm * mm
    pad = 2.2 * mm
    canvas_obj.saveState()
    canvas_obj.setStrokeColor(colors.HexColor("#59645a"))
    canvas_obj.setLineWidth(0.25)
    canvas_obj.rect(x, y, width, height, stroke=1, fill=0)
    canvas_obj.setDash(1, 2)
    canvas_obj.line(x, y, x + width, y + height)
    canvas_obj.line(x, y + height, x + width, y)
    canvas_obj.setDash()
    canvas_obj.setFont(FONT_BOLD, 8 * mm)
    canvas_obj.drawString(x + pad, y + height - pad - 8 * mm, f"#{slot + 1}")
    canvas_obj.setFont(FONT_REGULAR, 4.2 * mm)
    canvas_obj.drawString(
        x + pad,
        y + pad,
        "Calibration — print at 100% / Actual size",
    )
    canvas_obj.restoreState()


def build_labels_pdf(
    labels: list[LabelData],
    *,
    template: str,
    layout: str,
    copies: int,
    start_slot: int,
    offset_x_mm: float,
    offset_y_mm: float,
    custom: LabelGeometry | None = None,
) -> bytes:
    _register_fonts()
    geometry = resolve_geometry(template, custom)
    if layout not in LAYOUTS:
        raise ValueError("Unknown label layout.")
    per_sheet = geometry.labels_per_sheet
    if start_slot >= per_sheet:
        raise ValueError("The starting position is outside this label sheet.")
    expanded: list[LabelData] = []
    for label in labels:
        expanded.extend([label] * copies)
    if not expanded:
        raise ValueError("Choose at least one container or place to print.")

    buffer = io.BytesIO()
    page_width = geometry.paper_width_mm * mm
    page_height = geometry.paper_height_mm * mm
    pdf = canvas.Canvas(buffer, pagesize=(page_width, page_height), pageCompression=1)
    pdf.setTitle("Housetory labels")
    pdf.setAuthor("Housetory")
    slot = start_slot
    page_started = False
    for label in expanded:
        if not page_started:
            pdf.setFillColor(colors.black)
            page_started = True
        column = slot % geometry.columns
        row = slot // geometry.columns
        x = (geometry.left_margin_mm + column * geometry.horizontal_pitch_mm + offset_x_mm) * mm
        y = (
            geometry.paper_height_mm
            - geometry.top_margin_mm
            - row * geometry.vertical_pitch_mm
            - geometry.label_height_mm
            + offset_y_mm
        ) * mm
        _draw_label(pdf, label, geometry, layout, x, y)
        slot += 1
        if slot >= per_sheet:
            pdf.showPage()
            slot = 0
            page_started = False
    if page_started:
        pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def build_calibration_pdf(
    *,
    template: str,
    offset_x_mm: float,
    offset_y_mm: float,
    custom: LabelGeometry | None = None,
    start_slot: int = 0,
) -> bytes:
    _register_fonts()
    geometry = resolve_geometry(template, custom)
    per_sheet = geometry.labels_per_sheet
    if start_slot >= per_sheet:
        raise ValueError("The starting position is outside this label sheet.")
    buffer = io.BytesIO()
    page_width = geometry.paper_width_mm * mm
    page_height = geometry.paper_height_mm * mm
    pdf = canvas.Canvas(buffer, pagesize=(page_width, page_height), pageCompression=1)
    pdf.setTitle("Housetory label calibration")
    pdf.setFont(FONT_BOLD, 5 * mm)
    pdf.drawString(
        4.7 * mm,
        page_height - 6 * mm,
        (
            f"{template} calibration · offsets X {offset_x_mm:+.1f} mm / "
            f"Y {offset_y_mm:+.1f} mm · 100% / Actual size"
        ),
    )
    for slot in range(start_slot, per_sheet):
        column = slot % geometry.columns
        row = slot // geometry.columns
        x = (geometry.left_margin_mm + column * geometry.horizontal_pitch_mm + offset_x_mm) * mm
        y = (
            geometry.paper_height_mm
            - geometry.top_margin_mm
            - row * geometry.vertical_pitch_mm
            - geometry.label_height_mm
            + offset_y_mm
        ) * mm
        _draw_calibration_label(pdf, geometry, slot, x, y)
    pdf.save()
    return buffer.getvalue()


def label_data(
    *,
    identifier: str,
    name: str,
    headline: str | None,
    short: str,
    detailed: str,
    location: str,
    summary_date: date | None,
    location_id: str,
) -> LabelData:
    return LabelData(
        identifier=_clean(identifier, 40),
        name=_clean(name, 120),
        headline=_clean(headline, 240) or None,
        short=_clean(short, 1200),
        detailed=_clean(detailed, 2400),
        location=_clean(location, 300),
        summary_date=summary_date.isoformat() if summary_date else None,
        qr_payload=qr_payload(location_id),
    )
