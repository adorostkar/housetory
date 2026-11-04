from fastapi import FastAPI
from fastapi.testclient import TestClient

from housetory_api.api.errors import install_exception_handlers


def test_internal_errors_do_not_leak_details():
    app = FastAPI()
    install_exception_handlers(app)

    @app.get("/explode")
    def explode():
        raise RuntimeError("postgresql://secret-user:secret-password@db/private")

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/explode")

    assert response.status_code == 500
    assert response.json()["detail"]["code"] == "internal_error"
    assert "secret" not in response.text
    assert "postgresql" not in response.text
    assert "Traceback" not in response.text
