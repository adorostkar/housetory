"""Deterministic hierarchy interpretation for Markdown and note imports.

This parser is intentionally conservative. It only switches a batch into tree
mode when it finds recognizable rooms or legacy container identifiers, so normal
Markdown collection notes keep the existing flat extraction behaviour.
"""

import re
from dataclasses import dataclass, field
from typing import Any

from ..domain import ImportEntityType
from .import_parse import (
    IGNORED_TYPES,
    ProposalDraft,
    _parse_detail_line,
    _remove_list_marker,
    parse_frontmatter,
)
from .import_types import ParsedDocument, SourceBundle

LEGACY_RE = re.compile(r"\b([A-Z]{2,8}(?:-[A-Z0-9]+)*-\d{1,4})\b")
QUANTITY_SUFFIX_RE = re.compile(
    r"^(?P<name>.+?)\s*[×x]\s*(?P<quantity>\d{1,5})(?P<rest>\s+.*)?$",
    re.IGNORECASE,
)
ROOM_WORDS = {
    "apartment",
    "attic",
    "basement",
    "bathroom",
    "bedroom",
    "car",
    "cellar",
    "dining",
    "garage",
    "garden",
    "guest",
    "hall",
    "kitchen",
    "laundry",
    "living",
    "loft",
    "office",
    "pantry",
    "room",
    "shed",
    "storage",
    "study",
    "utility",
    "wardrobe",
}
CONTAINER_WORDS = {
    "bag",
    "bin",
    "box",
    "boxes",
    "cabinet",
    "case",
    "crate",
    "cupboard",
    "drawer",
    "shelf",
    "shelves",
    "storage",
    "suitcase",
    "tote",
}
INDEX_WORDS = {
    "index",
    "contents",
    "table of contents",
    "catalogue",
    "catalog",
    "inventory index",
}
IGNORE_HEADINGS = {
    "template",
    "templates",
    "instructions",
    "how to use",
    "conventions",
    "legend",
    "notes",
    "readme",
    "about this inventory",
}
INSTRUCTION_RE = re.compile(
    r"^(?:put|place|store|keep|sort|label|move|ensure|use|see|refer|"
    r"remember|remaining|todo|to do|note:|important:|do not|don't)\b",
    re.IGNORECASE,
)
REFERENCE_RE = re.compile(
    r"^(?:see|refer to|linked|index|stored in|located in)\b|"
    r"\b(?:index|link|reference)\b",
    re.IGNORECASE,
)


@dataclass
class HierarchyNode:
    key: str
    entity_type: str
    name: str
    parent_key: str | None = None
    legacy_identifier: str | None = None
    container_type: str | None = None
    confidence: int = 90
    ambiguous: bool = False
    source_path: str = ""
    source_excerpt: str = ""


@dataclass
class HierarchyItem:
    key: str
    draft: ProposalDraft
    parent_key: str
    confidence: int = 85


@dataclass
class HierarchyResult:
    nodes: list[HierarchyNode] = field(default_factory=list)
    items: list[HierarchyItem] = field(default_factory=list)
    ignored: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[dict[str, Any]] = field(default_factory=list)

    @property
    def active(self) -> bool:
        return bool(self.nodes)


def _clean_heading(value: str) -> str:
    value = re.sub(r"^[\s#>*_`-]+", "", value).strip()
    value = re.sub(r"\s+#+\s*$", "", value)
    value = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"[*_`]", "", value)
    return value.strip(" .,:;-—")


def _legacy_identifier(value: str) -> tuple[str | None, str]:
    match = LEGACY_RE.search(value)
    if not match:
        return None, value
    legacy = match.group(1).upper()
    cleaned = _clean_heading(value.replace(match.group(0), ""))
    return legacy, cleaned or legacy


def _room_like(value: str) -> bool:
    tokens = set(re.findall(r"[a-z]+", value.lower()))
    return bool(tokens & ROOM_WORDS) and not any(
        token in value.lower() for token in ("box", "boxes")
    )


def _container_like(value: str) -> bool:
    tokens = set(re.findall(r"[a-z]+", value.lower()))
    return bool(tokens & CONTAINER_WORDS)


def _ignored_heading(value: str) -> bool:
    lowered = value.lower().strip()
    return (
        lowered in INDEX_WORDS
        or lowered in IGNORE_HEADINGS
        or bool(re.search(r"\b(?:index|template|instructions?|how to use|example box)\b", lowered))
    )


def _quantity_suffix(text: str) -> tuple[str, int | None, str | None]:
    match = QUANTITY_SUFFIX_RE.match(text.strip())
    if not match:
        return text, None, None
    name = match.group("name").strip(" .,;:|-")
    quantity = int(match.group("quantity"))
    rest = (match.group("rest") or "").strip(" .,;:|-")
    notes = rest if rest and not re.fullmatch(r"(?:items?|total)", rest, re.I) else None
    return name, quantity, notes


