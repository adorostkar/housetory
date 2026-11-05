import hashlib
import os
import re
import shutil
import tempfile
import uuid
import warnings
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal

from fastapi import UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError
from pypdf import PdfReader

from ..api.errors import ApiError
from ..config import get_settings

try:  # HEIC support matters for photos taken on an iPhone.
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:  # pragma: no cover - optional at runtime
    pass

Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)

# Decoder allowlist. Image.open() otherwise sniffs every registered codec,
# including formats this application never accepts.
SUPPORTED_IMAGE_FORMATS = ("JPEG", "PNG", "WEBP", "HEIF")

PHOTO_FORMATS = {
    "JPEG": ("image/jpeg", "jpg"),
    "PNG": ("image/png", "png"),
    "WEBP": ("image/webp", "webp"),
    "HEIF": ("image/heic", "heic"),
    "HEIC": ("image/heic", "heic"),
}

SCAN_IMAGE_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
}

DOCUMENT_TYPES = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "text/plain": ".txt",
}

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._ -]+")


@dataclass(frozen=True)
class StoredPhoto:
    storage_key: str
    thumbnail_key: str
    original_filename: str
    content_type: str
    byte_size: int
    width: int
    height: int


@dataclass(frozen=True)
class StoredDocument:
    storage_key: str
    original_storage_key: str
    original_filename: str
    content_type: str
    original_content_type: str
    byte_size: int
    original_byte_size: int


@dataclass(frozen=True)
class StoredScanPageOriginal:
    storage_key: str
    original_filename: str
    content_type: str
    byte_size: int
    width: int
    height: int


@dataclass(frozen=True)
class StoredImportFile:
    storage_key: str
    original_filename: str
    content_type: str
    byte_size: int


@dataclass(frozen=True)
class StoredAiImage:
    storage_key: str
    original_storage_key: str
    original_filename: str
    content_type: str
    original_content_type: str
    byte_size: int
    original_byte_size: int
    width: int
    height: int


def _root_path() -> Path:
    return get_settings().resolved_uploads_dir


def _root() -> Path:
    """Return the writable upload root, creating and restricting it if needed."""
    root = _root_path()
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    return root


def _import_root_path() -> Path:
    return get_settings().resolved_imports_dir


def _import_root() -> Path:
    root = _import_root_path()
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    return root


def ensure_storage() -> None:
    _root()
    _import_root()


def _mkdir_private(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, 0o700)


def _chmod_file(path: Path) -> None:
    os.chmod(path, 0o600)


def _safe_filename(filename: str | None) -> str:
    candidate = (filename or "upload").replace("\\", "/").rsplit("/", 1)[-1]
    candidate = _SAFE_NAME.sub("_", candidate).strip(" .") or "upload"
    return candidate[:255]


def _filename_with_extension(filename: str | None, extension: str) -> str:
    safe = _safe_filename(filename)
    stem = PurePosixPath(safe).stem or "document"
    suffix = f".{extension}" if not extension.startswith(".") else extension
    return f"{stem[: 255 - len(suffix)]}{suffix}"


def safe_document_filename(title: str | None, extension: str = "pdf") -> str:
    return _filename_with_extension(title or "document", extension)


def _open_image(path: Path) -> Image.Image:
    return Image.open(path, formats=list(SUPPORTED_IMAGE_FORMATS))


def _write_temp(upload: UploadFile, max_bytes: int) -> tuple[Path, int]:
    root = _root()
    staging = root / ".staging"
    _mkdir_private(staging)
    fd, temp_name = tempfile.mkstemp(prefix="upload-", dir=staging)
    temp_path = Path(temp_name)
    size = 0
    try:
        try:
            with os.fdopen(fd, "wb") as destination:
                while chunk := upload.file.read(1024 * 1024):
                    size += len(chunk)
                    if size > max_bytes:
                        raise ApiError(
                            413,
                            "file_too_large",
                            f"Files must be smaller than {max_bytes // (1024 * 1024)} MB.",
                        )
                    destination.write(chunk)
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise
        if size == 0:
            temp_path.unlink(missing_ok=True)
            raise ApiError(422, "empty_file", "The uploaded file is empty.")
        return temp_path, size
    finally:
        upload.file.close()


