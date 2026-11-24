"""Page-level reading of documents and the cached map."""

import io
import uuid

import pytest
from sqlalchemy import select

from housetory_api.db import SessionLocal
from housetory_api.models import Document, DocumentPageText, DocumentReading, Job
from housetory_api.services import ai, document_pages, ocr
from housetory_api.services.document_ocr import run_document_ocr
from housetory_api.services.document_pages import MAP_TASK, READ_TASK, Page


def pdf_bytes(pages: list[str | None]) -> bytes:
    """A small PDF. A page given as text has a text layer; ``None`` is a page without
    one, like a scanned page."""
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [{}] /Count {} >>".format(
            " ".join(f"{4 + index * 2} 0 R" for index in range(len(pages))), len(pages)
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for index, text in enumerate(pages):
        lines = " ".join(
            "({}) Tj T*".format(line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)"))
            for line in (text or "").splitlines()
        )
        content = f"BT /F1 12 Tf 16 TL 72 720 Td {lines} ET" if text else ""
        objects.append(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {5 + index * 2} 0 R >>"
        )
        objects.append(f"<< /Length {len(content)} >>\nstream\n{content}\nendstream")
    body = "%PDF-1.4\n"
    offsets = []
    for number, entry in enumerate(objects, start=1):
        offsets.append(len(body))
        body += f"{number} 0 obj\n{entry}\nendobj\n"
    xref = len(body)
    body += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    body += "".join(f"{offset:010d} 00000 n \n" for offset in offsets)
    body += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    return body.encode("latin-1")


def upload(client, content: bytes, *, title="Manual", document_type="manual", item_ids=None):
    data = {"title": title, "document_type": document_type}
    if item_ids:
        data["item_ids"] = item_ids
    response = client.post(
        "/api/v1/documents",
        files={"file": (f"{title}.pdf", io.BytesIO(content), "application/pdf")},
        data=data,
    )
    assert response.status_code == 201, response.text
    return response.json()


def run_document_jobs() -> list[str]:
    """Run queued page-reading and map jobs the way the worker does, until none is left."""
    ran = []
    while True:
        with SessionLocal() as db:
            job = db.scalars(
                select(Job)
                .where(Job.task.in_([READ_TASK, MAP_TASK]), Job.status == "queued")
                .order_by(Job.created_at)
            ).first()
            if job is None:
                return ran
            job.status = "running"
            job_id, task, payload = job.id, job.task, dict(job.payload)
            db.commit()
        try:
            handler = (
                document_pages.run_read_job if task == READ_TASK else document_pages.run_map_job
            )
            handler(payload)
            status = "succeeded"
        except Exception as exc:  # noqa: BLE001 - recorded like the worker records it
            status = f"failed: {exc}"
        with SessionLocal() as db:
            db.get(Job, job_id).status = status.split(":")[0]
            db.commit()
        ran.append(f"{task} {status}")


def fake_ocr(monkeypatch, *, unreadable: tuple[int, ...] = ()):
    """Stand in for Poppler and Tesseract: a page without text is "read" as a scan."""
    read = []

    def read_pdf_page(path, number, embedded=""):
        if ocr.has_text(embedded):
            return embedded, "pdf_text"
        read.append(number)
        if number in unreadable:
            raise ocr.OcrError("Tesseract failed: unreadable page")
        return f"SCANNED PAGE {number}\nText that only OCR can see on page {number}.", "ocr"

    monkeypatch.setattr(ocr, "read_pdf_page", read_pdf_page)
    return read


def stored(document_id: str) -> dict[int, tuple[str, str]]:
    with SessionLocal() as db:
        rows = db.scalars(
            select(DocumentPageText).where(DocumentPageText.document_id == uuid.UUID(document_id))
        ).all()
        return {row.page_number: (row.source, row.text) for row in rows}


