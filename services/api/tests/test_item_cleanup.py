def test_deleting_item_removes_exclusive_photos_and_documents(owner_client):
    from io import BytesIO

    from PIL import Image

    item = owner_client.post("/api/v1/items", json={"name": "Old Printer"}).json()["item"]
    buffer = BytesIO()
    Image.new("RGB", (100, 80), (120, 100, 80)).save(buffer, format="JPEG")
    photo_response = owner_client.post(
        f"/api/v1/items/{item['id']}/photos",
        files=[("files", ("printer.jpg", buffer.getvalue(), "image/jpeg"))],
    )
    assert photo_response.status_code == 201
    photo = photo_response.json()["items"][0]

    document_response = owner_client.post(
        f"/api/v1/items/{item['id']}/documents",
        files={"file": ("manual.pdf", b"%PDF-1.4\n%%EOF\n", "application/pdf")},
        data={"title": "Printer manual"},
    )
    assert document_response.status_code == 201
    document = document_response.json()

    assert owner_client.delete(f"/api/v1/items/{item['id']}").status_code == 204
    assert owner_client.get(f"/api/v1/photos/{photo['id']}/file").status_code == 404
    assert owner_client.get(f"/api/v1/documents/{document['id']}/file").status_code == 404
    assert owner_client.get("/api/v1/overview").json()["document_count"] == 0
