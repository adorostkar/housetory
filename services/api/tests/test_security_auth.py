import threading

import pytest
from starlette.responses import Response

from housetory_api.api.deps import clear_session_cookie, set_session_cookie
from housetory_api.config import Settings
from housetory_api.db import SessionLocal
from housetory_api.services.auth import count_users, create_user_with_household


def test_invalid_configuration_does_not_leak_environment(monkeypatch):
    from housetory_api.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("APP_BASE_URL", "https://housetory.example.ts.net")
    monkeypatch.setenv("COOKIE_SECURE", "false")
    try:
        with pytest.raises(RuntimeError) as error:
            get_settings()
        message = str(error.value)
        assert "COOKIE_SECURE" in message
        assert "postgresql" not in message
        assert "POSTGRES" not in message
    finally:
        get_settings.cache_clear()


def test_https_requires_secure_cookies():
    with pytest.raises(ValueError):
        Settings(app_base_url="https://housetory.example.ts.net", cookie_secure=False)

    settings = Settings(
        app_base_url="https://housetory.example.ts.net",
        cookie_secure=True,
        environment="production",
    )
    assert settings.cookie_secure is True


def test_production_rejects_remote_plain_http():
    with pytest.raises(ValueError):
        Settings(
            environment="production",
            app_base_url="http://housetory.example.ts.net",
            cookie_secure=False,
        )

    local = Settings(
        environment="production",
        app_base_url="http://localhost:8080",
        cookie_secure=False,
    )
    assert local.app_base_url == "http://localhost:8080"


def test_production_rejects_debug():
    with pytest.raises(ValueError):
        Settings(
            environment="production",
            app_base_url="http://localhost:8080",
            cookie_secure=False,
            debug=True,
        )


def test_secure_cookie_attributes():
    settings = Settings(
        app_base_url="https://housetory.example.ts.net",
        cookie_secure=True,
        environment="production",
    )
    response = Response()
    set_session_cookie(response, "token-value", settings)
    header = response.headers["set-cookie"].lower()
    assert "httponly" in header
    assert "secure" in header
    assert "samesite=lax" in header

    cleared = Response()
    clear_session_cookie(cleared, settings)
    cleared_header = cleared.headers["set-cookie"].lower()
    assert "secure" in cleared_header
    assert "httponly" in cleared_header


def test_concurrent_first_run_setup_has_one_winner():
    barrier = threading.Barrier(2)
    results: list[str] = []
    errors: list[BaseException] = []

    def attempt() -> None:
        try:
            with SessionLocal() as db:
                barrier.wait(timeout=5)
                create_user_with_household(
                    db,
                    name="Concurrent Owner",
                    email="concurrent@example.com",
                    password="concurrent-password-123",
                    household_name="Concurrent Home",
                )
                db.commit()
                results.append("ok")
        except ValueError:
            results.append("conflict")
        except BaseException as exc:  # surfaced below for a useful failure
            errors.append(exc)

    threads = [threading.Thread(target=attempt) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)

    assert not errors
    assert sorted(results) == ["conflict", "ok"]
    with SessionLocal() as db:
        assert count_users(db) == 1