def test_tesseract_words_that_start_with_a_quote_do_not_swallow_the_following_rows(monkeypatch):
    header = (
        "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num"
        "\tleft\ttop\twidth\theight\tconf\ttext"
    )
    rows = [
        (1, 1, 1, "black", 96.5),
        (1, 1, 2, "lead", 96.5),
        (1, 1, 3, "to", 96.5),
        (1, 1, 4, "the", 96.5),
        (1, 1, 5, '"COM', 96.5),
        (1, 2, 1, "terminal.", 96.5),
        (1, 2, 2, "the", 96.5),
        (1, 2, 3, '10A"', 96.5),
        (1, 2, 4, "jack", 96.5),
        # A dial symbol read as a nonsense word, twice, and a page number.
        (1, 3, 1, '"pas"', 12.0),
        (1, 3, 2, "or", 96.5),
        (1, 3, 3, '"pas"', 30.0),
        (1, 3, 4, "-11-", 8.0),
    ]
    tsv = "\n".join(
        [header]
        + [
            f"5\t1\t{b}\t1\t{line}\t{w}\t0\t0\t10\t10\t{conf}\t{text}"
            for b, line, w, text, conf in rows
        ]
    )

    class Completed:
        returncode = 0
        stdout = tsv.encode()
        stderr = b""

    monkeypatch.setattr(ocr, "_require_binary", lambda name: name)
    monkeypatch.setattr(ocr.subprocess, "run", lambda *args, **kwargs: Completed())
    result = ocr._run_tesseract_tsv("page.png")
    # Before the fix the quote opened a CSV field and the next rows became part of the word.
    assert result.text == 'black lead to the "COM\nterminal. the 10A" jack\n"pas" or "pas" -11-'
    assert result.confidence == 78
    # Words read with little confidence are reported once. A bare number is not a word.
    assert result.unsure == ('"pas"',)


def test_every_page_of_a_manual_is_read_in_batches_and_kept_with_the_document(
    owner_client, monkeypatch
):
    item_a = owner_client.post("/api/v1/items", json={"name": "Multimeter"}).json()["item"]
    item_b = owner_client.post("/api/v1/items", json={"name": "Spare multimeter"}).json()["item"]
    # Pages 1-2 have a text layer; pages 3-12 are scans. Page 11 holds the instructions.
    pages = ["COVER PAGE\nDigital multimeter user manual", "SAFETY\nRead before use and keep."]
    document = upload(
        owner_client, pdf_bytes(pages + [None] * 10), item_ids=[item_a["id"], item_b["id"]]
    )
    read = fake_ocr(monkeypatch, unreadable=(7,))
    monkeypatch.setattr(document_pages, "BATCH_OCR_PAGES", 4)

    # The first pass is the short one that receipts need. For this file it reads the text layer.
    run_document_ocr(uuid.UUID(document["id"]))
    assert stored(document["id"]) == {}
    with SessionLocal() as db:
        row = db.get(Document, uuid.UUID(document["id"]))
        assert [page.number for page in document_pages.pages(db, row)] == [1, 2]
        state = document_pages.progress(db, row)
        assert (state.total, state.read, state.reading, state.complete) == (12, 2, True, False)

    ran = run_document_jobs()
    # Ten scanned pages at four per job: three jobs, each queued by the one before.
    assert ran == [f"{READ_TASK} succeeded"] * 3
    assert read == list(range(3, 13))
    pages_now = stored(document["id"])
    assert sorted(pages_now) == list(range(1, 13))
    assert pages_now[1] == ("pdf_text", "COVER PAGE\nDigital multimeter user manual\n")
    assert pages_now[11] == ("ocr", "SCANNED PAGE 11\nText that only OCR can see on page 11.")
    # One page that cannot be read does not stop the others. It is kept as failed, not as read.
    assert pages_now[7] == ("unreadable", "")
    with SessionLocal() as db:
        row = db.get(Document, uuid.UUID(document["id"]))
        state = document_pages.progress(db, row)
        assert (state.total, state.processed, state.read) == (12, 12, 11)
        assert (state.reading, state.complete) == (False, True)
        assert [(page.number, page.attempts) for page in state.failed] == [(7, 1)]
        # The text belongs to the document: both items it is attached to use the same rows.
        assert {entry.id for entry in row.items} == {
            uuid.UUID(item_a["id"]),
            uuid.UUID(item_b["id"]),
        }
        # Nothing tries the failed page again by itself.
        assert document_pages.request_reading(db, row) is False
    assert run_document_jobs() == []


