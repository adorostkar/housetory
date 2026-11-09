"""Standalone PDF rendering of an evidence snapshot."""

from __future__ import annotations

import io
import re
from collections import defaultdict
from typing import Any
from xml.sax.saxutils import escape

from PIL import Image as PilImage
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas as pdf_canvas
from reportlab.platypus import (
    Image as ReportlabImage,
)
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from ...config import get_settings
from .. import current_value as current_value_service
from .. import storage
from ..labels import FONT_BOLD, FONT_REGULAR, _register_fonts
from .limits import _check_deadline
from .snapshot import _clean_text, _snapshot_currency_total, _snapshot_current_value

CJK_FONT = "HeiseiKakuGo-W5"
HANGUL_FONT = "HYSMyeongJo-Medium"
CJK_PATTERN = re.compile(
    r"((?:[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)|"
    r"(?:[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]+))"
)


CSS_COLORS = {
    "ink": colors.HexColor("#1c241e"),
    "muted": colors.HexColor("#667064"),
    "line": colors.HexColor("#d8ded4"),
    "soft": colors.HexColor("#f0f4ee"),
    "brass": colors.HexColor("#8a6b2f"),
    "danger": colors.HexColor("#8d3c38"),
}


def _money(cents: int | None, currency: str | None) -> str:
    if cents is None:
        return "Not recorded"
    return f"{cents / 100:,.2f} {currency or ''}".strip()


def _rich_text(value: Any) -> str:
    cleaned = _clean_text(value, 20000)
    if not CJK_PATTERN.search(cleaned):
        return escape(cleaned)
    parts: list[str] = []
    cursor = 0
    for match in CJK_PATTERN.finditer(cleaned):
        if match.start() > cursor:
            parts.append(escape(cleaned[cursor : match.start()]))
        segment = match.group(0)
        font = (
            HANGUL_FONT
            if all("\uac00" <= char <= "\ud7af" or "\u1100" <= char <= "\u11ff" for char in segment)
            else CJK_FONT
        )
        parts.append(f'<font name="{font}">{escape(segment)}</font>')
        cursor = match.end()
    if cursor < len(cleaned):
        parts.append(escape(cleaned[cursor:]))
    return "".join(parts)


def _paragraph(text: Any, style: ParagraphStyle) -> Paragraph:
    return Paragraph(_rich_text(text), style)


def _build_styles() -> dict[str, ParagraphStyle]:
    _register_fonts()
    pdfmetrics.registerFont(UnicodeCIDFont(CJK_FONT))
    pdfmetrics.registerFont(UnicodeCIDFont(HANGUL_FONT))
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "EvidenceTitle",
            parent=base["Title"],
            fontName=FONT_BOLD,
            fontSize=25,
            leading=29,
            textColor=CSS_COLORS["ink"],
            spaceAfter=4,
        ),
        "subtitle": ParagraphStyle(
            "EvidenceSubtitle",
            parent=base["Normal"],
            fontName=FONT_REGULAR,
            fontSize=9.5,
            leading=14,
            textColor=CSS_COLORS["muted"],
        ),
        "h1": ParagraphStyle(
            "EvidenceH1",
            parent=base["Heading1"],
            fontName=FONT_BOLD,
            fontSize=15,
            leading=19,
            textColor=CSS_COLORS["ink"],
            spaceBefore=10,
            spaceAfter=7,
        ),
        "h2": ParagraphStyle(
            "EvidenceH2",
            parent=base["Heading2"],
            fontName=FONT_BOLD,
            fontSize=11,
            leading=15,
            textColor=CSS_COLORS["ink"],
            spaceBefore=8,
            spaceAfter=4,
        ),
        "body": ParagraphStyle(
            "EvidenceBody",
            parent=base["BodyText"],
            fontName=FONT_REGULAR,
            fontSize=8.6,
            leading=12.3,
            textColor=CSS_COLORS["ink"],
        ),
        "small": ParagraphStyle(
            "EvidenceSmall",
            parent=base["BodyText"],
            fontName=FONT_REGULAR,
            fontSize=7.2,
            leading=10,
            textColor=CSS_COLORS["muted"],
        ),
        "tiny": ParagraphStyle(
            "EvidenceTiny",
            parent=base["BodyText"],
            fontName=FONT_REGULAR,
            fontSize=6.4,
            leading=8.5,
            textColor=CSS_COLORS["muted"],
        ),
        "item": ParagraphStyle(
            "EvidenceItem",
            parent=base["Heading3"],
            fontName=FONT_BOLD,
            fontSize=10,
            leading=13,
            textColor=CSS_COLORS["ink"],
            spaceBefore=7,
            spaceAfter=2,
        ),
        "warning": ParagraphStyle(
            "EvidenceWarning",
            parent=base["BodyText"],
            fontName=FONT_REGULAR,
            fontSize=7.6,
            leading=10.5,
            textColor=CSS_COLORS["danger"],
        ),
    }


