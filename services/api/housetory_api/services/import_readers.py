"""Safe readers for bulk inventory source formats.

No optional Office/Excel dependency is required: DOCX and XLSX are ZIP+XML
formats and are parsed with the Python standard library. PDF and image text uses
the Phase 3 local OCR pipeline.
"""

import csv
import io
import re
import zipfile
from datetime import date, timedelta
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree

from ..config import get_settings
from .import_types import ExtractedSourceFile, ParsedDocument, ParsedTable, SourceBundle
from .ocr import OcrError, extract_text

NOTE_EXTENSIONS = {".md", ".markdown", ".txt"}
TABLE_EXTENSIONS = {".csv", ".xlsx"}
DOC_EXTENSIONS = {".pdf", ".docx"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
SUPPORTED_EXTENSIONS = (
    NOTE_EXTENSIONS | TABLE_EXTENSIONS | DOC_EXTENSIONS | IMAGE_EXTENSIONS | {".zip"}
)
ATTACHMENT_EXTENSIONS = {
    ".pdf",
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".heic",
    ".heif",
    ".gif",
    ".txt",
    ".md",
    ".markdown",
    ".csv",
}
HIDDEN_PARTS = {".obsidian", ".git", ".trash", "node_modules", "__MACOSX", ".DS_Store"}

WIKILINK_RE = re.compile(r"(!?)\[\[([^\]]+)\]\]")
MARKDOWN_LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")


def _decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _safe_member_path(name: str) -> PurePosixPath | None:
    if not name or name.startswith("/") or name.startswith("\\"):
        return None
    normalized = name.replace("\\", "/")
    if normalized.startswith("./"):
        normalized = normalized[2:]
    path = PurePosixPath(normalized)
    if not path.parts or any(part in {"..", ""} for part in path.parts):
        return None
    if any(part in HIDDEN_PARTS or part.startswith(".~") for part in path.parts):
        return None
    return path


def _zip_is_symlink(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0o170000
    return mode == 0o120000


def _vault_tree(paths: list[str]) -> list[dict]:
    root: dict[str, dict] = {}
    for path in sorted(set(paths)):
        cursor = root
        parts = PurePosixPath(path).parts
        for index, part in enumerate(parts):
            is_file = index == len(parts) - 1
            node = cursor.setdefault(
                part,
                {
                    "name": part,
                    "path": "/".join(parts[: index + 1]),
                    "type": "file" if is_file else "folder",
                    "children": {},
                },
            )
            if not is_file:
                cursor = node["children"]

    def convert(nodes: dict[str, dict]) -> list[dict]:
        result = []
        for node in sorted(
            nodes.values(), key=lambda entry: (entry["type"] != "folder", entry["name"].lower())
        ):
            item = {key: value for key, value in node.items() if key != "children"}
            if node["type"] == "folder":
                item["children"] = convert(node["children"])
            result.append(item)
        return result

    return convert(root)


def _markdown_targets(text: str) -> tuple[list[str], list[str]]:
    links: list[str] = []
    embeds: list[str] = []
    for embed, raw in WIKILINK_RE.findall(text):
        target = raw.split("|", 1)[0].split("#", 1)[0].split("^", 1)[0].strip()
        if target:
            (embeds if embed else links).append(target)
    for raw in MARKDOWN_LINK_RE.findall(text):
        target = raw.strip().strip("<>").split("#", 1)[0]
        if target and not re.match(r"^[a-z]+://", target, re.I):
            links.append(target)
    return list(dict.fromkeys(links)), list(dict.fromkeys(embeds))


def _resolve_target(
    target: str, notes: dict[str, bytes], attachments: dict[str, bytes]
) -> str | None:
    cleaned = target.strip().replace("\\", "/")
    if cleaned.startswith("/"):
        cleaned = cleaned[1:]
    candidates = [cleaned]
    suffix = PurePosixPath(cleaned).suffix.lower()
    if not suffix:
        candidates.extend(f"{cleaned}{ext}" for ext in (".md", ".markdown", ".txt"))
        candidates.extend(f"{cleaned}{ext}" for ext in ATTACHMENT_EXTENSIONS)
    for candidate in candidates:
        if candidate in notes or candidate in attachments:
            return candidate
    # Obsidian resolves bare filenames by basename if unique.
    basename = PurePosixPath(cleaned).name
    matches = [path for path in [*notes, *attachments] if PurePosixPath(path).name == basename]
    if len(matches) == 1:
        return matches[0]
    return None


def _dotx_text(xml: bytes, namespace: str) -> list[str]:
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError:
        return []
    tag = f"{{{namespace}}}t"
    return [node.text or "" for node in root.iter(tag)]


def _read_docx(data: bytes, relative_path: str) -> ParsedDocument:
    namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    text_parts: list[str] = []
    tables: list[ParsedTable] = []
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            xml = archive.read("word/document.xml")
    except (KeyError, zipfile.BadZipFile) as exc:
        raise ValueError("This Word document is not a readable .docx file.") from exc
    root = ElementTree.fromstring(xml)
    body = root.find(f"{{{namespace}}}body")
    if body is None:
        return ParsedDocument(
            relative_path,
            PurePosixPath(relative_path).stem,
            "",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "docx",
            raw_bytes=data,
        )
    for child in body:
        if child.tag == f"{{{namespace}}}p":
            line = "".join(node.text or "" for node in child.iter(f"{{{namespace}}}t")).strip()
            if line:
                text_parts.append(line)
        elif child.tag == f"{{{namespace}}}tbl":
            rows: list[list[str]] = []
            for row in child.findall(f".//{{{namespace}}}tr"):
                values = []
                for cell in row.findall(f"{{{namespace}}}tc"):
                    values.append(
                        " ".join(_dotx_text(ElementTree.tostring(cell), namespace)).strip()
                    )
                if any(values):
                    rows.append(values)
            if len(rows) >= 2:
                tables.append(
                    ParsedTable(headers=rows[0], rows=rows[1:], name=f"Table {len(tables) + 1}")
                )
    return ParsedDocument(
        relative_path=relative_path,
        title=PurePosixPath(relative_path).stem,
        text="\n".join(text_parts),
        content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        source_format="docx",
        raw_bytes=data,
        tables=tables,
    )


def _column_index(reference: str) -> int:
    letters = "".join(character for character in reference if character.isalpha()).upper()
    if not letters:
        return 0
    value = 0
    for character in letters:
        value = value * 26 + (ord(character) - 64)
    return max(0, value - 1)


def _excel_date(value: str) -> str | None:
    try:
        serial = float(value)
    except ValueError:
        return None
    if serial <= 0 or serial > 90000:
        return None
    result = date(1899, 12, 30) + timedelta(days=serial)
    return result.isoformat()


def _xlsx_date_styles(archive: zipfile.ZipFile) -> set[int]:
    try:
        styles = ElementTree.fromstring(archive.read("xl/styles.xml"))
    except (KeyError, ElementTree.ParseError):
        return set()
    namespace = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    custom_dates: set[int] = set()
    for node in styles.iter(f"{namespace}numFmt"):
        format_code = (node.attrib.get("formatCode") or "").lower()
        if any(token in format_code for token in ("yy", "dd", "mmm", "d/m", "m/d")):
            try:
                custom_dates.add(int(node.attrib.get("numFmtId", "0")))
            except ValueError:
                continue
    date_styles: set[int] = set()
    cell_xfs = styles.find(f"{namespace}cellXfs")
    if cell_xfs is None:
        return date_styles
    for index, xf in enumerate(cell_xfs.findall(f"{namespace}xf")):
        try:
            number_format = int(xf.attrib.get("numFmtId", "0"))
        except ValueError:
            number_format = 0
        if number_format in {*range(14, 23), *range(45, 48)} or number_format in custom_dates:
            date_styles.add(index)
    return date_styles


def _read_xlsx(data: bytes, relative_path: str) -> list[ParsedDocument]:
    namespace = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    relationship_ns = "{http://schemas.openxmlformats.org/package/2006/relationships}"
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            shared: list[str] = []
            try:
                shared_root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
                shared = [
                    "".join(node.text or "" for node in item.iter(f"{namespace}t"))
                    for item in shared_root.findall(f"{namespace}si")
                ]
            except (KeyError, ElementTree.ParseError):
                pass
            date_styles = _xlsx_date_styles(archive)
            sheet_rels: dict[str, str] = {}
            try:
                rel_root = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
                for rel in rel_root.findall(f"{relationship_ns}Relationship"):
                    sheet_rels[rel.attrib.get("Id", "")] = rel.attrib.get("Target", "")
            except (KeyError, ElementTree.ParseError):
                pass
            workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
            sheets = list(workbook.iter(f"{namespace}sheet"))
            documents: list[ParsedDocument] = []
            for index, sheet in enumerate(sheets):
                name = sheet.attrib.get("name") or f"Sheet {index + 1}"
                relation_id = sheet.attrib.get(
                    "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id",
                    "",
                )
                target = sheet_rels.get(relation_id) or f"worksheets/sheet{index + 1}.xml"
                target = target.lstrip("/")
                path = target if target.startswith("xl/") else f"xl/{target}"
                try:
                    sheet_xml = archive.read(path)
                except KeyError:
                    continue
                root = ElementTree.fromstring(sheet_xml)
                rows: list[list[str]] = []
                for row in root.iter(f"{namespace}row"):
                    values: dict[int, str] = {}
                    for cell in row.findall(f"{namespace}c"):
                        column = _column_index(cell.attrib.get("r", ""))
                        kind = cell.attrib.get("t")
                        raw = cell.find(f"{namespace}v")
                        value = raw.text if raw is not None else ""
                        if kind == "s" and value:
                            try:
                                value = shared[int(value)]
                            except (ValueError, IndexError):
                                value = ""
                        elif kind == "inlineStr":
                            value = "".join(node.text or "" for node in cell.iter(f"{namespace}t"))
                        elif kind == "b":
                            value = "Yes" if value == "1" else "No"
                        elif value and date_styles:
                            try:
                                style_index = int(cell.attrib.get("s", "0"))
                            except ValueError:
                                style_index = 0
                            if style_index in date_styles:
                                value = _excel_date(value) or value
                        values[column] = (value or "").strip()
                    if values:
                        width = max(values) + 1
                        rows.append([values.get(column, "") for column in range(width)])
                rows = [row for row in rows if any(cell for cell in row)]
                if not rows:
                    continue
                headers = rows[0]
                documents.append(
                    ParsedDocument(
                        relative_path=f"{relative_path}#{name}",
                        title=f"{PurePosixPath(relative_path).stem} — {name}",
                        text="\n".join("\t".join(row) for row in rows),
                        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        source_format="xlsx",
                        raw_bytes=data,
                        tables=[ParsedTable(headers=headers, rows=rows[1:], name=name)],
                    )
                )
            return documents
    except (KeyError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
        raise ValueError("This spreadsheet is not a readable .xlsx file.") from exc


def _read_csv(data: bytes, relative_path: str) -> ParsedDocument:
    text = _decode_text(data)
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows = [
        row for row in csv.reader(io.StringIO(text), dialect) if any(cell.strip() for cell in row)
    ]
    if not rows:
        raise ValueError("This CSV file is empty.")
    headers = [cell.strip() for cell in rows[0]]
    table = ParsedTable(headers=headers, rows=rows[1:], name=PurePosixPath(relative_path).stem)
    return ParsedDocument(
        relative_path=relative_path,
        title=PurePosixPath(relative_path).stem,
        text=text,
        content_type="text/csv",
        source_format="csv",
        raw_bytes=data,
        tables=[table],
    )


def _read_vault(data: bytes, filename: str) -> SourceBundle:
    settings = get_settings()
    max_files = settings.import_max_files
    max_total = settings.import_max_total_mb * 1024 * 1024
    max_file = settings.import_max_file_mb * 1024 * 1024
    notes: dict[str, bytes] = {}
    attachments: dict[str, bytes] = {}
    all_paths: list[str] = []
    warnings: list[dict] = []
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValueError("The uploaded ZIP is not a valid vault archive.") from exc
    with archive:
        infos = [info for info in archive.infolist() if not info.is_dir()]
        if len(infos) > max_files:
            raise ValueError(f"Vault archives are limited to {max_files} files.")
        total = 0
        for info in infos:
            if _zip_is_symlink(info):
                warnings.append(
                    {"type": "unsafe_entry", "path": info.filename, "message": "Symlink skipped."}
                )
                continue
            path = _safe_member_path(info.filename)
            if path is None:
                warnings.append(
                    {
                        "type": "unsafe_entry",
                        "path": info.filename,
                        "message": "Unsafe archive path skipped.",
                    }
                )
                continue
            if info.flag_bits & 0x1:
                warnings.append(
                    {
                        "type": "encrypted_entry",
                        "path": str(path),
                        "message": "Encrypted file skipped.",
                    }
                )
                continue
            if info.file_size > max_file:
                warnings.append(
                    {
                        "type": "file_too_large",
                        "path": str(path),
                        "message": "File exceeds the per-file limit.",
                    }
                )
                continue
            total += info.file_size
            if total > max_total:
                raise ValueError("The vault exceeds the decompressed size limit.")
            relative = str(path)
            suffix = path.suffix.lower()
            if suffix not in NOTE_EXTENSIONS and suffix not in ATTACHMENT_EXTENSIONS:
                warnings.append(
                    {
                        "type": "unsupported_file",
                        "path": relative,
                        "message": "Unsupported file skipped.",
                    }
                )
                continue
            try:
                content = archive.read(info)
            except (RuntimeError, zipfile.BadZipFile) as exc:
                warnings.append({"type": "read_error", "path": relative, "message": str(exc)[:200]})
                continue
            all_paths.append(relative)
            if suffix in NOTE_EXTENSIONS:
                notes[relative] = content
            else:
                attachments[relative] = content
    documents: list[ParsedDocument] = []
    broken_links: list[dict] = []
    referenced_attachments: set[str] = set()
    for relative, content in sorted(notes.items()):
        text = _decode_text(content)
        links, embeds = _markdown_targets(text)
        for target in [*links, *embeds]:
            resolved = _resolve_target(target, notes, attachments)
            if resolved is None:
                broken_links.append({"note": relative, "target": target})
            elif resolved in attachments:
                referenced_attachments.add(resolved)
        source_format = (
            "markdown" if PurePosixPath(relative).suffix.lower() in {".md", ".markdown"} else "text"
        )
        documents.append(
            ParsedDocument(
                relative_path=relative,
                title=PurePosixPath(relative).stem,
                text=text,
                content_type="text/markdown" if source_format == "markdown" else "text/plain",
                source_format=source_format,
                raw_bytes=content,
                links=links,
                embeds=embeds,
            )
        )
    files = [
        ExtractedSourceFile(
            relative_path=relative,
            kind="note",
            content_type="text/markdown"
            if PurePosixPath(relative).suffix.lower() in {".md", ".markdown"}
            else "text/plain",
            data=content,
        )
        for relative, content in sorted(notes.items())
    ]
    for relative, content in sorted(attachments.items()):
        files.append(
            ExtractedSourceFile(
                relative_path=relative,
                kind="attachment",
                content_type=_content_type_for_suffix(PurePosixPath(relative).suffix.lower()),
                data=content,
            )
        )
    return SourceBundle(
        documents=documents,
        files=files,
        warnings=warnings,
        broken_links=broken_links,
        vault_tree=_vault_tree(all_paths),
        source_format="obsidian_vault",
        metadata={
            "note_count": len(notes),
            "attachment_count": len(attachments),
            "referenced_attachment_count": len(referenced_attachments),
            "folders": sorted({str(PurePosixPath(path).parent) for path in all_paths}),
        },
    )


def _content_type_for_suffix(suffix: str) -> str:
    return {
        ".pdf": "application/pdf",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".heic": "image/heic",
        ".heif": "image/heif",
        ".gif": "image/gif",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".markdown": "text/markdown",
        ".csv": "text/csv",
    }.get(suffix, "application/octet-stream")


def read_source_bundle(path: Path, filename: str, content_type: str | None) -> SourceBundle:
    suffix = PurePosixPath(filename).suffix.lower()
    data = path.read_bytes()
    if suffix == ".zip":
        return _read_vault(data, filename)
    if suffix in {".md", ".markdown"}:
        return SourceBundle(
            documents=[
                ParsedDocument(
                    relative_path=filename,
                    title=PurePosixPath(filename).stem,
                    text=_decode_text(data),
                    content_type="text/markdown",
                    source_format="markdown",
                    raw_bytes=data,
                )
            ],
            source_format="markdown",
        )
    if suffix == ".txt":
        return SourceBundle(
            documents=[
                ParsedDocument(
                    relative_path=filename,
                    title=PurePosixPath(filename).stem,
                    text=_decode_text(data),
                    content_type="text/plain",
                    source_format="text",
                    raw_bytes=data,
                )
            ],
            source_format="text",
        )
    if suffix == ".csv":
        return SourceBundle(documents=[_read_csv(data, filename)], source_format="csv")
    if suffix == ".xlsx":
        documents = _read_xlsx(data, filename)
        if not documents:
            raise ValueError("This workbook contains no readable sheets.")
        return SourceBundle(documents=documents, source_format="xlsx")
    if suffix == ".docx":
        return SourceBundle(documents=[_read_docx(data, filename)], source_format="docx")
    if suffix in {".pdf", *IMAGE_EXTENSIONS}:
        try:
            extracted = extract_text(path, content_type or _content_type_for_suffix(suffix))
        except OcrError as exc:
            raise ValueError(f"Could not read this file: {exc}") from exc
        return SourceBundle(
            documents=[
                ParsedDocument(
                    relative_path=filename,
                    title=PurePosixPath(filename).stem,
                    text=extracted.text,
                    content_type=content_type or _content_type_for_suffix(suffix),
                    source_format="ocr",
                    raw_bytes=data,
                )
            ],
            source_format="ocr",
            metadata={"ocr_confidence": extracted.confidence, "ocr_source": extracted.source},
        )
    raise ValueError("Unsupported import file type.")