def store_photo(item_id: uuid.UUID, upload: UploadFile) -> StoredPhoto:
    return store_entity_photo("items", item_id, upload)


def store_entity_photo(
    owner_type: Literal["items", "rooms", "locations"],
    owner_id: uuid.UUID,
    upload: UploadFile,
) -> StoredPhoto:
    settings = get_settings()
    temp_path, size = _write_temp(upload, settings.max_upload_bytes)
    photo_id = uuid.uuid4()
    base_dir = _root() / owner_type / str(owner_id) / "photos"
    original_path: Path | None = None
    thumbnail_path: Path | None = None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            try:
                with _open_image(temp_path) as image:
                    image_format = image.format
                    width, height = image.size
                    image.verify()
            except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
                raise ApiError(
                    422, "invalid_image", "One of the files is not a valid image."
                ) from exc

        if image_format not in PHOTO_FORMATS:
            raise ApiError(
                422,
                "unsupported_image_type",
                "Photos must be JPEG, PNG, WebP, or HEIC files.",
            )
        if width < 1 or height < 1 or width * height > 40_000_000:
            raise ApiError(422, "image_dimensions", "The image dimensions are not supported.")

        normalized_heif = image_format in {"HEIF", "HEIC"}
        content_type = "image/jpeg" if normalized_heif else PHOTO_FORMATS[image_format][0]
        extension = "jpg" if normalized_heif else PHOTO_FORMATS[image_format][1]

        _mkdir_private(base_dir)
        original_path = base_dir / f"{photo_id}.{extension}"
        thumbnail_path = base_dir / f"{photo_id}.webp"

        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with _open_image(temp_path) as image:
                image = ImageOps.exif_transpose(image)
                if normalized_heif:
                    if image.mode not in ("RGB", "L"):
                        image = image.convert("RGB")
                    image.save(original_path, format="JPEG", quality=90, optimize=True)
                elif image_format == "JPEG":
                    if image.mode not in ("RGB", "L", "CMYK"):
                        image = image.convert("RGB")
                    image.save(original_path, format="JPEG", quality=90, optimize=True)
                elif image_format == "PNG":
                    image.save(original_path, format="PNG", optimize=True)
                else:
                    image.save(original_path, format="WEBP", quality=90, method=4)

                thumb = image.copy()
                thumb.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
                if thumb.mode not in ("RGB", "RGBA"):
                    thumb = thumb.convert("RGBA")
                thumb.save(thumbnail_path, format="WEBP", quality=82, method=4)

        _chmod_file(original_path)
        _chmod_file(thumbnail_path)
        final_size = original_path.stat().st_size
        relative_original = original_path.relative_to(_root()).as_posix()
        relative_thumbnail = thumbnail_path.relative_to(_root()).as_posix()
        return StoredPhoto(
            storage_key=relative_original,
            thumbnail_key=relative_thumbnail,
            original_filename=_safe_filename(upload.filename),
            content_type=content_type,
            byte_size=final_size or size,
            width=width,
            height=height,
        )
    except Exception:
        if original_path:
            original_path.unlink(missing_ok=True)
        if thumbnail_path:
            thumbnail_path.unlink(missing_ok=True)
        raise
    finally:
        temp_path.unlink(missing_ok=True)


def _validate_pdf(path: Path) -> None:
    try:
        reader = PdfReader(str(path), strict=False)
        if reader.is_encrypted:
            raise ApiError(
                422,
                "encrypted_document",
                "Encrypted PDFs are not supported. Upload an unlocked copy.",
            )
        if len(reader.pages) < 1:
            raise ApiError(422, "invalid_document", "This PDF contains no pages.")
    except ApiError:
        raise
    except Exception as exc:  # pypdf raises several parser-specific exceptions
        raise ApiError(422, "invalid_document", "This PDF file appears to be invalid.") from exc