def _footer(canvas: pdf_canvas.Canvas, doc: Any) -> None:
    canvas.saveState()
    canvas.setStrokeColor(CSS_COLORS["line"])
    canvas.setLineWidth(0.4)
    canvas.line(16 * mm, 13 * mm, A4[0] - 16 * mm, 13 * mm)
    canvas.setFont(FONT_REGULAR, 6.7)
    canvas.setFillColor(CSS_COLORS["muted"])
    canvas.drawString(16 * mm, 8.5 * mm, "Housetory · recorded inventory, not physically verified")
    canvas.drawRightString(A4[0] - 16 * mm, 8.5 * mm, f"Page {doc.page}")
    canvas.restoreState()


def _table(
    data: list[list[Any]],
    widths: list[float],
    *,
    header: bool = True,
    small: bool = False,
    styles: dict[str, ParagraphStyle] | None = None,
) -> Table:
    styles = styles or _build_styles()
    cell_style = styles["tiny"] if small else styles["body"]
    prepared = [
        [
            _paragraph(cell, cell_style) if not isinstance(cell, ReportlabImage) else cell
            for cell in row
        ]
        for row in data
    ]
    table = Table(prepared, colWidths=widths, repeatRows=1 if header else 0)
    commands = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("GRID", (0, 0), (-1, -1), 0.35, CSS_COLORS["line"]),
    ]
    if header:
        commands.append(("BACKGROUND", (0, 0), (-1, 0), CSS_COLORS["soft"]))
    table.setStyle(TableStyle(commands))
    return table


def _photo_flowable(
    photo: dict[str, Any],
    *,
    max_width: float,
    max_height: float,
) -> tuple[ReportlabImage | None, str | None]:
    keys: list[str] = []
    for candidate in (photo.get("thumbnail_key"), photo.get("storage_key")):
        if candidate and str(candidate) not in keys:
            keys.append(str(candidate))
    for key in keys:
        try:
            path = storage.resolve_key(key)
            with PilImage.open(path) as image:
                image = image.convert("RGB")
                image.thumbnail((620, 620))
                width, height = image.size
                buffer = io.BytesIO()
                image.save(buffer, format="JPEG", quality=80, optimize=True)
                buffer.seek(0)
            scale = min(max_width / width, max_height / height, 1.0)
            buffer.seek(0)
            flowable = ReportlabImage(
                buffer,
                width=width * scale,
                height=height * scale,
            )
            return flowable, None
        except Exception:  # noqa: BLE001 - try the normalized copy next
            continue
    return None, f"Photo for {photo.get('item_name') or 'an item'} could not be read."


