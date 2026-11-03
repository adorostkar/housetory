import os
import re
import shutil
import tempfile
import uuid
import warnings
from dataclasses import dataclass
from pathlib import Path

from fastapi import UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError

from ..api.errors import ApiError
from ..config import get_settings

try:  # HEIC support matters for photos taken on an iPhone.
    from pillow_heif import register_heif_opener

    register_heif_opener()
    HEIF_SUPPORTED = True
except ImportError:  # pragma: no cover - optional at runtime
    HEIF_SUPPORTED = False

Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)

PHOTO_FORMATS = {
    "JPEG": ("image/jpeg", "jpg"),
    "PNG": ("image/png", "png"),
    "WEBP": ("image/webp", "webp"),
    "HEIF": ("image/heic", "heic"),
    "HEIC": ("image/heic", "heic"),
}

DOCUMENT_TYPES = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
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
    original_filename: str
    content_type: str
    byte_size: int


def _root() -> Path:
    root = get_settings().resolved_uploads_dir
    root.mkdir(parents=True, exist_ok=True)
    return root


def ensure_storage() -> None:
    _root()


def _safe_filename(filename: str | None) -> str:
    candidate = (filename or "upload").replace("\\", "/").rsplit("/", 1)[-1]
    candidate = _SAFE_NAME.sub("_", candidate).strip(" .") or "upload"
    return candidate[:255]


def _write_temp(upload: UploadFile, max_bytes: int) -> tuple[Path, int]:
    root = _root()
    staging = root / ".staging"
    staging.mkdir(parents=True, exist_ok=True)
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
    settings = get_settings()
    temp_path, size = _write_temp(upload, settings.max_upload_bytes)
    photo_id = uuid.uuid4()
    base_dir = _root() / "items" / str(item_id) / "photos"
    original_path: Path | None = None
    thumbnail_path: Path | None = None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            try:
                with Image.open(temp_path) as image:
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

        base_dir.mkdir(parents=True, exist_ok=True)
        original_path = base_dir / f"{photo_id}.{extension}"
        thumbnail_path = base_dir / f"{photo_id}.webp"

        with Image.open(temp_path) as image:
            image = ImageOps.exif_transpose(image)
            if normalized_heif:
                if image.mode not in ("RGB", "L"):
                    image = image.convert("RGB")
                image.save(original_path, format="JPEG", quality=90, optimize=True)
            else:
                # Preserve the exact uploaded bytes for formats browsers can render.
                if image_format == "JPEG" and image.mode not in ("RGB", "L", "CMYK"):
                    image = image.convert("RGB")
                image.save(
                    original_path,
                    format="JPEG" if image_format == "JPEG" else image_format,
                    **({"quality": 90, "optimize": True} if image_format == "JPEG" else {}),
                )

            thumb = image.copy()
            thumb.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
            if thumb.mode not in ("RGB", "RGBA"):
                thumb = thumb.convert("RGBA")
            thumb.save(thumbnail_path, format="WEBP", quality=82, method=4)

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
    destination_dir = _root() / "households" / str(household_id) / "documents"
    destination = destination_dir / f"{document_id}{extension}"
    try:
        if extension == ".pdf":
            with temp_path.open("rb") as handle:
                if handle.read(5) != b"%PDF-":
                    raise ApiError(422, "invalid_document", "This PDF file appears to be invalid.")
        elif extension == ".txt":
            try:
                temp_path.read_text(encoding="utf-8")
            except UnicodeDecodeError as exc:
                raise ApiError(
                    422, "invalid_document", "Text documents must be UTF-8 encoded."
                ) from exc
        else:
            try:
                with Image.open(temp_path) as image:
                    image.verify()
            except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
                raise ApiError(
                    422, "invalid_document", "This image document appears to be invalid."
                ) from exc

        destination_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(temp_path, destination)
        return StoredDocument(
            storage_key=destination.relative_to(_root()).as_posix(),
            original_filename=_safe_filename(upload.filename),
            content_type=declared_type,
            byte_size=size,
        )
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        temp_path.unlink(missing_ok=True)


def resolve_key(storage_key: str) -> Path:
    root = _root().resolve()
    path = (root / storage_key).resolve()
    if root not in path.parents and path != root:
        raise ApiError(404, "file_not_found", "File not found.")
    if not path.is_file():
        raise ApiError(404, "file_not_found", "File not found.")
    return path


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
