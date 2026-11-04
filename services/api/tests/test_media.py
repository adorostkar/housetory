import io
import os
import stat

from PIL import Image
from pillow_heif import register_heif_opener

register_heif_opener()


def heic_bytes(size=(400, 300)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, (90, 110, 85)).save(buffer, format="HEIF", quality=80)
    return buffer.getvalue()


def jpeg_bytes(color=(120, 90, 60), size=(900, 700)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="JPEG", quality=90)
    return buffer.getvalue()


def png_bytes(size=(64, 48)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", size, (200, 150, 100, 255)).save(buffer, format="PNG")
    return buffer.getvalue()


def jpeg_with_exif() -> bytes:
    buffer = io.BytesIO()
    image = Image.new("RGB", (320, 240), (100, 90, 80))
    exif = Image.Exif()
    exif[0x010F] = "Sensitive Camera Make"
    exif[0x0110] = "Sensitive Camera Model"
    image.save(buffer, format="JPEG", quality=90, exif=exif)
    return buffer.getvalue()


def create_item(client) -> dict:
    response = client.post("/api/v1/items", json={"name": "Camera"})
    assert response.status_code == 201, response.text
    return response.json()["item"]


def test_upload_multiple_photos_and_serve(owner_client, anon_client):
    item = create_item(owner_client)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/photos",
        files=[
            ("files", ("front.jpg", jpeg_bytes(), "image/jpeg")),
            ("files", ("back.png", png_bytes(), "image/png")),
        ],
    )
    assert response.status_code == 201, response.text
    photos = response.json()["items"]
    assert len(photos) == 2
    assert photos[0]["width"] == 900
    assert photos[0]["height"] == 700
    assert photos[0]["content_type"] == "image/jpeg"
    assert photos[0]["url"].startswith("/api/v1/photos/")

    detail = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert len(detail["photos"]) == 2
    assert detail["primary_photo"]["id"] == photos[0]["id"]

    file_response = owner_client.get(photos[0]["url"])
    assert file_response.status_code == 200
    assert file_response.headers["content-type"] == "image/jpeg"
    assert file_response.headers["cache-control"] == "private, no-store"
    assert file_response.headers["cross-origin-resource-policy"] == "same-origin"

    thumb_response = owner_client.get(photos[0]["thumbnail_url"])
    assert thumb_response.status_code == 200
    assert thumb_response.headers["content-type"] == "image/webp"
    assert thumb_response.headers["cache-control"] == "private, no-store"
    assert thumb_response.content[:4] == b"RIFF"

    # Another signed-out client cannot read the image even with the UUID.
    assert anon_client.get(photos[0]["url"]).status_code == 401
    assert anon_client.get(photos[0]["thumbnail_url"]).status_code == 401

    deletion = owner_client.delete(f"/api/v1/photos/{photos[0]['id']}")
    assert deletion.status_code == 204
    assert owner_client.get(photos[0]["url"]).status_code == 404
    remaining = owner_client.get(f"/api/v1/items/{item['id']}/photos").json()["items"]
    assert len(remaining) == 1


def test_invalid_photo_is_rejected_without_orphans(owner_client):
    item = create_item(owner_client)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/photos",
        files=[("files", ("not-an-image.jpg", b"this is not an image", "image/jpeg"))],
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_image"
    assert owner_client.get(f"/api/v1/items/{item['id']}/photos").json()["items"] == []


