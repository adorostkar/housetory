from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ParsedTable:
    headers: list[str]
    rows: list[list[str]]
    name: str | None = None


@dataclass
class ParsedDocument:
    relative_path: str
    title: str
    text: str
    content_type: str
    source_format: str
    raw_bytes: bytes | None = None
    frontmatter: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    links: list[str] = field(default_factory=list)
    embeds: list[str] = field(default_factory=list)
    tables: list[ParsedTable] = field(default_factory=list)
    is_note: bool = True


@dataclass(frozen=True)
class ExtractedSourceFile:
    relative_path: str
    kind: str
    content_type: str
    data: bytes


@dataclass
class SourceBundle:
    documents: list[ParsedDocument]
    files: list[ExtractedSourceFile] = field(default_factory=list)
    warnings: list[dict[str, Any]] = field(default_factory=list)
    broken_links: list[dict[str, Any]] = field(default_factory=list)
    vault_tree: list[dict[str, Any]] = field(default_factory=list)
    source_format: str = "text"
    metadata: dict[str, Any] = field(default_factory=dict)