def test_a_failed_page_is_reported_and_tried_again_only_when_asked_and_not_forever(
    owner_client, monkeypatch
):
    client = owner_client
    document = upload(client, pdf_bytes(["FIRST PAGE\nThis page has a text layer.", *[None] * 5]))
    document_id = uuid.UUID(document["id"])
    text_url = f"/api/v1/documents/{document['id']}/text"

    def rows():
        with SessionLocal() as db:
            found = db.scalars(
                select(DocumentPageText).where(DocumentPageText.document_id == document_id)
            ).all()
            return {row.page_number: (row.source, row.attempts, row.error) for row in found}

    def ask_again():
        with SessionLocal() as db:
            return document_pages.request_reading(
                db, db.get(Document, document_id), retry_failed=True
            )

    fake_ocr(monkeypatch, unreadable=(3, 5))
    run_document_ocr(document_id)
    assert run_document_jobs() == [f"{READ_TASK} succeeded"]
    failure = "OcrError: Tesseract failed: unreadable page"
    assert rows() == {
        1: ("pdf_text", 1, None),
        2: ("ocr", 1, None),
        3: ("unreadable", 1, failure),
        4: ("ocr", 1, None),
        5: ("unreadable", 1, failure),
        6: ("ocr", 1, None),
    }
    # Every page was tried, but only four were read. The two are reported, not counted.
    progress = client.get(text_url).json()
    assert (progress["page_total"], progress["pages_read"]) == (6, 4)
    assert (progress["pages_failed"], progress["can_retry"]) == ([3, 5], True)
    assert progress["pages"][2] == {"page": 3, "text": "", "source": "unreadable", "error": failure}
    assert run_document_jobs() == []

    # Run OCR is an explicit request. It tries the failed pages once more, one per batch
    # here, and a page that fails again is not carried along to the next batch.
    read = fake_ocr(monkeypatch, unreadable=(3, 5))
    monkeypatch.setattr(document_pages, "BATCH_OCR_PAGES", 1)
    assert client.post(f"/api/v1/documents/{document['id']}/ocr").status_code == 200
    assert run_document_jobs() == [f"{READ_TASK} succeeded"] * 2
    assert read == [3, 5]
    assert {number: row[:2] for number, row in rows().items() if number in (3, 5)} == {
        3: ("unreadable", 2),
        5: ("unreadable", 2),
    }
    assert run_document_jobs() == []

    # Page 3 can be read now. Pages that were read before are not read again.
    read = fake_ocr(monkeypatch, unreadable=(5,))
    monkeypatch.setattr(document_pages, "BATCH_OCR_PAGES", 8)
    assert ask_again() is True
    assert run_document_jobs() == [f"{READ_TASK} succeeded"]
    assert read == [3, 5]
    assert rows()[3] == ("ocr", 3, None)
    assert rows()[5] == ("unreadable", 3, failure)
    assert {number: row[1] for number, row in rows().items() if number not in (3, 5)} == {
        1: 1,
        2: 1,
        4: 1,
        6: 1,
    }

    # Page 5 failed three times. It is not tried again, however often it is asked for.
    assert ask_again() is False
    assert client.post(f"/api/v1/documents/{document['id']}/ocr").status_code == 409
    assert run_document_jobs() == [] and read == [3, 5]
    progress = client.get(text_url).json()
    assert (progress["pages_read"], progress["pages_failed"]) == (5, [5])
    assert progress["can_retry"] is False
    with SessionLocal() as db:
        state = document_pages.progress(db, db.get(Document, document_id))
        assert (state.processed, state.read, state.complete, state.retryable) == (6, 5, True, [])


def test_page_text_is_dropped_when_the_file_is_replaced_and_survives_other_updates(
    owner_client, monkeypatch
):
    document = upload(owner_client, pdf_bytes([None, None, None]))
    fake_ocr(monkeypatch)
    run_document_ocr(
        uuid.UUID(document["id"]),
        extractor=lambda path, content_type: ocr.ExtractedText(
            text="first page", confidence=80, source="ocr", pages=(ocr.OcrPage(1, "first page"),)
        ),
        parser=lambda text: {},
    )
    run_document_jobs()
    assert sorted(stored(document["id"])) == [1, 2, 3]
    assert stored(document["id"])[1] == ("ocr", "first page")

    # Any other change to the document row leaves the page text alone.
    renamed = owner_client.patch(f"/api/v1/documents/{document['id']}", json={"title": "Renamed"})
    assert renamed.status_code == 200, renamed.text
    assert sorted(stored(document["id"])) == [1, 2, 3]

    with SessionLocal() as db:
        row = db.get(Document, uuid.UUID(document["id"]))
        stale_payload = document_pages._payload(row)
        row.source_generation += 1
        row.extracted_metadata = {**row.extracted_metadata, "ocr_pages": []}
        db.commit()
        # Text read from the earlier content no longer counts, and a job for it does nothing.
        assert document_pages.pages(db, row) == []
        assert document_pages.progress(db, row).read == 0
    assert document_pages.run_read_job(stale_payload)["reason"] == "stale_source"

    assert owner_client.delete(f"/api/v1/documents/{document['id']}").status_code == 204
    assert stored(document["id"]) == {}


