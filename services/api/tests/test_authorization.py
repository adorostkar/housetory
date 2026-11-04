from datetime import UTC, datetime, timedelta

from housetory_api.config import get_settings
from housetory_api.db import SessionLocal
from housetory_api.models import Household, HouseholdMember, User
from housetory_api.security import generate_session_token, hash_session_token
from housetory_api.services.auth import create_session


def test_household_scoping_prevents_cross_account_access(owner_client, anon_client):
    own_room = owner_client.post("/api/v1/rooms", json={"name": "Private Room"}).json()
    own_item = owner_client.post("/api/v1/items", json={"name": "Private Item"}).json()["item"]

    with SessionLocal() as db:
        other_user = User(
            name="Grace Hopper",
            email="grace@example.com",
            password_hash="not-used-in-this-test",
        )
        other_household = Household(name="Grace's Home")
        db.add_all([other_user, other_household])
        db.flush()
        db.add(
            HouseholdMember(
                user_id=other_user.id,
                household_id=other_household.id,
                role="owner",
            )
        )
        token = create_session(
            db,
            user=other_user,
            settings=get_settings(),
            user_agent="test",
            ip_address="127.0.0.1",
        )
        db.commit()

    headers = {"Cookie": f"housetory_session={token}"}
    session = anon_client.get("/api/v1/auth/session", headers=headers).json()
    assert session["authenticated"] is True
    assert session["household"]["name"] == "Grace's Home"

    assert anon_client.get("/api/v1/rooms", headers=headers).json()["items"] == []
    room_response = anon_client.get(f"/api/v1/rooms/{own_room['id']}", headers=headers)
    assert room_response.status_code == 404
    item_response = anon_client.get(f"/api/v1/items/{own_item['id']}", headers=headers)
    assert item_response.status_code == 404
    overview = anon_client.get("/api/v1/overview", headers=headers).json()
    assert overview["room_count"] == 0
    assert overview["item_count"] == 0


def test_expired_session_is_not_accepted(owner_client, anon_client):
    with SessionLocal() as db:
        user = db.query(User).first()
        token = generate_session_token()
        from housetory_api.models import AuthSession

        db.add(
            AuthSession(
                user_id=user.id,
                token_hash=hash_session_token(token),
                expires_at=datetime.now(UTC) - timedelta(minutes=1),
                user_agent="test",
            )
        )
        db.commit()

    headers = {"Cookie": f"housetory_session={token}"}
    response = anon_client.get("/api/v1/overview", headers=headers)
    assert response.status_code == 401


def test_missing_membership_authenticates_account_but_not_household(owner_client, anon_client):
    with SessionLocal() as db:
        orphan = User(
            name="Orphan",
            email="orphan@example.com",
            password_hash="not-used",
        )
        db.add(orphan)
        db.flush()
        token = create_session(
            db,
            user=orphan,
            settings=get_settings(),
            user_agent="test",
            ip_address="127.0.0.1",
        )
        db.commit()

    headers = {"Cookie": f"housetory_session={token}"}
    state = anon_client.get("/api/v1/auth/session", headers=headers).json()
    assert state["authenticated"] is True
    assert state["user"]["email"] == "orphan@example.com"
    assert state["household"] is None
    assert state["role"] is None
    assert anon_client.get("/api/v1/overview", headers=headers).status_code == 401