def test_set_cover_photo_reorders_gallery(owner_client, anon_client):
    item = create_item(owner_client)
    uploaded = owner_client.post(
        f"/api/v1/items/{item['id']}/photos",
        files=[
            ("files", ("one.jpg", jpeg_bytes((10, 20, 30)), "image/jpeg")),
            ("files", ("two.jpg", jpeg_bytes((40, 50, 60)), "image/jpeg")),
            ("files", ("three.jpg", jpeg_bytes((70, 80, 90)), "image/jpeg")),
        ],
    ).json()["items"]
    assert [photo["sort_order"] for photo in uploaded] == [0, 1, 2]

    response = owner_client.post(f"/api/v1/items/{item['id']}/photos/{uploaded[2]['id']}/primary")
    assert response.status_code == 200, response.text
    reordered = response.json()["items"]
    assert reordered[0]["id"] == uploaded[2]["id"]
    assert [photo["sort_order"] for photo in reordered] == [0, 1, 2]

    detail = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert detail["primary_photo"]["id"] == uploaded[2]["id"]
    assert [photo["id"] for photo in detail["photos"]][0] == uploaded[2]["id"]

    explicit = owner_client.put(
        f"/api/v1/items/{item['id']}/photos/order",
        json={
            "photo_ids": [
                uploaded[1]["id"],
                uploaded[0]["id"],
                uploaded[2]["id"],
            ]
        },
    )
    assert explicit.status_code == 200, explicit.text
    assert [photo["id"] for photo in explicit.json()["items"]] == [
        uploaded[1]["id"],
        uploaded[0]["id"],
        uploaded[2]["id"],
    ]
    assert [photo["sort_order"] for photo in explicit.json()["items"]] == [0, 1, 2]
    detail = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert detail["primary_photo"]["id"] == uploaded[1]["id"]

    assert (
        anon_client.post(
            f"/api/v1/items/{item['id']}/photos/{uploaded[0]['id']}/primary"
        ).status_code
        == 401
    )


def test_cover_photo_must_belong_to_item(owner_client):
    first = create_item(owner_client)
    second = create_item(owner_client)
    photo = owner_client.post(
        f"/api/v1/items/{first['id']}/photos",
        files=[("files", ("one.jpg", jpeg_bytes(), "image/jpeg"))],
    ).json()["items"][0]
    response = owner_client.post(f"/api/v1/items/{second['id']}/photos/{photo['id']}/primary")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "photo_not_found"


def test_document_upload_download_and_delete(owner_client, anon_client, pdf_bytes):
    item = create_item(owner_client)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/documents",
        files={"file": ("receipt.pdf", pdf_bytes, "application/pdf")},
        data={"title": "Purchase receipt"},
    )
    assert response.status_code == 201, response.text
    document = response.json()
    assert document["title"] == "Purchase receipt"
    assert document["content_type"] == "application/pdf"
    assert document["byte_size"] == len(pdf_bytes)

    detail = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert detail["documents"][0]["id"] == document["id"]

    file_response = owner_client.get(document["url"])
    assert file_response.status_code == 200
    assert file_response.content == pdf_bytes
    assert file_response.headers["content-disposition"].startswith("attachment")
    assert file_response.headers["cache-control"] == "private, no-store"
    assert anon_client.get(document["url"]).status_code == 401

    listing = owner_client.get("/api/v1/documents", params={"item_id": item["id"]}).json()["items"]
    assert len(listing) == 1

    assert owner_client.delete(f"/api/v1/documents/{document['id']}").status_code == 204
    assert owner_client.get(document["url"]).status_code == 404
    overview = owner_client.get("/api/v1/overview").json()
    assert overview["document_count"] == 0


def test_malformed_pdf_is_rejected(owner_client):
    item = create_item(owner_client)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/documents",
        files={
            "file": (
                "broken.pdf",
                b"%PDF-1.4\nthis is only a header, not a real document\n%%EOF\n",
                "application/pdf",
            )
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_document"
    assert owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]["documents"] == []


def test_photo_filename_cannot_traverse(owner_client):
    item = create_item(owner_client)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/photos",
        files=[("files", ("../../private/image.jpg", jpeg_bytes(), "image/jpeg"))],
    )
    assert response.status_code == 201, response.text
    filename = response.json()["items"][0]["original_filename"]
    assert filename == "image.jpg"
    assert ".." not in filename
    assert "/" not in filename


def test_document_filename_cannot_traverse(owner_client, pdf_bytes):
    item = create_item(owner_client)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/documents",
        files={"file": ("../../private/receipt.pdf", pdf_bytes, "application/pdf")},
    )
    assert response.status_code == 201, response.text
    filename = response.json()["original_filename"]
    assert filename == "receipt.pdf"
    assert ".." not in filename
    assert "/" not in filename
    headers = owner_client.get(response.json()["url"]).headers
    assert 'filename="receipt.pdf"' in headers["content-disposition"]


