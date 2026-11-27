"""One walk through the rule for kept review drafts that two devices can change.

Each kind of review row (import row, document line, document header, inventory
suggestion) gives two small functions and gets the same checks.
"""

DEVICE_A = "device-a-0123456789"
DEVICE_B = "device-b-0123456789"
# The device of a test that is not about two devices.
TEST_WRITER = "tests-device-0123456789"


def named(expected, writer):
    """The two fields every draft request needs. ``None`` leaves one out."""
    fields = {"expected_revision": expected, "writer": writer}
    return {key: value for key, value in fields.items() if value is not None}


def put_draft(client, url, **kwargs):
    """``client.put`` for a test that is not about revisions.

    A request that keeps a draft must say which revision it was made on and which
    device sends it. This fills both in: the test device, on the revision the row has.
    Any other request goes through as it is.
    """
    body = kwargs.get("json")
    if not url.endswith("/draft") or (isinstance(body, dict) and "expected_revision" in body):
        return client.put(url, **kwargs)
    sent = body if isinstance(body, dict) else {}
    filled = {"writer": TEST_WRITER, **sent, "expected_revision": 0}
    response = client.put(url, **{**kwargs, "json": filled})
    if response.status_code == 409 and response.json()["detail"].get("code") == "draft_conflict":
        filled["expected_revision"] = response.json()["detail"]["revision"]
        response = client.put(url, **{**kwargs, "json": filled})
    return response


def check_draft_revision_rule(put, read):
    """``put(text, expected, writer)`` sends a draft, or takes it back with ``text=None``.

    ``read()`` gives ``(revision, text)`` as a reload of the review shows the row.
    """

    def conflict(response, revision, text):
        assert response.status_code == 409, response.text
        detail = response.json()["detail"]
        assert detail["code"] == "draft_conflict"
        # The answer says what the server keeps, and nothing was stored.
        assert detail["revision"] == revision
        assert isinstance(detail["current"], dict)
        assert read() == (revision, text)

    def stored(response, revision, text):
        assert response.status_code == 200, response.text
        assert read() == (revision, text)

    start, _ = read()

    # Two devices read the same row. B saves first. A's save was made on the older
    # row: it is refused, and B's correction is intact.
    stored(put("from B", start, DEVICE_B), start + 1, "from B")
    conflict(put("from A", start, DEVICE_A), start + 1, "from B")
    # A person chose "Use mine": the draft is sent on the revision the server has.
    stored(put("from A", start + 1, DEVICE_A), start + 2, "from A")

    # A lost answer: A's save above arrived, but A never heard of it, so A still
    # thinks the row is at the older revision. A's newer draft goes on top.
    stored(put("from A, newer", start + 1, DEVICE_A), start + 3, "from A, newer")
    # The same request sent again after it arrived: fine, and no new revision. This
    # is also so for a device that did not write it.
    stored(put("from A, newer", start + 1, DEVICE_A), start + 3, "from A, newer")
    stored(put("from A, newer", start, DEVICE_B), start + 3, "from A, newer")

    # B corrects the row after A's save whose answer was lost. An older copy that A
    # still has must not go over it.
    stored(put("from B again", start + 3, DEVICE_B), start + 4, "from B again")
    conflict(put("from A, old copy", start + 1, DEVICE_A), start + 4, "from B again")

    # Taking the draft back follows the same rule, and the revision stays, so that
    # an older copy is still seen as older afterwards.
    conflict(put(None, start + 1, DEVICE_A), start + 4, "from B again")
    stored(put(None, start + 4, DEVICE_A), start + 5, None)
    stored(put(None, start, DEVICE_B), start + 5, None)
    conflict(put("from B, late", start + 4, DEVICE_B), start + 5, None)

    # A device id is short plain text, and a revision is a whole number from 0.
    # Both must be named: a draft without them is never stored.
    for expected, writer in (
        (start + 5, "no"),
        (start + 5, "x" * 65),
        (-1, DEVICE_A),
        (None, DEVICE_A),
        (start + 5, None),
        (None, None),
    ):
        assert put("bad", expected, writer).status_code == 422, (expected, writer)
    assert read() == (start + 5, None)
