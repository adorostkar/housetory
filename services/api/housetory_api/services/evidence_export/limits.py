"""Evidence export size and time limits."""

from __future__ import annotations

import time


class EvidenceExportTooLarge(RuntimeError):
    pass


class EvidenceExportTimeout(RuntimeError):
    pass


def _check_deadline(deadline: float | None) -> None:
    if deadline is not None and time.monotonic() > deadline:
        raise EvidenceExportTimeout("The evidence package exceeded its generation deadline.")