def test_exif_metadata_is_stripped_from_photos(owner_client):
    item = create_item(owner_client)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/photos",
        files=[("files", ("camera.jpg", jpeg_with_exif(), "image/jpeg"))],
    )
    assert response.status_code == 201, response.text
    photo = response.json()["items"][0]
    stored = Image.open(io.BytesIO(owner_client.get(photo["url"]).content))
    exif = stored.getexif()
    assert 0x010F not in exif
    assert 0x0110 not in exif


def test_document_images_are_normalized_and_exif_stripped(owner_client):
    item = create_item(owner_client)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/documents",
        files={"file": ("receipt.png", jpeg_with_exif(), "image/png")},
    )
    assert response.status_code == 201, response.text
    document = response.json()
    assert document["content_type"] == "image/jpeg"
    assert document["original_filename"] == "receipt.jpg"
    stored = Image.open(io.BytesIO(owner_client.get(document["url"]).content))
    exif = stored.getexif()
    assert 0x010F not in exif
    assert 0x0110 not in exif


def test_upload_size_limit(owner_client, monkeypatch):
    from housetory_api.config import get_settings

    monkeypatch.setattr(get_settings(), "max_upload_mb", 1)
    item = create_item(owner_client)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/photos",
        files=[("files", ("large.jpg", b"x" * (1024 * 1024 + 1), "image/jpeg"))],
    )
    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "file_too_large"
    assert owner_client.get(f"/api/v1/items/{item['id']}/photos").json()["items"] == []


def test_uploaded_files_are_private(owner_client, upload_root):
    item = create_item(owner_client)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/photos",
        files=[("files", ("front.jpg", jpeg_bytes(), "image/jpeg"))],
    )
    assert response.status_code == 201, response.text
    photo = response.json()["items"][0]
    assert (
        owner_client.post(
            f"/api/v1/items/{item['id']}/documents",
            files={"file": ("note.txt", b"A plain text note", "text/plain")},
        ).status_code
        == 201
    )

    files = [path for path in upload_root.rglob("*") if path.is_file()]
    assert files
    assert all(stat.S_IMODE(os.stat(path).st_mode) == 0o600 for path in files)
    assert stat.S_IMODE(os.stat(upload_root).st_mode) == 0o700
    assert owner_client.get(photo["url"]).status_code == 200


def test_unsupported_document_type_is_rejected(owner_client):
    item = create_item(owner_client)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/documents",
        files={"file": ("malware.exe", b"MZ", "application/x-msdownload")},
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "unsupported_document_type"


def test_decodable_format_outside_allowlist_is_rejected(owner_client):
    item = create_item(owner_client)
    buffer = io.BytesIO()
    Image.new("RGB", (40, 30), (30, 60, 90)).save(buffer, format="GIF")
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/photos",
        files=[("files", ("photo.jpg", buffer.getvalue(), "image/jpeg"))],
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_image"


def test_heif_like_upload_is_validated_by_content(owner_client):
    item = create_item(owner_client)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/photos",
        files=[("files", ("photo.jpg", png_bytes(), "image/heic"))],
    )
    assert response.status_code == 201, response.text
    assert response.json()["items"][0]["content_type"] == "image/png"


def test_heic_photo_from_iphone_is_normalized_to_jpeg(owner_client):
    item = create_item(owner_client)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/photos",
        files=[("files", ("IMG_0001.HEIC", heic_bytes(), "image/heic"))],
    )
    assert response.status_code == 201, response.text
    photo = response.json()["items"][0]
    assert photo["content_type"] == "image/jpeg"
    assert photo["width"] == 400
    assert photo["height"] == 300

    original = owner_client.get(photo["url"])
    assert original.status_code == 200
    assert original.headers["content-type"] == "image/jpeg"
    assert owner_client.get(photo["thumbnail_url"]).status_code == 200
