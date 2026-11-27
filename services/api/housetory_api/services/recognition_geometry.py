"""Positions of recognised things on the photo.

The vision model may give a box for a thing. A box is kept only when it passes every
check here. Nothing is repaired, moved, spread out or guessed: a box that fails is
dropped and that finding has no position. No position is a normal, honest state.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from ..models import AiRecognition
from ..schemas.imports import SourceRegion
from . import storage

BOX_KEYS = ("x_min", "y_min", "x_max", "y_max")
# A value may miss the photo edge by this much and is then moved onto the edge.
EDGE_TOLERANCE = 0.01
# Each side of a box is at least this share of the photo side.
MIN_SIDE = 0.01
# With more than one finding, a box this large says nothing about where the thing is.
WHOLE_PHOTO_AREA = 0.9
# Two findings whose boxes overlap this much (intersection over union) share one box.
SAME_BOX_OVERLAP = 0.9
EXIF_ORIENTATION = 0x0112
SAME_GRID_FORMATS = {"JPEG", "PNG", "WEBP"}


def vision_image(recognition: AiRecognition, original_path: Path) -> tuple[Path, str, bool]:
    """Choose the picture for the model. Say if its positions fit the shown photo.

    The review shows the stored copy: turned upright, same pixel size, HEIC as JPEG.
    The original is sent, as before, when it is the same view pixel for pixel. An
    original with an EXIF rotation or in HEIC is not: a provider may or may not turn
    it, so the upright stored copy is sent instead. If neither can be confirmed, the
    original is sent and every position of this photo is dropped.
    """
    shown_size = (recognition.width, recognition.height)
    try:
        with storage._open_image(original_path) as image:
            image_format = image.format
            size = image.size
            orientation = image.getexif().get(EXIF_ORIENTATION)
        if image_format in SAME_GRID_FORMATS and orientation not in range(2, 9):
            return original_path, recognition.original_content_type, size == shown_size
        shown_path = storage.resolve_key(recognition.storage_key)
        with storage._open_image(shown_path) as image:
            if image.size == shown_size:
                return shown_path, recognition.content_type, True
    except Exception:  # noqa: BLE001 - an unreadable picture only costs the positions
        pass
    return original_path, recognition.original_content_type, False


def take_model_boxes(raw: Any) -> list[Any]:
    """Remove the position keys from the raw model output. Return the boxes in order."""
    suggestions = raw.get("suggestions") if isinstance(raw, dict) else None
    if not isinstance(suggestions, list):
        return []
    boxes: list[Any] = []
    for suggestion in suggestions:
        if isinstance(suggestion, dict):
            boxes.append(suggestion.pop("box", None))
            # Only the server sets this field.
            suggestion.pop("source_region", None)
        else:
            boxes.append(None)
    return boxes


def _corners(box: Any) -> tuple[float, float, float, float] | None:
    if not isinstance(box, dict):
        return None
    values: list[float] = []
    for key in BOX_KEYS:
        value = box.get(key)
        if isinstance(value, bool) or not isinstance(value, int | float):
            return None
        try:
            value = float(value)
        except OverflowError:  # an integer too large for a float
            return None
        # Values above 1 are not converted. They may be pixels of a copy the provider
        # scaled down, or a 0-1000 scale; these cannot be told apart from the answer.
        if not math.isfinite(value) or not -EDGE_TOLERANCE <= value <= 1 + EDGE_TOLERANCE:
            return None
        values.append(min(1.0, max(0.0, value)))
    x_min, y_min, x_max, y_max = values
    if x_max - x_min < MIN_SIDE or y_max - y_min < MIN_SIDE:
        return None
    return x_min, y_min, x_max, y_max


def _area(box: tuple[float, ...]) -> float:
    return (box[2] - box[0]) * (box[3] - box[1])


def _overlap(first: tuple[float, ...], second: tuple[float, ...]) -> float:
    width = min(first[2], second[2]) - max(first[0], second[0])
    height = min(first[3], second[3]) - max(first[1], second[1])
    if width <= 0 or height <= 0:
        return 0.0
    shared = width * height
    return shared / (_area(first) + _area(second) - shared)


def _span(start: float, end: float) -> float:
    """Rounded length from start to end that never reaches past the photo edge."""
    length = round(end - start, 4)
    while start + length > 1:
        length = round(length - 0.0001, 4)
    return length


def checked_regions(boxes: list[Any], *, findings: int) -> list[SourceRegion | None]:
    """Turn the model's boxes for one photo into regions, or None where a box fails."""
    corners = [_corners(box) for box in boxes]
    if findings > 1:
        corners = [
            None if box is not None and _area(box) >= WHOLE_PHOTO_AREA else box for box in corners
        ]
    # One box given to several findings cannot say where any of them is. This also
    # drops the whole photo when every finding got the same box.
    shared = {
        index
        for index, box in enumerate(corners)
        if box is not None
        and any(
            other is not None and other_index != index and _overlap(box, other) >= SAME_BOX_OVERLAP
            for other_index, other in enumerate(corners)
        )
    }
    kept = [box is not None and index not in shared for index, box in enumerate(corners)]
    given = sum(box is not None for box in boxes)
    # A model whose boxes mostly fail does not know where things are. The few that
    # pass are then not trusted either. A box left out is not a failure.
    if given - sum(kept) > given / 2:
        return [None] * len(boxes)
    regions: list[SourceRegion | None] = []
    for index, box in enumerate(corners):
        if not kept[index]:
            regions.append(None)
            continue
        x, y = round(box[0], 4), round(box[1], 4)
        regions.append(SourceRegion(x=x, y=y, width=_span(x, box[2]), height=_span(y, box[3])))
    return regions


def stored_region(value: Any) -> SourceRegion | None:
    """Read a region back from stored JSON. Anything that is not a valid region is None."""
    if not isinstance(value, dict):
        return None
    try:
        return SourceRegion.model_validate(value)
    except ValueError:
        return None


__all__ = ["checked_regions", "stored_region", "take_model_boxes", "vision_image"]