def _normalize_document_image(
    temp_path: Path,
    destination_dir: Path,
    document_id: uuid.UUID,
    original_filename: str | None,
) -> tuple[Path, str, str]:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with _open_image(temp_path) as image:
                image_format = image.format
                width, height = image.size
                image.verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ApiError(
            422, "invalid_document", "This image document appears to be invalid."
        ) from exc

    if image_format not in PHOTO_FORMATS:
        raise ApiError(
            422,
            "unsupported_document_type",
            "Document images must be JPEG, PNG, WebP, or HEIC files.",
        )
    if width < 1 or height < 1 or width * height > 40_000_000:
        raise ApiError(422, "image_dimensions", "The image dimensions are not supported.")

    _mkdir_private(destination_dir)
    if image_format in {"HEIF", "HEIC"}:
        extension, content_type = "jpg", "image/jpeg"
    else:
        extension, content_type = PHOTO_FORMATS[image_format][1], PHOTO_FORMATS[image_format][0]

    destination = destination_dir / f"{document_id}.{extension}"
    original_content_type = PHOTO_FORMATS[image_format][0]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with _open_image(temp_path) as image:
                image = ImageOps.exif_transpose(image)
                if content_type == "image/jpeg":
                    if image.mode not in ("RGB", "L", "CMYK"):
                        image = image.convert("RGB")
                    image.save(destination, format="JPEG", quality=90, optimize=True)
                elif image_format == "PNG":
                    image.save(destination, format="PNG", optimize=True)
                else:
                    image.save(destination, format="WEBP", quality=90, method=4)
        _chmod_file(destination)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return (
        destination,
        content_type,
        original_content_type,
        _filename_with_extension(original_filename, extension),
    )


def store_document(household_id: uuid.UUID, upload: UploadFile) -> StoredDocument:
    settings = get_settings()
    declared_type = (upload.content_type or "").split(";", 1)[0].strip().lower()
    if declared_type not in DOCUMENT_TYPES:
        raise ApiError(
            422,
            "unsupported_document_type",
            "Documents must be PDF, JPEG, PNG, WebP, or plain text files.",
        )

    temp_path, size = _write_temp(upload, settings.max_upload_bytes)
    document_id = uuid.uuid4()
    extension = DOCUMENT_TYPES[declared_type]
    documents_dir = _root() / "households" / str(household_id) / "documents"
    destination_dir = documents_dir
    destination = destination_dir / f"{document_id}{extension}"
    originals_dir = documents_dir / "originals"
    original_destination = originals_dir / f"{document_id}{extension}"
    try:
        # Preserve the exact uploaded bytes before any validation, conversion or
        # EXIF stripping. The normalized copy remains the default download.
        _mkdir_private(originals_dir)
        shutil.copyfile(temp_path, original_destination)
        _chmod_file(original_destination)

        if extension == ".pdf":
            _validate_pdf(temp_path)
        elif extension == ".txt":
            try:
                temp_path.read_text(encoding="utf-8")
            except UnicodeDecodeError as exc:
                raise ApiError(
                    422, "invalid_document", "Text documents must be UTF-8 encoded."
                ) from exc
        else:
            (
                destination,
                declared_type,
                original_content_type,
                original_filename,
            ) = _normalize_document_image(
                temp_path,
                destination_dir,
                document_id,
                upload.filename,
            )
            return StoredDocument(
                storage_key=destination.relative_to(_root()).as_posix(),
                original_storage_key=original_destination.relative_to(_root()).as_posix(),
                original_filename=original_filename,
                content_type=declared_type,
                original_content_type=original_content_type,
                byte_size=destination.stat().st_size,
                original_byte_size=size,
            )

        _mkdir_private(destination_dir)
        os.replace(temp_path, destination)
        _chmod_file(destination)
        return StoredDocument(
            storage_key=destination.relative_to(_root()).as_posix(),
            original_storage_key=original_destination.relative_to(_root()).as_posix(),
            original_filename=_safe_filename(upload.filename),
            content_type=declared_type,
            original_content_type=declared_type,
            byte_size=size,
            original_byte_size=size,
        )
    except Exception:
        destination.unlink(missing_ok=True)
        original_destination.unlink(missing_ok=True)
        raise
    finally:
        temp_path.unlink(missing_ok=True)


