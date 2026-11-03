import io

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
    assert file_response.headers["cache-control"].startswith("private")

    thumb_response = owner_client.get(photos[0]["thumbnail_url"])
    assert thumb_response.status_code == 200
    assert thumb_response.headers["content-type"] == "image/webp"
    assert thumb_response.content[:4] == b"RIFF"

    # Another signed-out client cannot read the image even with the UUID.
    assert anon_client.get(photos[0]["url"]).status_code == 401

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


def test_document_upload_download_and_delete(owner_client):
    item = create_item(owner_client)
    pdf = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n"
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/documents",
        files={"file": ("receipt.pdf", pdf, "application/pdf")},
        data={"title": "Purchase receipt"},
    )
    assert response.status_code == 201, response.text
    document = response.json()
    assert document["title"] == "Purchase receipt"
    assert document["content_type"] == "application/pdf"
    assert document["byte_size"] == len(pdf)

    detail = owner_client.get(f"/api/v1/items/{item['id']}").json()["item"]
    assert detail["documents"][0]["id"] == document["id"]

    file_response = owner_client.get(document["url"])
    assert file_response.status_code == 200
    assert file_response.content == pdf
    assert file_response.headers["content-disposition"].startswith("inline")

    listing = owner_client.get("/api/v1/documents", params={"item_id": item["id"]}).json()["items"]
    assert len(listing) == 1

    assert owner_client.delete(f"/api/v1/documents/{document['id']}").status_code == 204
    assert owner_client.get(document["url"]).status_code == 404
    overview = owner_client.get("/api/v1/overview").json()
    assert overview["document_count"] == 0


def test_unsupported_document_type_is_rejected(owner_client):
    item = create_item(owner_client)
    response = owner_client.post(
        f"/api/v1/items/{item['id']}/documents",
        files={"file": ("malware.exe", b"MZ", "application/x-msdownload")},
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "unsupported_document_type"


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
