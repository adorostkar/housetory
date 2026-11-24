"""The assistant reads a real scanned manual, with real page rendering and OCR.

Skipped unless ``HOUSETORY_MANUAL_PDF`` points to ``ASIM6K0R-EN-v2.pdf`` (the AstroAI
multimeter manual: 25 scanned pages, "Measuring Current" on page 11). Needs Poppler and
Tesseract. No AI provider is called: the model is scripted and may only use what the
tools returned to it.

    HOUSETORY_MANUAL_PDF=/path/ASIM6K0R-EN-v2.pdf pytest tests/test_real_manual.py -s
"""

import os
import re
import time
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select

from housetory_api.db import SessionLocal
from housetory_api.models import Document, DocumentPageText, ImportBatch, Job
from housetory_api.services.document_ocr import run_document_ocr
from housetory_api.services.document_pages import MAP_SYSTEM, READ_TASK
from tests.test_assistant_manuals import converse, page_with
from tests.test_assistant_tools import call
from tests.test_document_pages import upload

MANUAL = os.environ.get("HOUSETORY_MANUAL_PDF")
pytestmark = pytest.mark.skipif(
    not (MANUAL and Path(MANUAL).is_file()), reason="HOUSETORY_MANUAL_PDF is not set"
)
TITLE = "ASIM6K0R-EN-v2"
HEADING = re.compile(r"^(Measuring [A-Z][A-Za-z/ ]+|[A-Z][A-Z ]{7,}|[A-Z][a-z]+ Notes)$")


def scripted_map(system, prompt, **kwargs):
    """Stands in for the AI provider: lists the heading lines it sees on each page."""
    assert system == MAP_SYSTEM
    sections, topics = [], []
    for block in prompt.split("[page ")[1:]:
        number, _, text = block.partition("]\n")
        for line in text.splitlines():
            if HEADING.match(line.strip()):
                title = line.strip()
                sections.append(
                    {"title": title, "first_page": int(number), "last_page": int(number)}
                )
                also = {"Measuring Current": " (amps, amperage)", "Measuring Voltage": " (volts)"}
                topics.append(
                    {"topic": title.lower() + also.get(title, ""), "pages": [int(number)]}
                )
    return {"sections": sections, "topics": topics}


def steps_under(page, heading):
    """The numbered steps printed under a heading on a page."""
    lines = page["text"].splitlines()
    start = lines.index(heading) + 1
    found = []
    for line in lines[start:]:
        if HEADING.match(line.strip()):
            break
        found.append(line)
    return " ".join(found)


