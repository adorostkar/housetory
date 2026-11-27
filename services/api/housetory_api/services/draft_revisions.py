"""One rule for keeping a correction of a review row from more than one device.

Each kept draft has a revision, a number that goes up by one each time the stored
draft changes, and a writer: the person and device that stored it. A row without a draft is at
revision 0. A device says which revision its correction was made on. The caller holds
the lock of the row while it asks ``decide`` and stores the draft, so two devices
cannot both win.

The revision and the writer are kept beside the draft. They are not part of what the
review reads as its source, and they are never copied to an item.
"""

from typing import Any, Literal

from fastapi import HTTPException

REVISION_KEY = "revision"
WRITER_KEY = "writer"


class DraftConflict(Exception):
    """Another device changed the kept draft of a row. Nothing was stored."""

    def __init__(self, revision: int) -> None:
        super().__init__("draft_conflict")
        self.revision = revision


def revision_of(meta: Any) -> int:
    value = meta.get(REVISION_KEY) if isinstance(meta, dict) else None
    return value if isinstance(value, int) and value > 0 else 0


def writer_of(meta: Any) -> str | None:
    value = meta.get(WRITER_KEY) if isinstance(meta, dict) else None
    return value if isinstance(value, str) and value else None


def decide(
    meta: Any, *, expected: int, writer: str, same: bool
) -> Literal["store", "same", "conflict"]:
    """What to do with a draft that arrives for a row whose kept draft has ``meta``.

    - It says what is stored already: nothing to do. A request that arrived before,
      and is sent again, ends here.
    - It was made on the revision that is stored: store it.
    - The stored draft is from the same device: that device saved it and never got
      the answer. Its newer draft goes on top: store it.
    - Otherwise another device changed the row in the meantime: a conflict. Nothing
      is stored.

    The writer names one person on one device. So a draft that another person kept
    on the same browser is not taken for this person's own.
    """
    if same:
        return "same"
    if expected == revision_of(meta) or writer == writer_of(meta):
        return "store"
    return "conflict"


def conflict(revision: int, current: dict[str, Any]) -> HTTPException:
    """409 with the draft the server keeps for the row, so that the page can show it."""
    return HTTPException(
        status_code=409,
        detail={
            "code": "draft_conflict",
            "message": "This row was also corrected on another device. Nothing was changed.",
            "revision": revision,
            "current": current,
        },
    )