def _pdf_item_flowables(
    item: dict[str, Any],
    *,
    styles: dict[str, ParagraphStyle],
    photos: list[dict[str, Any]],
    photo_budget: list[int],
) -> list[Any]:
    lines: list[Any] = []
    archived = "  ·  Archived" if item.get("is_archived") else ""
    heading = (
        f"{item['name']}  ·  {item['quantity']} "
        f"unit{'s' if item['quantity'] != 1 else ''}{archived}"
    )
    lines.append(_paragraph(heading, styles["item"]))
    identity = " · ".join(
        part
        for part in (
            item.get("brand"),
            item.get("model"),
            f"Serial {item['serial_number']}" if item.get("serial_number") else None,
        )
        if part
    )
    detail_parts = [
        item.get("full_location_path") or "No location recorded",
        item.get("category") or "Uncategorised",
        item.get("condition") or "Unknown",
    ]
    if identity:
        detail_parts.insert(0, identity)
    lines.append(_paragraph(" · ".join(detail_parts), styles["small"]))
    if item.get("tags"):
        lines.append(_paragraph("Tags: " + ", ".join(item["tags"]), styles["tiny"]))
    if item.get("on_loan_quantity"):
        lines.append(
            _paragraph(
                f"Owned {item['quantity']} · at home {item['at_home_quantity']} · "
                f"recorded on loan {item['on_loan_quantity']}. Loaned units remain owned; "
                "the recorded home is a normal home, not a current physical location. "
                "Borrower names and loan notes are intentionally excluded.",
                styles["small"],
            )
        )
    purchase_text = f"Purchase information: {item.get('purchase_info_status') or 'unknown'}."
    purchase = item.get("purchase")
    if purchase:
        purchase_text = (
            f"Purchase total: {purchase.get('merchant') or 'merchant not recorded'} · "
            f"{purchase.get('purchase_date') or 'date not recorded'} · "
            f"{_money(purchase.get('total_cents'), purchase.get('currency'))} "
            "transaction total"
        )
        if purchase.get("has_unselected_items"):
            purchase_text += " (includes items outside this export)"
        elif purchase.get("item_count", 0) > 1:
            purchase_text += " (transaction total for all linked items)"
        if purchase.get("item_allocation_cents") is not None:
            allocation_text = _money(
                purchase["item_allocation_cents"],
                purchase.get("item_allocation_currency"),
            )
            purchase_text += f" · selected item allocation {allocation_text}"
        else:
            purchase_text += " · no reviewed per-item allocation"
        if purchase.get("unallocated_cents") is not None:
            purchase_text += (
                " · unallocated on this purchase "
                f"{_money(purchase['unallocated_cents'], purchase.get('currency'))}"
            )
    else:
        purchase_text += " No purchase record is linked."
    lines.append(_paragraph(purchase_text, styles["small"]))
    current = _snapshot_current_value(item)
    if current["total_cents"] is None:
        current_text = "Current value: not estimated (unknown, not zero)."
    elif current["basis"] == current_value_service.PER_UNIT:
        current_text = (
            "Estimated current value: "
            f"{_money(current['unit_cents'], current['currency'])} per unit x "
            f"{current['quantity']} owned unit"
            f"{'s' if current['quantity'] != 1 else ''} = "
            f"{_money(current['total_cents'], current['currency'])} total "
            "(household-supplied)."
        )
    else:
        current_text = (
            "Current value: legacy recorded total "
            f"{_money(current['total_cents'], current['currency'])} for "
            f"{current['quantity']} owned unit"
            f"{'s' if current['quantity'] != 1 else ''}; per-unit value was not "
            "recorded, so the total is reported once and not multiplied "
            "(household-supplied)."
        )
    if current.get("estimated_at"):
        current_text += f" Estimated {str(current['estimated_at'])[:10]}."
    lines.append(_paragraph(current_text, styles["small"]))
    estimate = item.get("current_value_estimate")
    if isinstance(estimate, dict) and current["basis"] == current_value_service.PER_UNIT:
        purpose = str(estimate.get("purpose") or "unknown").title()
        source = {
            "ai_web": "AI with public web search snippets",
            "ai": "AI without verified current comparisons",
            "manual": "manual household entry",
        }.get(str(estimate.get("source") or ""), "household estimate")
        estimate_bits = [
            f"{purpose} estimate ({source})",
            f"as of {estimate.get('as_of') or 'date not recorded'}",
        ]
        if estimate.get("confidence"):
            estimate_bits.append(f"{str(estimate['confidence']).title()} confidence")
        lines.append(_paragraph(" · ".join(estimate_bits) + ".", styles["small"]))
        low_cents = estimate.get("low_cents")
        high_cents = estimate.get("high_cents")
        if low_cents is not None and high_cents is not None:
            lines.append(
                _paragraph(
                    "Estimated per-unit range: "
                    f"{_money(low_cents, current['currency'])} – "
                    f"{_money(high_cents, current['currency'])}. "
                    "The applied per-unit estimate above is the reviewed value.",
                    styles["small"],
                )
            )
        if estimate.get("reasoning"):
            lines.append(_paragraph(str(estimate["reasoning"]), styles["tiny"]))
        assumptions = estimate.get("assumptions")
        if isinstance(assumptions, list) and assumptions:
            lines.append(
                _paragraph(
                    "Assumptions: " + " · ".join(str(value) for value in assumptions[:5]),
                    styles["tiny"],
                )
            )
        sources = estimate.get("sources")
        if isinstance(sources, list) and sources:
            for source_entry in sources[:5]:
                if not isinstance(source_entry, dict):
                    continue
                price = (
                    _money(source_entry.get("price_cents"), source_entry.get("currency"))
                    if source_entry.get("price_cents") is not None
                    else "price not extracted"
                )
                if source_entry.get("currency_inferred"):
                    price += " (currency inferred from symbol)"
                lines.append(
                    _paragraph(
                        "Supporting source (asking/listed search snippet, not a "
                        f"confirmed sold price): {source_entry.get('title') or 'untitled'}"
                        f" — {source_entry.get('url')} ({price}; retrieved "
                        f"{source_entry.get('retrieved_on') or 'date not recorded'}).",
                        styles["tiny"],
                    )
                )
        lines.append(
            _paragraph(
                "Estimate only; not a professional appraisal or guaranteed insurer "
                "payout. Verify the item, condition, model and local prices.",
                styles["tiny"],
            )
        )
    warranty = item.get("warranty")
    if warranty:
        lines.append(
            _paragraph(
                f"Warranty: {warranty.get('provider') or 'provider not recorded'} · "
                f"{warranty.get('status') or 'unknown'} · ends "
                f"{warranty.get('end_date') or 'not recorded'}",
                styles["small"],
            )
        )
    last_checked = item.get("last_checked")
    if last_checked:
        status = str(last_checked.get("status") or "checked").replace("_", " ")
        if last_checked.get("stale"):
            checked_text = (
                f"Last checked {str(last_checked.get('at'))[:10]} as {status}; "
                "the recorded item, quantity or location changed after that check."
            )
        else:
            checked_text = (
                f"Last checked {str(last_checked.get('at'))[:10]} · {status} · "
                f"{last_checked.get('quantity')} at home"
            )
            if last_checked.get("on_loan_quantity"):
                checked_text += f" · {last_checked['on_loan_quantity']} on loan (still owned)"
            if last_checked.get("location_path"):
                checked_text += f" · {last_checked['location_path']}"
        lines.append(_paragraph(checked_text, styles["small"]))
    if item.get("description"):
        lines.append(_paragraph(item["description"], styles["body"]))
    if item.get("document_refs"):
        lines.append(
            _paragraph(
                "Evidence references: " + ", ".join(item["document_refs"]),
                styles["small"],
            )
        )
    if photos:
        image_cells: list[Any] = []
        captions: list[str] = []
        for photo in photos:
            if photo_budget[0] <= 0:
                break
            flowable, warning = _photo_flowable(photo, max_width=52 * mm, max_height=39 * mm)
            if warning:
                lines.append(_paragraph(warning, styles["warning"]))
                continue
            if flowable is not None:
                image_cells.append(flowable)
                captions.append(photo.get("original_filename") or "Item photo")
                photo_budget[0] -= 1
        if image_cells:
            widths = [52 * mm] * len(image_cells)
            photo_table = Table(
                [image_cells, [_paragraph(c, styles["tiny"]) for c in captions]], colWidths=widths
            )
            photo_table.setStyle(
                TableStyle(
                    [
                        ("VALIGN", (0, 0), (-1, -1), "TOP"),
                        ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 0),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                        ("TOPPADDING", (0, 0), (-1, 0), 3),
                    ]
                )
            )
            lines.append(photo_table)
    lines.append(Spacer(1, 4))
    return lines