def resolve_key(storage_key: str) -> Path:
    # Read paths must not mutate the upload directory: the worker mounts it
    # read-only and only needs to resolve files for OCR.
    root = _root_path().resolve()
    path = (root / storage_key).resolve()
    if root not in path.parents and path != root:
        raise ApiError(404, "file_not_found", "File not found.")
    if not path.is_file():
        raise ApiError(404, "file_not_found", "File not found.")
    return path


def _scan_dir(household_id: uuid.UUID, scan_id: uuid.UUID) -> Path:
    return _root() / "households" / str(household_id) / "documents" / "scans" / str(scan_id)


def store_scan_page_original(
    household_id: uuid.UUID,
    scan_id: uuid.UUID,
    page_id: uuid.UUID,
    upload: UploadFile,
) -> StoredScanPageOriginal:
    settings = get_settings()
    declared_type = (upload.content_type or "").split(";", 1)[0].strip().lower()
    if declared_type not in SCAN_IMAGE_TYPES:
        raise ApiError(
            422,
            "unsupported_scan_page",
            "Scan pages must be JPEG, PNG, WebP, HEIC or HEIF images.",
        )

    temp_path, size = _write_temp(upload, settings.max_upload_bytes)
    original_dir = _scan_dir(household_id, scan_id) / "originals"
    destination: Path | None = None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            try:
                with _open_image(temp_path) as image:
                    image_format = image.format
                    image.verify()
                with _open_image(temp_path) as image:
                    oriented = ImageOps.exif_transpose(image)
                    width, height = oriented.size
            except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
                raise ApiError(
                    422,
                    "invalid_scan_page",
                    "This file is not a readable scan page image.",
                ) from exc
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise

    if image_format not in PHOTO_FORMATS:
        temp_path.unlink(missing_ok=True)
        raise ApiError(
            422,
            "unsupported_scan_page",
            "Scan pages must be JPEG, PNG, WebP, HEIC or HEIF images.",
        )
    if width < 1 or height < 1 or width * height > 40_000_000:
        temp_path.unlink(missing_ok=True)
        raise ApiError(422, "scan_page_dimensions", "The scan page dimensions are not supported.")

    content_type, extension = PHOTO_FORMATS[image_format]
    try:
        _mkdir_private(original_dir)
        destination = original_dir / f"{page_id}.{extension}"
        shutil.copyfile(temp_path, destination)
        _chmod_file(destination)
        return StoredScanPageOriginal(
            storage_key=destination.relative_to(_root()).as_posix(),
            original_filename=_safe_filename(upload.filename),
            content_type=content_type,
            byte_size=destination.stat().st_size,
            width=width,
            height=height,
        )
    except Exception:
        if destination is not None:
            destination.unlink(missing_ok=True)
        raise
    finally:
        temp_path.unlink(missing_ok=True)