def test_receipts_keep_the_short_first_reading_only(owner_client, monkeypatch):
    receipt = upload(
        owner_client,
        pdf_bytes(["RECEIPT\nTotal 10.00 EUR paid by card today"] * 8),
        document_type="receipt",
    )
    run_document_ocr(uuid.UUID(receipt["id"]))
    with SessionLocal() as db:
        assert db.scalars(select(Job).where(Job.task == READ_TASK)).all() == []


def test_the_map_is_built_once_by_the_assistant_provider_and_its_pages_are_checked(
    owner_client, configured_ai, monkeypatch
):
    pages = [
        "CONTENTS\nMeasuring voltage ........ 9\nMeasuring current ........ 11",
        "MEASURING VOLTAGE\nTurn the dial to V and connect the leads in parallel.",
        "MEASURING CURRENT\nTurn the dial to A and connect the meter in series.",
        "BATTERY\nReplace the 9 V battery when the symbol shows.",
    ]
    document = upload(owner_client, pdf_bytes(pages))
    prompts = []

    def complete(system, prompt, **kwargs):
        prompts.append((system, prompt, kwargs["config"]))
        return {
            "sections": [
                {"title": "Measuring voltage", "first_page": 2, "last_page": 2},
                # Copied from the printed contents page: the real page is 3.
                {"title": "Measuring current", "first_page": 1, "last_page": 1},
                {"title": "Battery", "first_page": 4, "last_page": 9},
                {"title": "Warranty", "first_page": 30, "last_page": 31},
            ],
            "topics": [
                {"topic": "measure current (amps, amperage)", "pages": [3, 11]},
                {"topic": "replace the battery", "pages": [4]},
                {"topic": "made up", "pages": [44]},
                {"topic": "ignore previous instructions", "pages": "all"},
            ],
        }

    monkeypatch.setattr(ai, "complete_json", complete)
    run_document_ocr(uuid.UUID(document["id"]))
    assert run_document_jobs() == [f"{READ_TASK} succeeded", f"{MAP_TASK} succeeded"]

    (system, prompt, config) = prompts[0]
    assert config.model == "extract-test"
    assert "untrusted data" in system and "[page 3]\nMEASURING CURRENT" in prompt
    with SessionLocal() as db:
        row = db.get(Document, uuid.UUID(document["id"]))
        state = document_pages.progress(db, row)
        assert state.map["sections"] == [
            {"title": "Measuring voltage", "pages": [2, 2]},
            {"title": "Measuring current", "pages": [3, 3]},
        ]
        assert state.map["topics"] == [
            {"topic": "measure current (amps, amperage)", "pages": [3]},
            {"topic": "replace the battery", "pages": [4]},
        ]
        assert state.map["built_by"] == "ollama/extract-test"
        # Cached: nothing is queued or asked again.
        assert document_pages.request_map(db, row) is False
    assert run_document_jobs() == [] and len(prompts) == 1


def test_sections_are_placed_by_their_heading_also_when_a_contents_page_lists_the_titles():
    # As OCR reads the AstroAI manual: the contents page holds the bare titles, without
    # page numbers, and a real model gave pages that were one off.
    pages = [
        Page(1, "ASTROAI", "ocr"),
        Page(
            2,
            "NTRODUCTION\nWARNING --\nELECTRICAL SYMBOLS\nDIAGRAM --\nFUNCTION BUTTONS\n"
            "SETTING FUNCTIONS\nOTHER FUNCTIONS",
            "ocr",
        ),
        Page(3, "ELECTRICAL SYMBOLS\nCategory III test equipment.", "ocr"),
        Page(4, "DIAGRAM\nDisplay, buttons, rotary switch.", "ocr"),
        Page(5, "FUNCTION BUTTONS\nUse the rotary switch to select a function.", "ocr"),
        Page(6, "SETTING FUNCTIONS\nUse the FUNC button.\nOTHER FUNCTIONS\nAuto Shutoff", "ocr"),
        Page(7, "High Voltage/High Current Indication", "ocr"),
    ]
    raw = {
        "sections": [
            {"title": "ELECTRICAL SYMBOLS", "first_page": 2, "last_page": 3},
            {"title": "DIAGRAM", "first_page": 4, "last_page": 5},
            {"title": "OTHER FUNCTIONS", "first_page": 7, "last_page": 7},
            # Not a heading anywhere: the model's pages are kept.
            {"title": "Indications", "first_page": 7, "last_page": 7},
        ]
    }
    assert document_pages.checked_map(raw, pages)["sections"] == [
        {"title": "ELECTRICAL SYMBOLS", "pages": [3, 3]},
        {"title": "DIAGRAM", "pages": [4, 5]},
        {"title": "OTHER FUNCTIONS", "pages": [6, 7]},
        {"title": "Indications", "pages": [7, 7]},
    ]