def build_pdf(
    snapshot: dict[str, Any],
    extra_warnings: list[str] | None = None,
    *,
    deadline: float | None = None,
) -> bytes:
    styles = _build_styles()
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=16 * mm,
        leftMargin=16 * mm,
        topMargin=15 * mm,
        bottomMargin=18 * mm,
        title=f"Inventory evidence package — {snapshot['household']['name']}",
        author="Housetory",
        subject="Recorded household inventory and supporting evidence",
        creator="Housetory inventory evidence package",
    )
    story: list[Any] = []
    story.append(_paragraph("Inventory evidence package", styles["title"]))
    story.append(
        _paragraph(
            f"{snapshot['household']['name']} · Prepared {snapshot['generated_at']} "
            f"· {snapshot['timezone']}",
            styles["subtitle"],
        )
    )
    story.append(
        _paragraph(
            f"Export {snapshot.get('export_id', 'pending generation')} · "
            f"Format {snapshot['format_version']} · Scope: {snapshot['scope_label']}",
            styles["small"],
        )
    )
    story.append(Spacer(1, 8))
    story.append(
        _paragraph(
            "This package records what is currently recorded in Housetory. It is not a "
            "physical stocktake, a professional appraisal, an insurance acceptance or a "
            "coverage guarantee. Missing information is marked rather than estimated. "
            "Values are separated by currency and are never converted.",
            styles["body"],
        )
    )
    story.append(Spacer(1, 8))
    counts = [
        ["Selected items", str(snapshot["item_count"]), "Total units", str(snapshot["unit_count"])],
        [
            "At-home units",
            str(snapshot["at_home_unit_count"]),
            "Recorded on loan",
            str(snapshot["on_loan_unit_count"]),
        ],
        [
            "Item photos",
            f"{snapshot['included_photo_count']} / {snapshot['photo_count']}",
            "Included documents",
            f"{snapshot['included_document_count']} / {snapshot['document_count']}",
        ],
        [
            "Archived excluded",
            str(snapshot["archived_excluded_count"]),
            "Missing purchase info",
            str(snapshot["missing_purchase_count"]),
        ],
    ]
    story.append(_table(counts, [42 * mm, 32 * mm, 42 * mm, 36 * mm], header=False))
    story.append(Spacer(1, 8))
    if snapshot["currency_totals"]:
        story.append(_paragraph("Recorded value summary", styles["h2"]))
        rows = [
            [
                "Currency",
                "Selected purchase allocations",
                "Current estimate totals",
                "Items with each figure",
            ]
        ]
        for entry in snapshot["currency_totals"]:
            total_entry = _snapshot_currency_total(entry)
            rows.append(
                [
                    entry["currency"],
                    _money(entry["selected_allocated_purchase_cents"], entry["currency"]),
                    _money(total_entry["current_value_total_cents"], entry["currency"]),
                    f"{entry['allocated_item_count']} allocation · "
                    f"{entry['current_value_item_count']} estimate",
                ]
            )
        story.append(_table(rows, [20 * mm, 44 * mm, 42 * mm, 40 * mm]))
        story.append(
            _paragraph(
                "Current estimate totals multiply each per-unit estimate by owned "
                "quantity. Loaned owned units remain included; borrowed items are "
                "excluded. Legacy record totals are included once and are not "
                "multiplied. The selected purchase allocation column sums only "
                "reviewed per-item allocations; shared purchase grand totals are "
                "listed separately below and are not assigned to every item.",
                styles["tiny"],
            )
        )
        story.append(Spacer(1, 6))
    if snapshot["purchase_references"]:
        story.append(_paragraph("Referenced purchase records", styles["h2"]))
        rows = [
            [
                "Merchant / date",
                "Purchase total",
                "Selected items",
                "Selected allocation",
                "Unallocated",
            ]
        ]
        for purchase in snapshot["purchase_references"]:
            rows.append(
                [
                    (
                        f"{purchase['merchant'] or 'Not recorded'}\n"
                        f"{purchase['purchase_date'] or 'Date not recorded'}"
                    ),
                    _money(purchase["total_cents"], purchase["currency"]),
                    f"{purchase['selected_item_count']} of {purchase['item_count_in_household']}",
                    _money(purchase["selected_allocated_cents"], purchase["currency"])
                    if purchase["has_allocations"]
                    else "Not allocated",
                    _money(purchase["unallocated_cents"], purchase["currency"])
                    if purchase["unallocated_cents"] is not None
                    else "Not available",
                ]
            )
        story.append(_table(rows, [50 * mm, 30 * mm, 27 * mm, 31 * mm, 30 * mm], small=True))
        story.append(
            _paragraph(
                "A shared purchase total appears once in this table, even when several "
                "selected items belong to it. It may include items outside this export. "
                "Legacy records without reviewed allocations are not split by the report.",
                styles["tiny"],
            )
        )
        story.append(Spacer(1, 6))
    if snapshot["warnings"] or extra_warnings:
        story.append(_paragraph("Review notes", styles["h2"]))
        for warning in [*snapshot["warnings"], *(extra_warnings or [])]:
            story.append(_paragraph("• " + warning, styles["warning"]))
        story.append(Spacer(1, 6))
    story.append(PageBreak())
    story.append(_paragraph("Inventory items", styles["h1"]))
    photos_by_item: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if snapshot["options"].get("include_photos", True):
        for photo in snapshot["photos"]:
            photos_by_item[photo["item_id"]].append(photo)
    photo_budget = [get_settings().evidence_export_max_pdf_photos]
    current_location = None
    for item in snapshot["items"]:
        _check_deadline(deadline)
        location = item["full_location_path"]
        if location != current_location:
            story.append(_paragraph(location, styles["h2"]))
            current_location = location
        story.extend(
            _pdf_item_flowables(
                item,
                styles=styles,
                photos=photos_by_item.get(item["id"], [])[:3],
                photo_budget=photo_budget,
            )
        )
    if snapshot["items"]:
        story.append(PageBreak())
    story.append(_paragraph("Evidence index", styles["h1"]))
    included_documents = [document for document in snapshot["documents"] if document["included"]]
    if not included_documents:
        story.append(
            _paragraph(
                "No supporting documents were included. Item photos, where present, are "
                "shown in the item entries above.",
                styles["body"],
            )
        )
    else:
        rows = [["Ref", "Evidence", "Source / date", "Bundle access / note"]]
        for document in included_documents:
            note = (
                "Included in the attachment bundle."
                if snapshot["options"].get("include_attachments")
                else "Listed for reference; no attachment ZIP was requested."
            )
            if document["shared_with_unselected"]:
                note += (
                    " This document is also linked to items outside the selection "
                    "and may contain other products or personal information."
                )
            rows.append(
                [
                    document.get("reference") or "—",
                    (
                        f"{document['title']}\n"
                        f"{document['evidence_kind'].title()} · "
                        f"{document['document_type'].replace('_', ' ').title()}"
                    ),
                    (
                        f"{document.get('merchant') or 'Source not recorded'}\n"
                        f"{document.get('document_date') or 'Date not recorded'}"
                    ),
                    note,
                ]
            )
        story.append(_table(rows, [16 * mm, 57 * mm, 38 * mm, 59 * mm], small=True))
    story.append(Spacer(1, 10))
    story.append(_paragraph("Package notes", styles["h2"]))
    notes = [
        "Only recorded facts were used. No missing price was replaced with zero and no "
        "missing date was invented.",
        "Purchase totals and current estimates are separate. Currencies are never added "
        "together or converted.",
        "Loaned units are still owned. Borrower names, loan notes, purchase notes and "
        "document notes are excluded from this package.",
        "Photos are the stored household photo derivatives; exact uploaded photo "
        "originals have already been normalized by Housetory.",
        "Original supporting document bytes are only claimed when the attachment bundle "
        "includes the original role. Normalized or cleaned scan PDFs are labelled as "
        "such in the bundle manifest.",
        "Per-item last-checked information comes from completed stocktakes and is shown "
        "only for exact recorded observations. A changed item is labelled rather than "
        "treated as still verified.",
        "This is supporting documentation, not an insurance policy, valuation, claim or "
        "guarantee of coverage.",
    ]
    for note in notes:
        story.append(_paragraph("• " + note, styles["small"]))
    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return buffer.getvalue()
