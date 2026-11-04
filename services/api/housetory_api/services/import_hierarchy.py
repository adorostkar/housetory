"""Deterministic hierarchy interpretation for Markdown and note imports.

The parser is deterministic-first and conservative. It recognizes room groups,
legacy container labels, container headings and list-based contents. It ignores
instruction sections, index references and empty example containers, while
retaining the original source evidence for every proposal.

Normal Markdown collection notes keep the existing flat extraction behaviour when
no recognizable room/container structure exists.
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
PAREN_RE = re.compile(r"\(([^()]*)\)")
COMBO_QUANTITY_RE = re.compile(
    r"^(?P<left>.*?)\((?P<left_quantity>\d{1,5})\)\s*\+\s*"
    r"(?P<right>.+?)\((?P<right_quantity>\d{1,5})\)\s*$"
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
INSTRUCTION_HEADING_RE = re.compile(
    r"^(?:best practice|what to track|capture workflow|search habit|location codes|"
    r"box id format|rules|instructions?|how to use|conventions|legend|readme)\b",
    re.IGNORECASE,
)
INSTRUCTION_RE = re.compile(
    r"^(?:put|place|store|keep|sort|label|move|ensure|use|see|refer|"
    r"remember|remaining|todo|to do|note:|important:|do not|don't|track|"
    r"only one source|whenever|pass \d)\b",
    re.IGNORECASE,
)
REFERENCE_RE = re.compile(
    r"^(?:see|refer to|linked|index|stored in|located in)\b|"
    r"\b(?:index|link|reference)\b",
    re.IGNORECASE,
)
CONTEXT_RE = re.compile(
    r"^(?:includes?|contains?|consists?|with|plus|note|details?|context|"
    r"breakdown|sub-?items?)\b",
    re.IGNORECASE,
)
AMBIGUOUS_RE = re.compile(r"\b(?:loose|misc|unknown|unsorted|other)\b", re.IGNORECASE)


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


@dataclass
class IndexReference:
    group: str | None
    group_code: str | None
    group_source: str
    group_line: int
    room: str | None
    description: str
    source: str
    line: int


def _clean_heading(value: str) -> str:
    value = re.sub(r"^[\s#>*_`-]+", "", value).strip()
    value = re.sub(r"\s+#+\s*$", "", value)
    value = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"[*_`]", "", value)
    return value.strip(" .,:;-—–")


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


def _index_heading(value: str) -> bool:
    lowered = value.lower().strip()
    return lowered in INDEX_WORDS or bool(
        re.match(r"^(?:inventory\s+)?(?:index|contents|table of contents)\b", lowered)
    )


def _ignored_heading(value: str) -> bool:
    lowered = value.lower().strip()
    if lowered in INDEX_WORDS or lowered in IGNORE_HEADINGS:
        return True
    if INSTRUCTION_HEADING_RE.search(lowered):
        return True
    if "template" in lowered and "box list" not in lowered:
        return True
    if lowered.startswith(("example ", "examples", "sample ")):
        return True
    return bool(
        re.search(
            r"\b(?:instructions?|how to use|conventions|legend|readme|about this inventory)\b",
            lowered,
        )
    )


def _split_room_descriptor(value: str) -> tuple[str | None, str]:
    pieces = [piece.strip() for piece in re.split(r"\s+[—–-]\s+|:\s*", value) if piece.strip()]
    if not pieces:
        return None, ""
    if _room_like(pieces[0]):
        return pieces[0], " ".join(pieces[1:]).strip()
    return None, value.strip()


def _parse_index_group(value: str) -> tuple[str | None, str | None]:
    cleaned = re.sub(r"^\s*\d+[.)]\s*", "", _clean_heading(value))
    match = re.match(r"^(?P<name>.+?)\s*\((?P<code>[A-Z]{2,8})\)\s*$", cleaned)
    if match:
        return match.group("name").strip(), match.group("code")
    if _room_like(cleaned):
        return cleaned, None
    return None, None


def _parse_index_reference(line: str) -> tuple[str, str, str] | None:
    content = _remove_list_marker(line)
    if not content:
        return None
    match = re.match(r"^(?P<legacy>[A-Z]{2,8}(?:-[A-Z0-9]+)*-\d{1,4})\b(?P<rest>.*)$", content)
    if not match:
        return None
    legacy = match.group("legacy").upper()
    rest = match.group("rest").strip(" .,;:—-–")
    pieces = [piece.strip() for piece in re.split(r"\s+[—–-]\s+|:\s*", rest) if piece.strip()]
    room = None
    description = rest
    if pieces and _room_like(pieces[0]):
        room = pieces[0]
        description = " ".join(pieces[1:]).strip()
    return legacy, room or "", description


def _parse_index(lines: list[str]) -> dict[str, IndexReference]:
    references: dict[str, IndexReference] = {}
    in_index = False
    index_level = 0
    current_group: str | None = None
    current_code: str | None = None
    current_source = ""
    current_line = 0
    for line_index, raw_line in enumerate(lines):
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*$", raw_line)
        if heading:
            level = len(heading.group(1))
            title = _clean_heading(heading.group(2))
            if in_index and level <= index_level:
                in_index = False
            if not in_index and _index_heading(title):
                in_index = True
                index_level = level
                current_group = None
                current_code = None
                continue
            if in_index and level == index_level + 1:
                group, code = _parse_index_group(title)
                if group:
                    current_group = group
                    current_code = code
                    current_source = raw_line.strip()
                    current_line = line_index
                continue
            if in_index:
                continue
        if not in_index or current_group is None:
            continue
        parsed = _parse_index_reference(raw_line)
        if parsed is None:
            continue
        legacy, room, description = parsed
        references[legacy] = IndexReference(
            group=current_group,
            group_code=current_code,
            group_source=current_source,
            group_line=current_line,
            room=room or None,
            description=description,
            source=raw_line.strip(),
            line=line_index,
        )
    return references


def _quantity_parentheticals(text: str) -> tuple[str, int | None, str | None]:
    """Extract a quantity while preserving dimensions, ages and model numbers."""
    combo = COMBO_QUANTITY_RE.match(text.strip())
    if combo:
        left = _clean_heading(combo.group("left"))
        right = _clean_heading(combo.group("right"))
        quantity = int(combo.group("left_quantity")) + int(combo.group("right_quantity"))
        name = f"{left} + {right}" if left and right else (left or right)
        return name, quantity, text.strip()

    candidates: list[tuple[int, int, int, str | None]] = []
    for match in PAREN_RE.finditer(text):
        content = match.group(1).strip()
        lowered = content.lower()
        scored: int | None = None
        quantity: int | None = None
        note: str | None = None
        total = re.fullmatch(r"(\d{1,5})\s+(?:total|items?|pcs?|pieces?|units?)", lowered)
        if total:
            quantity = int(total.group(1))
            scored = 100
        elif re.fullmatch(r"\d{1,5}", lowered):
            quantity = int(lowered)
            scored = 60
        elif set_match := re.fullmatch(r"(\d{1,5})\s+(sets?|pairs?)", lowered):
            quantity = int(set_match.group(1))
            note = set_match.group(2)
            scored = 90
        elif sum_match := re.fullmatch(r"(\d{1,5})\s*\+\s*(\d{1,5})", lowered):
            quantity = int(sum_match.group(1)) + int(sum_match.group(2))
            scored = 40
        if scored is not None and quantity is not None:
            candidates.append((scored, match.start(), quantity, note))
    if not candidates:
        return text.strip(), None, None
    _, start, quantity, note = max(candidates, key=lambda item: (item[0], item[1]))
    match = PAREN_RE.match(text, start)
    if match is None:
        # PAREN_RE.match needs the exact opening position; find it instead.
        match = next(
            candidate for candidate in PAREN_RE.finditer(text) if candidate.start() == start
        )
    name = (text[: match.start()] + text[match.end() :]).strip()
    name = re.sub(r"\s+", " ", name).strip(" .,;:|-–—")
    notes = note if note else None
    return name, quantity, notes


def _extract_quantity(text: str) -> tuple[str, int | None, str | None]:
    name, quantity, notes = _quantity_parentheticals(text)
    if quantity is not None:
        return name, quantity, notes
    match = QUANTITY_SUFFIX_RE.match(text.strip())
    if not match:
        return name, None, notes
    suffix_name = match.group("name").strip(" .,;:|-–—")
    suffix_quantity = int(match.group("quantity"))
    rest = (match.group("rest") or "").strip(" .,;:|-–—")
    return suffix_name, suffix_quantity, rest or notes


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
    name, suffix_quantity, suffix_notes = _extract_quantity(cleaned)
    if not re.search(r"[A-Za-z]{2,}", name):
        return None
    draft = _parse_detail_line(
        name,
        document,
        collection=parent.name,
        confidence=parent.confidence,
    )
    if draft is None:
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


def _append_context(draft: ProposalDraft, content: str) -> None:
    context = _clean_heading(content)
    if not context:
        return
    draft.notes = (
        f"{draft.notes}\nNested note: {context}".strip()
        if draft.notes
        else (f"Nested note: {context}")
    )
    draft.source_excerpt = f"{draft.source_excerpt}\n  {context}"[:4000]


def parse_hierarchy(bundle: SourceBundle) -> HierarchyResult:
    result = HierarchyResult()
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
        index_refs = _parse_index(lines)
        stack: list[tuple[int, HierarchyNode]] = []
        room_keys: dict[tuple[str, str | None], str] = {}
        container_by_legacy: dict[str, HierarchyNode] = {}
        skip_level: int | None = None
        last_item: HierarchyItem | None = None
        last_item_indent = -1
        seen_items: set[tuple[str, str]] = set()

        def add_node(
            node: HierarchyNode,
            *,
            document: ParsedDocument = document,
            result: HierarchyResult = result,
        ) -> HierarchyNode:
            result.nodes.append(node)
            if node.ambiguous:
                result.warnings.append(
                    {
                        "type": "ambiguous_hierarchy_group",
                        "message": (
                            f"{node.legacy_identifier or node.name} looks like a loose-items "
                            "group; review its type and parent."
                        ),
                        "path": document.relative_path,
                    }
                )
            return node

        def ensure_room(
            name: str,
            parent_key: str | None,
            *,
            line: int,
            source: str,
            document: ParsedDocument = document,
            document_index: int = document_index,
            room_keys: dict[tuple[str, str | None], str] = room_keys,
            result: HierarchyResult = result,
        ) -> HierarchyNode:
            cleaned = _clean_heading(name)
            if not cleaned:
                cleaned = "Storage"
            key = (cleaned.lower(), parent_key)
            existing_key = room_keys.get(key)
            if existing_key:
                return next(node for node in result.nodes if node.key == existing_key)
            node = HierarchyNode(
                key=f"{document_index}:{line}:room:{len(result.nodes)}",
                entity_type=ImportEntityType.ROOM.value,
                name=cleaned[:200],
                parent_key=parent_key,
                confidence=90,
                source_path=document.relative_path,
                source_excerpt=source.strip()[:2000] or f"Room: {cleaned}",
            )
            add_node(node)
            room_keys[key] = node.key
            return node

        def room_parent_for_group(
            group: str | None,
            room: str | None,
            *,
            line: int,
            source: str,
        ) -> HierarchyNode | None:
            if not room:
                return None
            if not group or group.lower() == room.lower():
                return ensure_room(room, None, line=line, source=source)
            group_node = ensure_room(group, None, line=line, source=source)
            if group.lower() in room.lower() or room.lower().startswith(group.lower()):
                return ensure_room(room, group_node.key, line=line, source=source)
            return group_node

        for line_index, raw_line in enumerate(lines):
            heading = re.match(r"^(#{1,6})\s+(.+?)\s*$", raw_line)
            if heading:
                level = len(heading.group(1))
                title = _clean_heading(heading.group(2))
                source_excerpt = raw_line.strip()
                if skip_level is not None:
                    if level > skip_level:
                        continue
                    skip_level = None
                if _index_heading(title):
                    skip_level = level
                    stack = []
                    last_item = None
                    continue
                if _ignored_heading(title):
                    skip_level = level
                    stack = []
                    last_item = None
                    continue
                legacy, remainder = _legacy_identifier(title)
                if legacy:
                    while stack and stack[-1][0] >= level:
                        stack.pop()
                    reference = index_refs.get(legacy)
                    parentheticals = [match.group(1) for match in PAREN_RE.finditer(remainder)]
                    outside = _clean_heading(PAREN_RE.sub("", remainder))
                    room_name = None
                    descriptor = ""
                    for parenthetical in parentheticals:
                        candidate, extra = _split_room_descriptor(parenthetical)
                        if candidate:
                            room_name = candidate
                            descriptor = extra
                            break
                    if reference and reference.room:
                        room_name = reference.room
                    if not room_name:
                        for _stack_level, stack_node in reversed(stack):
                            if stack_node.entity_type == ImportEntityType.ROOM.value:
                                room_name = stack_node.name
                                break
                    if not room_name and reference:
                        room_name = reference.group
                    group = reference.group if reference else None
                    current_room_node = next(
                        (
                            stack_node
                            for _, stack_node in reversed(stack)
                            if stack_node.entity_type == ImportEntityType.ROOM.value
                        ),
                        None,
                    )
                    if (
                        not group
                        and room_name
                        and current_room_node is not None
                        and current_room_node.name.lower() == room_name.lower()
                    ):
                        parent_node = current_room_node
                    else:
                        parent_node = room_parent_for_group(
                            group,
                            room_name,
                            line=line_index,
                            source=source_excerpt,
                        )
                    if parent_node is None and stack:
                        parent_node = stack[-1][1]
                    existing = container_by_legacy.get(legacy)
                    if existing is not None:
                        stack.append((level, existing))
                        last_item = None
                        continue
                    lower_evidence = " ".join(
                        filter(
                            None,
                            [
                                outside,
                                descriptor,
                                reference.description if reference else "",
                                reference.source if reference else "",
                            ],
                        )
                    )
                    ambiguous = bool(AMBIGUOUS_RE.search(lower_evidence))
                    name = outside or legacy
                    node = HierarchyNode(
                        key=f"{document_index}:{line_index}:container:{len(result.nodes)}",
                        entity_type=ImportEntityType.CONTAINER.value,
                        name=name[:200],
                        parent_key=parent_node.key if parent_node else None,
                        legacy_identifier=legacy,
                        container_type="box" if legacy else "other",
                        confidence=45 if ambiguous else 92,
                        ambiguous=ambiguous,
                        source_path=document.relative_path,
                        source_excerpt=source_excerpt[:2000],
                    )
                    add_node(node)
                    container_by_legacy[legacy] = node
                    stack.append((level, node))
                    last_item = None
                    continue
                room_title = re.sub(r"^\s*\d+[.)]\s*", "", title)
                if _room_like(room_title):
                    while stack and stack[-1][0] >= level:
                        stack.pop()
                    parent_room = next(
                        (
                            stack_node
                            for _, stack_node in reversed(stack)
                            if stack_node.entity_type == ImportEntityType.ROOM.value
                        ),
                        None,
                    )
                    node = ensure_room(
                        room_title,
                        parent_room.key if parent_room else None,
                        line=line_index,
                        source=source_excerpt,
                    )
                    stack.append((level, node))
                    last_item = None
                    continue
                if _container_like(room_title) and stack:
                    while stack and stack[-1][0] >= level:
                        stack.pop()
                    parent_node = stack[-1][1] if stack else None
                    if parent_node is not None:
                        node = HierarchyNode(
                            key=f"{document_index}:{line_index}:container:{len(result.nodes)}",
                            entity_type=ImportEntityType.CONTAINER.value,
                            name=room_title[:200],
                            parent_key=parent_node.key,
                            container_type="other",
                            confidence=88,
                            source_path=document.relative_path,
                            source_excerpt=source_excerpt[:2000],
                        )
                        add_node(node)
                        stack.append((level, node))
                        last_item = None
                        continue
                while stack and stack[-1][0] >= level:
                    stack.pop()
                last_item = None
                continue
            if skip_level is not None:
                continue
            list_match = re.match(r"^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$", raw_line)
            if not list_match or not stack:
                continue
            indent = len(list_match.group(1).replace("\t", "  "))
            content = _remove_list_marker(raw_line)
            if not content:
                continue
            parent = stack[-1][1]
            if (
                last_item is not None
                and last_item.parent_key == parent.key
                and indent > last_item_indent
                and (CONTEXT_RE.search(content) or indent >= last_item_indent + 2)
            ):
                _append_context(last_item.draft, content)
                continue
            draft = _item_draft(content, document, parent=parent)
            if draft is None:
                continue
            dedupe_key = (parent.key, draft.name.strip().lower())
            if dedupe_key in seen_items:
                continue
            seen_items.add(dedupe_key)
            item = HierarchyItem(
                key=f"{document_index}:{line_index}:item",
                draft=draft,
                parent_key=parent.key,
                confidence=draft.confidence or parent.confidence,
            )
            result.items.append(item)
            last_item = item
            last_item_indent = indent

        item_parents = {item.parent_key for item in result.items}
        keep = set(item_parents)
        changed = True
        while changed:
            changed = False
            for node in result.nodes:
                if node.key in keep and node.parent_key and node.parent_key not in keep:
                    keep.add(node.parent_key)
                    changed = True
        discarded = [node for node in result.nodes if node.key not in keep]
        for node in discarded:
            result.ignored.append(
                {
                    "path": document.relative_path,
                    "title": node.name,
                    "reason": "Empty container or room example was not imported.",
                }
            )
        result.nodes = [node for node in result.nodes if node.key in keep]
        result.items = [item for item in result.items if item.parent_key in keep]

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
