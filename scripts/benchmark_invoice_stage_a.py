"""Benchmark synthetic invoice files using the canonical offline document pipeline.

Run with the API environment; no database, provider or external network is used.
The fixture-generation time is deliberately excluded from processing timings.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import statistics
import tempfile
import time
import uuid
from pathlib import Path

from housetory_api.models import Document
from housetory_api.services.document_extraction import build_extraction
from housetory_api.services.ocr import extract_text, parse_receipt
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen.canvas import Canvas


def percentile(values: list[float], quantile: float) -> float:
    return sorted(values)[max(0, math.ceil(len(values) * quantile) - 1)]


def expectation_mismatches(fixture: dict, proposal: dict) -> list[str]:
    mismatches = []
    validation = proposal["financial_validation"]
    for field, expected in fixture["expected"].items():
        if field == "product_lines":
            actual = [
                {
                    key: line[key]
                    for key in (
                        "description",
                        "quantity",
                        "unit_price_cents",
                        "line_total_cents",
                    )
                }
                for line in proposal["lines"]
                if line["kind"] == "product"
            ]
        elif field == "attention_codes":
            if not set(expected).issubset(
                {check["code"] for check in validation["checks"]}
            ):
                mismatches.append("attention_codes")
            continue
        elif field == "tax_treatment":
            actual = validation["tax_treatment"]
        else:
            actual = proposal["fields"][field]
        if actual != expected:
            mismatches.append(field)
    if fixture["uncertain"] and validation["status"] == "consistent":
        mismatches.append("expected_uncertainty")
    if any(
        line["evidence"]["page"] is None
        for line in proposal["lines"]
        if line["kind"] == "product"
    ):
        mismatches.append("missing_page_evidence")
    return mismatches


def make_file(root: Path, text: str, kind: str, pages: int) -> tuple[Path, str]:
    lines = text.splitlines()
    # Keep document order, including continuation pages, rather than repeat an invoice.
    per_page = max(1, math.ceil(len(lines) / pages))
    chunks = [
        lines[index * per_page : (index + 1) * per_page] for index in range(pages)
    ]
    if kind == "embedded_pdf":
        path = root / "invoice.pdf"
        canvas = Canvas(str(path))
        for chunk in chunks:
            for index, line in enumerate(chunk):
                canvas.drawString(40, 800 - index * 22, line)
            canvas.showPage()
        canvas.save()
        return path, "application/pdf"
    images = []
    for chunk in chunks:
        image = Image.new("RGB", (1400, 1800), "white")
        ImageDraw.Draw(image).multiline_text(
            (60, 80),
            "\n".join(chunk),
            fill="black",
            font=ImageFont.load_default(size=38),
            spacing=16,
        )
        images.append(image)
    if kind == "image_pdf":
        path = root / "invoice-image.pdf"
        images[0].save(
            path, "PDF", save_all=True, append_images=images[1:], resolution=150
        )
        return path, "application/pdf"
    path = root / "invoice.png"
    images[0].save(path)
    return path, "image/png"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=3, choices=range(1, 21))
    args = parser.parse_args()
    os.environ.setdefault("OMP_THREAD_LIMIT", "1")
    fixtures = json.loads(args.fixtures.read_text())
    if isinstance(fixtures, dict):
        fixtures = fixtures["fixtures"]
    records = []
    with tempfile.TemporaryDirectory(prefix="stagea-invoice-benchmark-") as directory:
        root = Path(directory)
        for fixture in fixtures:
            for kind, pages in [
                ("embedded_pdf", 1),
                ("image_png", 1),
                ("image_pdf", 3),
            ]:
                path, content_type = make_file(root, fixture["text"], kind, pages)
                samples = []
                proposal = None
                for _ in range(args.samples):
                    started = time.perf_counter()
                    extracted = extract_text(path, content_type)
                    read_at = time.perf_counter()
                    metadata = parse_receipt(extracted.text)
                    metadata["ocr_pages"] = [
                        {"page": page.page_number, "text": page.text}
                        for page in extracted.pages
                    ]
                    document = Document(
                        id=uuid.uuid5(uuid.NAMESPACE_URL, fixture["name"] + kind),
                        household_id=uuid.UUID(int=1),
                        title=fixture["name"],
                        document_type="invoice",
                        original_filename=path.name,
                        content_type=content_type,
                        source_generation=1,
                        extracted_metadata={},
                    )
                    proposal = build_extraction(
                        document, extracted.text, metadata, source_artifact="original"
                    )
                    finished = time.perf_counter()
                    samples.append(
                        {
                            "read_ms": round((read_at - started) * 1000, 3),
                            "parse_validate_ms": round((finished - read_at) * 1000, 3),
                            "local_total_ms": round((finished - started) * 1000, 3),
                        }
                    )
                totals = [sample["local_total_ms"] for sample in samples]
                mismatches = expectation_mismatches(fixture, proposal)
                records.append(
                    {
                        "fixture": fixture["name"],
                        "format": kind,
                        "pages": pages,
                        "samples": samples,
                        "median_ms": round(statistics.median(totals), 3),
                        "p95_ms": round(percentile(totals, 0.95), 3),
                        "expectation_mismatches": mismatches,
                        "quality": (
                            "matches_expected"
                            if not mismatches
                            else "explicit_uncertainty"
                            if proposal["financial_validation"]["status"]
                            != "consistent"
                            else "incorrect_confident"
                        ),
                        "proposal": proposal,
                    }
                )
    print(
        json.dumps(
            {
                "environment": {
                    "python": platform.python_version(),
                    "platform": platform.platform(),
                    "provider": "none",
                    "model": None,
                    "database": "not used",
                    "samples_per_case": args.samples,
                    "upload_ms": None,
                    "queue_wait_ms": None,
                    "provider_ms": None,
                    "note": "Local processing only; not end-to-end/provider latency or quality.",
                },
                "records": records,
            },
            indent=2,
            default=str,
        )
    )

    if any(record["quality"] == "incorrect_confident" for record in records):
        raise SystemExit(
            "Incorrect confident extraction; inspect expectation_mismatches."
        )


if __name__ == "__main__":
    main()