def _item_draft(
    content: str,
    document: ParsedDocument,
    *,
    parent: HierarchyNode,
) -> ProposalDraft | None:
    cleaned = _clean_heading(content)
    if not cleaned or len(cleaned) < 2:
        return None
    if INSTRUCTION_RE.search(cleaned) or REFERENCE_RE.search(cleaned):
        return None
    if LEGACY_RE.fullmatch(cleaned):
        return None
    name, suffix_quantity, suffix_notes = _quantity_suffix(cleaned)
    draft = _parse_detail_line(
        name,
        document,
        collection=parent.name,
        confidence=parent.confidence,
    )
    if draft is None:
        if not re.search(r"[A-Za-z]{2,}", name):
            return None
        draft = ProposalDraft(
            name=name[:200],
            confidence=parent.confidence,
            source_path=document.relative_path,
            source_excerpt=cleaned[:2000],
            note_title=document.title,
            source_file_path=document.relative_path,
            collection=parent.name,
            field_sources={"name": "explicit"},
        )
    if suffix_quantity is not None:
        draft.quantity = max(0, suffix_quantity)
        draft.field_sources["quantity"] = "explicit"
    if suffix_notes:
        draft.notes = f"{draft.notes}\n{suffix_notes}".strip() if draft.notes else suffix_notes
    draft.source_excerpt = cleaned[:2000]
    draft.relationships["hierarchy_parent"] = parent.key
    draft.relationships["hierarchy_parent_name"] = parent.name
    return draft


def parse_hierarchy(bundle: SourceBundle) -> HierarchyResult:
    result = HierarchyResult()
    seen_items: set[tuple[str, str]] = set()
    for document_index, document in enumerate(bundle.documents):
        if document.source_format not in {"markdown", "text"}:
            continue
        frontmatter, body = parse_frontmatter(document.text)
        note_type = str(frontmatter.get("type") or frontmatter.get("kind") or "").strip().lower()
        if note_type in IGNORED_TYPES:
            result.ignored.append(
                {
                    "path": document.relative_path,
                    "title": document.title,
                    "reason": f"{note_type} note",
                }
            )
            continue
        lines = body.splitlines()
        stack: list[tuple[int, HierarchyNode]] = []
        skip_level: int | None = None
        for line_index, raw_line in enumerate(lines):
            heading = re.match(r"^(#{1,6})\s+(.+?)\s*$", raw_line)
            if heading:
                level = len(heading.group(1))
                title = _clean_heading(heading.group(2))
                if skip_level is not None:
                    if level > skip_level:
                        continue
                    skip_level = None
                if _ignored_heading(title) or (
                    level == 1 and re.search(r"\b(?:inventory|household)\b", title.lower())
                ):
                    skip_level = level if _ignored_heading(title) else None
                    stack = [entry for entry in stack if entry[0] < level]
                    continue
                legacy, name = _legacy_identifier(title)
                parent = stack[-1][1] if stack else None
                is_room = bool(name) and _room_like(name) and legacy is None
                is_container = bool(legacy) or (
                    parent is not None and not is_room and _container_like(name)
                )
                is_title = level == 1 and not legacy and not is_room and parent is None
                if is_title or (not legacy and not is_room and not is_container):
                    continue
                while stack and stack[-1][0] >= level:
                    stack.pop()
                parent = stack[-1][1] if stack else None
                entity_type = (
                    ImportEntityType.ROOM.value if is_room else ImportEntityType.CONTAINER.value
                )
                lower = name.lower()
                ambiguous = bool(re.search(r"\b(?:loose|misc|unknown|unsorted|other)\b", lower))
                key = f"{document_index}:{line_index}:{entity_type}"
                node = HierarchyNode(
                    key=key,
                    entity_type=entity_type,
                    name=name[:200] or legacy or "Container",
                    parent_key=parent.key if parent else None,
                    legacy_identifier=legacy,
                    container_type="box" if legacy else "other",
                    confidence=45 if ambiguous else 92,
                    ambiguous=ambiguous,
                    source_path=document.relative_path,
                    source_excerpt=raw_line.strip()[:2000],
                )
                result.nodes.append(node)
                if ambiguous:
                    result.warnings.append(
                        {
                            "type": "ambiguous_hierarchy_group",
                            "message": (
                                f"{legacy or name} looks like a loose-items group; "
                                "review its type and parent."
                            ),
                            "path": document.relative_path,
                        }
                    )
                stack.append((level, node))
                continue
            if skip_level is not None:
                continue
            list_match = re.match(r"^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$", raw_line)
            if not list_match or not stack:
                continue
            content = _remove_list_marker(raw_line)
            if not content:
                continue
            parent = stack[-1][1]
            draft = _item_draft(content, document, parent=parent)
            if draft is None:
                continue
            dedupe_key = (parent.key, draft.name.strip().lower())
            if dedupe_key in seen_items:
                continue
            seen_items.add(dedupe_key)
            item_key = f"{document_index}:{line_index}:item"
            result.items.append(
                HierarchyItem(
                    key=item_key,
                    draft=draft,
                    parent_key=parent.key,
                    confidence=draft.confidence or parent.confidence,
                )
            )
    if result.nodes and not result.items:
        result.warnings.append(
            {
                "type": "hierarchy_without_items",
                "message": "Rooms or containers were detected but no item bullets were extracted.",
            }
        )
    return result


def ensure_unique_keys(result: HierarchyResult) -> None:
    """Make parser keys safe for JSON metadata and deterministic retries."""
    nodes = {node.key for node in result.nodes}
    for item in result.items:
        if item.parent_key not in nodes:
            raise ValueError("Hierarchy item references an unknown parent.")
