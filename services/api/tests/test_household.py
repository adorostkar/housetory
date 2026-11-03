def test_household_can_be_renamed(owner_client):
    response = owner_client.patch("/api/v1/household", json={"name": "The Lovelace Home"})
    assert response.status_code == 200, response.text
    assert response.json()["name"] == "The Lovelace Home"

    session = owner_client.get("/api/v1/auth/session").json()
    assert session["household"]["name"] == "The Lovelace Home"

    empty = owner_client.patch("/api/v1/household", json={"name": "  "})
    assert empty.status_code == 422
