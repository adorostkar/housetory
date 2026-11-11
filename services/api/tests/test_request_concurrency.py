import asyncio
import os
import socket
import subprocess
import sys
import time

import httpx2 as httpx
from sqlalchemy import text
from sqlalchemy.engine import make_url

from housetory_api.db import engine


def test_authenticated_burst_releases_connections_and_keeps_readiness(owner_client, tmp_path):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    application_name = f"request-concurrency-{port}"
    database_url = make_url(os.environ["DATABASE_URL"]).update_query_dict(
        {"application_name": application_name}
    )
    log = tmp_path / "server.log"
    with log.open("w") as output:
        server = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import uvicorn;"
                f"uvicorn.run('housetory_api.main:app',host='127.0.0.1',port={port},lifespan='off')",
            ],
            env={**os.environ, "DATABASE_URL": database_url.render_as_string(hide_password=False)},
            stdout=output,
            stderr=subprocess.STDOUT,
        )
        try:
            for _ in range(100):
                try:
                    if httpx.get(f"{origin}/api/v1/health/ready", timeout=1).status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                time.sleep(0.05)
            else:
                raise AssertionError(f"Server did not start:\n{log.read_text()}")

            async def burst():
                headers = {
                    "Cookie": f"housetory_session={owner_client.cookies.get('housetory_session')}",
                }
                async with httpx.AsyncClient(
                    base_url=origin,
                    headers=headers,
                    timeout=8,
                    limits=httpx.Limits(max_connections=80),
                ) as client:
                    paths = ["/auth/session", "/items", "/rooms", "/overview"]
                    for _ in range(4):
                        cancelled = [
                            asyncio.create_task(client.get(f"/api/v1{paths[i % len(paths)]}"))
                            for i in range(64)
                        ]
                        await asyncio.sleep(0.02)
                        for task in cancelled:
                            task.cancel()
                        await asyncio.gather(*cancelled, return_exceptions=True)
                        await asyncio.sleep(0.05)
                    responses = await asyncio.gather(
                        *[client.get(f"/api/v1{paths[i % len(paths)]}") for i in range(64)],
                        return_exceptions=True,
                    )
                    failures = [
                        type(response).__name__
                        if isinstance(response, BaseException)
                        else response.status_code
                        for response in responses
                        if isinstance(response, BaseException) or response.status_code != 200
                    ]
                    ready = await client.get("/api/v1/health/ready", timeout=3)
                    assert not failures, f"Authenticated burst failures: {failures}"
                    assert ready.status_code == 200
                    invalid = await client.get("/api/v1/items/not-a-uuid")
                    assert invalid.status_code == 422
                    unauthorized = await client.get("/api/v1/items", headers={"Cookie": ""})
                    assert unauthorized.status_code == 401

            asyncio.run(burst())
            for _ in range(50):
                with engine.connect() as connection:
                    retained = connection.scalar(
                        text(
                            "SELECT count(*) FROM pg_stat_activity "
                            "WHERE application_name = :name AND state = 'idle in transaction'"
                        ),
                        {"name": application_name},
                    )
                if retained == 0:
                    break
                time.sleep(0.02)
            assert retained == 0, "Completed requests retained database transactions"
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