def save_scan_cleaned(
    household_id: uuid.UUID,
    scan_id: uuid.UUID,
    page_id: uuid.UUID,
    image: Image.Image,
) -> tuple[str, str, int, int, int]:
    cleaned_dir = _scan_dir(household_id, scan_id) / "cleaned"
    _mkdir_private(cleaned_dir)
    destination = cleaned_dir / f"{page_id}.jpg"
    fd, temp_name = tempfile.mkstemp(prefix="cleaned-", suffix=".jpg", dir=cleaned_dir)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as output:
            image.convert("RGB").save(
                output,
                format="JPEG",
                quality=86,
                optimize=True,
                progressive=True,
            )
        _chmod_file(temp_path)
        os.replace(temp_path, destination)
        _chmod_file(destination)
        return (
            destination.relative_to(_root()).as_posix(),
            "image/jpeg",
            destination.stat().st_size,
            image.width,
            image.height,
        )
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def write_document_pdf(
    household_id: uuid.UUID,
    document_id: uuid.UUID,
    data: bytes,
    *,
    original: bool = False,
) -> tuple[str, int]:
    documents_dir = _root() / "households" / str(household_id) / "documents"
    destination_dir = documents_dir / "originals" if original else documents_dir
    _mkdir_private(destination_dir)
    destination = destination_dir / f"{document_id}.pdf"
    fd, temp_name = tempfile.mkstemp(prefix="pdf-", suffix=".pdf", dir=destination_dir)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
        _chmod_file(temp_path)
        os.replace(temp_path, destination)
        _chmod_file(destination)
        return destination.relative_to(_root()).as_posix(), len(data)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def file_sha256(storage_key: str) -> str:
    digest = hashlib.sha256()
    with resolve_key(storage_key).open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_import_key(storage_key: str) -> Path:
    root = _import_root_path().resolve()
    path = (root / storage_key).resolve()
    if root not in path.parents and path != root:
        raise ApiError(404, "file_not_found", "File not found.")
    if not path.is_file():
        raise ApiError(404, "file_not_found", "File not found.")
    return path


def delete_import_key(storage_key: str | None) -> None:
    if not storage_key:
        return
    try:
        path = resolve_import_key(storage_key)
    except ApiError:
        return
    path.unlink(missing_ok=True)
    for parent in (path.parent, path.parent.parent):
        try:
            if parent != _import_root() and parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()
        except OSError:
            break


def delete_key(storage_key: str | None) -> None:
    if not storage_key:
        return
    try:
        path = resolve_key(storage_key)
    except ApiError:
        return
    path.unlink(missing_ok=True)
    # Clean up empty item directories without failing the request.
    for parent in (path.parent, path.parent.parent):
        try:
            if parent != _root() and parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()
        except OSError:
            break


def store_import_source(
    household_id: uuid.UUID, batch_id: uuid.UUID, upload: UploadFile
) -> StoredImportFile:
    settings = get_settings()
    temp_path, size = _write_temp(upload, settings.max_upload_bytes)
    base_dir = (
        _import_root() / "households" / str(household_id) / "imports" / str(batch_id) / "source"
    )
    destination = base_dir / f"{uuid.uuid4().hex}-{_safe_filename(upload.filename)}"
    try:
        _mkdir_private(base_dir)
        # Uploads staging and import storage are separate Docker volumes, so a
        # rename can cross devices. Copy the preserved bytes instead.
        shutil.copyfile(temp_path, destination)
        _chmod_file(destination)
        return StoredImportFile(
            storage_key=destination.relative_to(_import_root()).as_posix(),
            original_filename=_safe_filename(upload.filename),
            content_type=(upload.content_type or "application/octet-stream").split(";", 1)[0],
            byte_size=size,
        )
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        temp_path.unlink(missing_ok=True)


def store_import_text(household_id: uuid.UUID, batch_id: uuid.UUID, text: str) -> StoredImportFile:
    data = text.encode("utf-8")
    if not data:
        raise ApiError(422, "empty_import", "Paste some text before importing.")
    return store_import_file(
        household_id,
        batch_id,
        "pasted-notes.txt",
        data,
        "text/plain",
        kind_dir="source",
    )


