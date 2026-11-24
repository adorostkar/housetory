"""The assistant reads a real scanned manual, with real page rendering and OCR.

Skipped unless ``HOUSETORY_MANUAL_PDF`` points to ``ASIM6K0R-EN-v2.pdf`` (the AstroAI
multimeter manual: 25 scanned pages, "Measuring Current" on page 11). Needs Poppler and
Tesseract. No AI provider is called: the model is scripted and may only use what the
tools returned to it.

    HOUSETORY_MANUAL_PDF=/path/ASIM6K0R-EN-v2.pdf pytest tests/test_real_manual.py -s

OCR output differs between Tesseract versions and language sets: spaces, quotation marks
and bullets change, and the dial symbols (µA, mA, A) come out as letters such as "pas"
or "mas". So the checks compare key words in their order and ignore spacing and
punctuation. They still check what matters: which lead goes to which terminal, the
units and limits, and the safety steps.
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
from housetory_api.services.assistant_tools import manual_tools
from housetory_api.services.document_ocr import run_document_ocr
from housetory_api.services.document_pages import MAP_SYSTEM, READ_TASK
from tests.test_assistant_manuals import converse
from tests.test_assistant_tools import call
from tests.test_document_pages import upload

MANUAL = os.environ.get("HOUSETORY_MANUAL_PDF")
pytestmark = pytest.mark.skipif(
    not (MANUAL and Path(MANUAL).is_file()), reason="HOUSETORY_MANUAL_PDF is not set"
)
TITLE = "ASIM6K0R-EN-v2"
HEADING = re.compile(r"^(Measuring [A-Z][A-Za-z/ ]+|[A-Z][A-Z ]{7,}|[A-Z][a-z]+ Notes)$")


def squash(text: str) -> str:
    """Letters and digits only, in lower case: what OCR versions agree on."""
    return re.sub(r"[^a-z0-9]", "", text.lower())


def says(text: str, *words: str, gap: int = 30) -> bool:
    """True when the words stand in the text in this order, at most ``gap`` letters apart.

    The gap leaves room for a misread word between two key words, and is too short to
    join words from different sentences.
    """
    pattern = f".{{0,{gap}}}".join(re.escape(squash(word)) for word in words)
    return re.search(pattern, squash(text)) is not None


def heading_of(line: str) -> str | None:
    """The line as a heading, without the stray marks OCR leaves around it."""
    title = line.strip(" \t.,:;*+-_'\"|")
    return title if HEADING.match(title) else None


def scripted_map(system, prompt, **kwargs):
    """Stands in for the AI provider: lists the heading lines it sees on each page."""
    assert system == MAP_SYSTEM
    sections, topics = [], []
    for block in prompt.split("[page ")[1:]:
        number, _, text = block.partition("]\n")
        for line in text.splitlines():
            title = heading_of(line)
            if title:
                sections.append(
                    {"title": title, "first_page": int(number), "last_page": int(number)}
                )
                also = {"Measuring Current": " (amps, amperage)", "Measuring Voltage": " (volts)"}
                topics.append(
                    {"topic": title.lower() + also.get(title, ""), "pages": [int(number)]}
                )
    return {"sections": sections, "topics": topics}


def section_under(page, heading):
    """The lines printed under a heading on a page, up to the next heading."""
    lines = page["text"].splitlines()
    start = next(i for i, line in enumerate(lines) if heading_of(line) == heading) + 1
    found = []
    for line in lines[start:]:
        if heading_of(line):
            break
        found.append(line)
    return found


def page_under(prompt, heading):
    """The page, among those the model was given, that has the heading with text below it."""
    for step in reversed(prompt["observations"]):
        for page in step["result"].get("facts", {}).get("pages", []):
            lines = page["text"].splitlines()
            if any(heading_of(line) == heading for line in lines[:-1]):
                return page
    raise AssertionError(f"no page with the heading {heading!r} was given to the model")


def test_the_scanned_multimeter_manual_answers_current_and_voltage_questions(
    owner_client, configured_ai, monkeypatch
):
    client = owner_client
    others = {MAP_SYSTEM: scripted_map}
    # No model reads pictures in this test, so the application does not look at pages.
    monkeypatch.setattr(manual_tools, "can_look", lambda db, household_id: False)
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
        page = page_under(prompt, "Measuring Current")
        # Real OCR is unsure about words on this page: the dial symbols and the socket
        # label are among them. The assistant is told so, with the words.
        assert page["ocr_unsure_words"], page
        assert "OCR was unsure about some words" in prompt["observations"][-1]["result"]["summary"]
        steps = section_under(page, "Measuring Current")
        return {
            "kind": "answer",
            "message": f"{' '.join(steps)} ({TITLE}, page {page['page']})",
            "sources": [
                {
                    "document_id": page["document_id"],
                    "pages": [page["page"]],
                    # The quote is copied from the page as it was read, like a model would.
                    "quote": next(line for line in steps if says(line, "in series")),
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
    answer = current["answer"]
    for words in (
        ("turn the rotary switch",),
        # Which lead goes where: red to the 10 A terminal, black to COM.
        ("red test lead", "10 A", "terminal"),
        ("black test lead", "COM", "terminal"),
        # The safety order: power off, meter in series, power on again.
        ("disconnect the power supply", "circuit"),
        ("connect", "meter", "in series", "circuit"),
        ("turn on", "power supply"),
        ("reading", "displayed", "LCD"),
    ):
        assert says(answer, *words), (words, answer)
    assert answer.endswith(f"({TITLE}, page 11)")
    (citation,) = current["citations"]
    assert citation == {
        "document_id": document["id"],
        "document_title": TITLE,
        "page": 11,
        "section": None,
        "excerpt": citation["excerpt"],
        "url": f"/documents/{document['id']}/view?page=11",
    }
    # The quoted words stand on page 11 of the file as it was read.
    assert says(citation["excerpt"], "meter", "in series")

    with SessionLocal() as db:
        rows = {
            row.page_number: row
            for row in db.scalars(
                select(DocumentPageText).where(DocumentPageText.document_id == document_id)
            )
        }
    assert sorted(rows) == list(range(1, 26))
    assert {row.source for row in rows.values()} == {"ocr"}
    assert says(rows[11].text, "Measuring Current", "1", "turn the rotary switch", gap=5)
    assert says(rows[10].text, "Measuring Voltage", "1", "insert the red test lead", gap=5)
    # Table rows of the OCR output (ten or more numbers in a row) used to leak into the
    # text after a quotation mark.
    assert not any(re.search(r"\t|(\d+ ){10}", row.text) for row in rows.values())
    section = {entry["title"]: entry["pages"] for entry in reread["facts"]["map"][0]["sections"]}
    assert section["Measuring Current"] == "11" and section["Measuring Voltage"] == "10"

    def read_from_the_map(prompt):
        facts = prompt["context_newest_first"][0]["observations"][-1]["result"]["facts"]
        assert "pages" not in facts and facts["pages_read_in_this_step"] == {TITLE: "1-25"}
        topic = next(t for t in facts["map"][0]["topics"] if "(volts)" in t["topic"])
        return call("read_manual", document_id=facts["map"][0]["document_id"], pages=topic["pages"])

    def answer_about_voltage(prompt):
        page = page_under(prompt, "Measuring Voltage")
        steps = " ".join(section_under(page, "Measuring Voltage"))
        return {
            "kind": "answer",
            "message": f"{steps} ({TITLE}, page {page['page']})",
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
    for words in (
        ("insert the red test lead", "terminal"),
        ("black test lead", "COM", "terminal"),
        ("turn the rotary switch", "setting"),
        # Below 600 mV the mV setting is used. OCR reads the unit as "mV" or "mY".
        ("voltage is below 600 m",),
        ("FUNC", "switch between AC/DC voltage"),
        ("in parallel with the circuit",),
    ):
        assert says(voltage["answer"], *words), (words, voltage["answer"])
    assert [c["url"] for c in voltage["citations"]] == [f"/documents/{document['id']}/view?page=10"]

    def read_what_the_search_found(prompt):
        matches = prompt["observations"][0]["result"]["facts"]["matches"]
        pages = ",".join(str(match["page"]) for match in matches[:4])
        return call("read_manual", document_id=matches[0]["document_id"], pages=pages)

    def answer_about_limits(prompt):
        page = page_under(prompt, "Voltage Notes")
        notes = " ".join(section_under(page, "Voltage Notes"))
        return {
            "kind": "answer",
            "message": f"{notes} ({TITLE}, page {page['page']})",
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
    for words in (
        ("do not measure voltages exceeding", "600 V DC", "600 V AC"),
        ("orange backlight", "voltage is higher than 80 V"),
    ):
        assert says(limits["answer"], *words), (words, limits["answer"])
    assert [c["page"] for c in limits["citations"]] == [11]

    with SessionLocal() as db:
        assert db.scalar(select(ImportBatch.id).limit(1)) is None
    sizes = {number: len(rows[number].text) for number in sorted(rows)}
    print(
        f"\nfirst pass: {len(early)} pages in {first_pass:.1f}s; "
        f"remaining {25 - len(early)} pages read and mapped in {reading:.1f}s"
        f"\ncharacters per page: {sizes}"
        f"\nall pages: {sum(sizes.values())} characters; prompt with the whole manual: "
        f"{prompts[-1]['chars']} characters; follow-up prompt: {voltage_prompts[-1]['chars']}"
        f"\ncurrent: {current['answer']}\nvoltage: {voltage['answer']}\nlimit: {limits['answer']}"
    )