def test_a_long_document_is_mapped_from_the_start_of_each_page_in_a_few_requests(monkeypatch):
    pages = [
        Page(number, f"HEADING {number}\n" + "word " * 1200, "pdf_text") for number in range(1, 201)
    ]
    requests = []

    def complete(system, prompt, **kwargs):
        requests.append(prompt)
        numbers = [int(value) for value in __import__("re").findall(r"\[page (\d+)\]", prompt)]
        return {
            "sections": [
                {
                    "title": f"Heading {numbers[0]}",
                    "first_page": numbers[0],
                    "last_page": numbers[-1],
                }
            ],
            "topics": [],
        }

    monkeypatch.setattr(ai, "complete_json", complete)

    class Config:
        provider, model = "ollama", "extract-test"

    data = document_pages.build_map(
        pages, [("Part one", 1), ("Part two", 90), ("Index", 180)], Config()
    )
    assert 1 < len(requests) <= document_pages.MAP_MAX_REQUESTS
    assert all(len(prompt) < document_pages.MAP_WINDOW_CHARS + 2_000 for prompt in requests)
    assert "Only the start of each page is given" in requests[0]
    assert "- Part two: page 90" in requests[0]
    # The file's own contents list is exact, so it gives the sections.
    assert data["from_contents_list"] is True and data["shortened_pages"] is True
    assert data["sections"] == [
        {"title": "Part one", "pages": [1, 89]},
        {"title": "Part two", "pages": [90, 179]},
        {"title": "Index", "pages": [180, 200]},
    ]


def test_without_ai_pages_are_still_read_and_no_map_is_asked_for(
    owner_client, anon_client, monkeypatch
):
    item = owner_client.post("/api/v1/items", json={"name": "Multimeter"}).json()["item"]
    document = upload(
        owner_client,
        pdf_bytes(["PAGE ONE\nSome text for the first page here.", None]),
        item_ids=[item["id"]],
    )
    fake_ocr(monkeypatch)
    monkeypatch.setattr(
        ai, "complete_json", lambda *args, **kwargs: pytest.fail("no AI request is expected")
    )
    run_document_ocr(uuid.UUID(document["id"]))
    progress = {
        "page_total": 2,
        "pages_read": 1,
        "pages_failed": [],
        "can_retry": False,
        "reading": True,
        "error": None,
    }
    manuals = owner_client.get(f"/api/v1/items/{item['id']}/manuals").json()
    assert manuals["reading"] == {document["id"]: progress}
    assert run_document_jobs() == [f"{READ_TASK} succeeded"]
    assert sorted(stored(document["id"])) == [1, 2]
    with SessionLocal() as db:
        assert db.get(DocumentReading, uuid.UUID(document["id"])).map is None
    # The file and the text of its pages stay available.
    assert owner_client.get(f"/api/v1/documents/{document['id']}/file").status_code == 200
    text = owner_client.get(f"/api/v1/documents/{document['id']}/text").json()
    assert text == {
        **progress,
        "pages_read": 2,
        "reading": False,
        "pages": [
            {
                "page": 1,
                "text": "PAGE ONE\nSome text for the first page here.\n",
                "source": "pdf_text",
                "error": None,
            },
            {
                "page": 2,
                "text": "SCANNED PAGE 2\nText that only OCR can see on page 2.",
                "source": "ocr",
                "error": None,
            },
        ],
    }
    from tests.test_cross_household import _other_household_headers

    other = _other_household_headers()["headers"]
    assert (
        anon_client.get(f"/api/v1/documents/{document['id']}/text", headers=other).status_code
        == 404
    )