def store_import_file(
    household_id: uuid.UUID,
    batch_id: uuid.UUID,
    relative_path: str,
    data: bytes,
    content_type: str,
    *,
    kind_dir: str = "files",
) -> StoredImportFile:
    if not data:
        raise ApiError(422, "empty_import", "The import contains an empty file.")
    safe_name = _safe_filename(relative_path)
    base_dir = (
        _import_root() / "households" / str(household_id) / "imports" / str(batch_id) / kind_dir
    )
    destination = base_dir / f"{uuid.uuid4().hex}-{safe_name}"
    _mkdir_private(base_dir)
    try:
        with destination.open("wb") as handle:
            handle.write(data)
        _chmod_file(destination)
        return StoredImportFile(
            storage_key=destination.relative_to(_import_root()).as_posix(),
            original_filename=safe_name,
            content_type=content_type,
            byte_size=len(data),
        )
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def store_ai_image(household_id: uuid.UUID, upload: UploadFile) -> StoredAiImage:
    settings = get_settings()
    temp_path, size = _write_temp(upload, settings.max_upload_bytes)
    image_id = uuid.uuid4()
    base_dir = _root() / "households" / str(household_id) / "ai" / "images"
    original_destination = (
        base_dir
        / "originals"
        / f"{image_id}{PurePosixPath(_safe_filename(upload.filename)).suffix or '.img'}"
    )
    normalized_path: Path | None = None
    try:
        _mkdir_private(original_destination.parent)
        shutil.copyfile(temp_path, original_destination)
        _chmod_file(original_destination)
        normalized_path, content_type, original_content_type, normalized_name = (
            _normalize_document_image(temp_path, base_dir, image_id, upload.filename)
        )
        with _open_image(normalized_path) as image:
            width, height = image.size
        return StoredAiImage(
            storage_key=normalized_path.relative_to(_root()).as_posix(),
            original_storage_key=original_destination.relative_to(_root()).as_posix(),
            original_filename=normalized_name,
            content_type=content_type,
            original_content_type=original_content_type,
            byte_size=normalized_path.stat().st_size,
            original_byte_size=size,
            width=width,
            height=height,
        )
    except Exception:
        if normalized_path is not None:
            normalized_path.unlink(missing_ok=True)
        original_destination.unlink(missing_ok=True)
        raise
    finally:
        temp_path.unlink(missing_ok=True)


VOICE_AUDIO_TYPES = {
    "webm": ("audio/webm", ".webm"),
    "ogg": ("audio/ogg", ".ogg"),
    "wav": ("audio/wav", ".wav"),
    "mp3": ("audio/mpeg", ".mp3"),
    "mp4": ("audio/mp4", ".m4a"),
}


def _sniff_audio(temp_path: Path) -> tuple[str, str]:
    with temp_path.open("rb") as source:
        header = source.read(32)
    if header.startswith(b"\x1aE\xdf\xa3"):
        return VOICE_AUDIO_TYPES["webm"]
    if header.startswith(b"OggS"):
        return VOICE_AUDIO_TYPES["ogg"]
    if header[:4] == b"RIFF" and header[8:12] == b"WAVE":
        return VOICE_AUDIO_TYPES["wav"]
    if header.startswith(b"ID3") or (
        len(header) >= 2 and header[0] == 0xFF and header[1] & 0xE0 == 0xE0
    ):
        return VOICE_AUDIO_TYPES["mp3"]
    if len(header) >= 12 and header[4:8] == b"ftyp":
        return VOICE_AUDIO_TYPES["mp4"]
    raise ApiError(
        422,
        "unsupported_audio_type",
        "Use a WebM, Ogg, WAV, MP3 or M4A audio file.",
    )


def store_voice_audio(
    household_id: uuid.UUID, voice_note_id: uuid.UUID, upload: UploadFile
) -> StoredImportFile:
    settings = get_settings()
    temp_path, size = _write_temp(upload, settings.voice_max_upload_bytes)
    try:
        content_type, extension = _sniff_audio(temp_path)
        safe_name = _filename_with_extension(upload.filename, extension)
        base_dir = (
            _import_root()
            / "households"
            / str(household_id)
            / "voice"
            / str(voice_note_id)
            / "source"
        )
        destination = base_dir / f"{uuid.uuid4().hex}-{safe_name}"
        _mkdir_private(base_dir)
        shutil.copyfile(temp_path, destination)
        _chmod_file(destination)
        return StoredImportFile(
            storage_key=destination.relative_to(_import_root()).as_posix(),
            original_filename=safe_name,
            content_type=content_type,
            byte_size=size,
        )
    except Exception:
        if "destination" in locals():
            destination.unlink(missing_ok=True)
        raise
    finally:
        temp_path.unlink(missing_ok=True)