def test_the_scanned_multimeter_manual_answers_current_and_voltage_questions(
    owner_client, configured_ai, monkeypatch
):
    client = owner_client
    others = {MAP_SYSTEM: scripted_map}
    item = client.post(
        "/api/v1/items", json={"name": "Multimeter", "brand": "AstroAI", "model": "M6K0R"}
    ).json()["item"]
    document = upload(client, Path(MANUAL).read_bytes(), title=TITLE, item_ids=[item["id"]])
    document_id = uuid.UUID(document["id"])

    # The document as earlier versions left it: only the first pages are read.
    started = time.monotonic()
    run_document_ocr(document_id)
    first_pass = time.monotonic() - started
    with SessionLocal() as db:
        stored = db.get(Document, document_id)
        early = (stored.extracted_metadata or {}).get("ocr_pages") or []
        assert 0 < len(early) < 11 and "Measuring Current" not in (stored.extracted_text or "")
        for job in db.scalars(select(Job).where(Job.task == READ_TASK)):
            db.delete(job)
        db.commit()

    def process_when_incomplete(prompt):
        result = prompt["observations"][-1]["result"]
        assert f"INCOMPLETE: only {len(early)} of 25 pages" in result["summary"]
        # The answer is not in what was read so far, so the rest is asked for.
        assert all("Measuring Current" not in page["text"] for page in result["facts"]["pages"])
        return call("process_manual", item_id=item["id"])

    def answer_about_current(prompt):
        page = page_with(prompt, "Measuring Current\n1.")
        return {
            "kind": "answer",
            "message": f"{steps_under(page, 'Measuring Current')} ({TITLE}, page {page['page']})",
            "sources": [
                {
                    "document_id": page["document_id"],
                    "pages": [page["page"]],
                    "quote": "Connect the meter in series to the circuit being tested",
                }
            ],
        }

    started = time.monotonic()
    current, prompts = converse(
        client,
        monkeypatch,
        "How do I check the amp with the multimeter?",
        [
            call("search_items", q="multimeter"),
            lambda prompt: call(
                "read_manual", item_id=prompt["observations"][0]["result"]["references"][0]["id"]
            ),
            process_when_incomplete,
            answer_about_current,
        ],
        others=others,
    )
    reading = time.monotonic() - started
    assert current["state"] == "completed", current
    reread = current["steps"][-1]["result"]
    assert reread["manuals"][0]["pages_read"] == 25 and "INCOMPLETE" not in reread["summary"]
    assert "the complete text (25 pages)" in reread["summary"]
    for words in (
        "Turn the rotary switch to the",
        'connect the red test lead to the "10 A',
        'black test lead to the "COM" terminal',
        "Disconnect the power supply of the circuit being tested",
        "Connect the meter in series to the circuit being tested",
        "(ASIM6K0R-EN-v2, page 11)",
    ):
        assert words in " ".join(current["answer"].split()), words
    assert current["citations"] == [
        {
            "document_id": document["id"],
            "document_title": TITLE,
            "page": 11,
            "section": None,
            "excerpt": "Connect the meter in series to the circuit being tested",
            "url": f"/documents/{document['id']}/view?page=11",
        }
    ]

    with SessionLocal() as db:
        rows = {
            row.page_number: row
            for row in db.scalars(
                select(DocumentPageText).where(DocumentPageText.document_id == document_id)
            )
        }
    assert sorted(rows) == list(range(1, 26))
    assert {row.source for row in rows.values()} == {"ocr"}
    assert "Measuring Current\n1. Turn the rotary switch" in rows[11].text
    assert "Measuring Voltage\n1. Insert the red test lead" in rows[10].text
    # Table rows of the OCR output used to leak into the text after a quotation mark.
    assert not any(re.search(r"\t|(\d+ ){6,}", row.text) for row in rows.values())
    section = {entry["title"]: entry["pages"] for entry in reread["facts"]["map"][0]["sections"]}
    assert section["Measuring Current"] == "11" and section["Measuring Voltage"] == "10"

    def read_from_the_map(prompt):
        facts = prompt["context_newest_first"][0]["observations"][-1]["result"]["facts"]
        assert "pages" not in facts and facts["pages_read_in_this_step"] == {TITLE: "1-25"}
        topic = next(t for t in facts["map"][0]["topics"] if "(volts)" in t["topic"])
        return call("read_manual", document_id=facts["map"][0]["document_id"], pages=topic["pages"])

    def answer_about_voltage(prompt):
        page = page_with(prompt, "Measuring Voltage\n1.")
        return {
            "kind": "answer",
            "message": f"{steps_under(page, 'Measuring Voltage')} ({TITLE}, page {page['page']})",
            "sources": [{"document_id": page["document_id"], "pages": [page["page"]]}],
        }

    voltage, voltage_prompts = converse(
        client,
        monkeypatch,
        "And how do I measure voltage with it?",
        [read_from_the_map, answer_about_voltage],
        others=others,
        parent_id=current["id"],
    )
    assert [page["page"] for page in voltage["steps"][0]["result"]["facts"]["pages"]] == [10]
    assert 'black test lead into the "COM" terminal' in " ".join(voltage["answer"].split())
    assert "in parallel with the circuit" in voltage["answer"]
    assert [c["url"] for c in voltage["citations"]] == [f"/documents/{document['id']}/view?page=10"]

    def read_what_the_search_found(prompt):
        matches = prompt["observations"][0]["result"]["facts"]["matches"]
        pages = ",".join(str(match["page"]) for match in matches[:4])
        return call("read_manual", document_id=matches[0]["document_id"], pages=pages)

    def answer_about_limits(prompt):
        page = page_with(prompt, "do not measure voltages exceeding")
        line = next(line for line in page["text"].split("+") if "exceeding" in line)
        return {
            "kind": "answer",
            "message": f"{' '.join(line.split())} ({TITLE}, page {page['page']})",
            "sources": [{"document_id": page["document_id"], "pages": [page["page"]]}],
        }

    limits, _ = converse(
        client,
        monkeypatch,
        "What is the highest voltage I may measure?",
        [
            call("search_manual", document_id=document["id"], query="voltage exceeding measure"),
            read_what_the_search_found,
            answer_about_limits,
        ],
        others=others,
        parent_id=voltage["id"],
    )
    assert "600 V DC or 600 V AC" in limits["answer"]
    assert [c["page"] for c in limits["citations"]] == [11]

    with SessionLocal() as db:
        assert db.scalar(select(ImportBatch.id).limit(1)) is None
    sizes = {number: len(row.text) for number, row in rows.items()}
    print(
        f"\nfirst pass: {len(early)} pages in {first_pass:.1f}s; "
        f"remaining {25 - len(early)} pages read and mapped in {reading:.1f}s"
        f"\ncharacters per page: {sizes}"
        f"\nall pages: {sum(sizes.values())} characters; prompt with the whole manual: "
        f"{prompts[-1]['chars']} characters; follow-up prompt: {voltage_prompts[-1]['chars']}"
        f"\ncurrent: {current['answer']}\nvoltage: {voltage['answer']}\nlimit: {limits['answer']}"
    )
