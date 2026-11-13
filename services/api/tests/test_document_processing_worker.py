import contextlib
import json
import multiprocessing
import os
import signal
import subprocess
import sys
import threading
import time
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))

import housetory_worker  # noqa: E402

from housetory_api.db import SessionLocal
from housetory_api.jobs import claim_job, enqueue
from housetory_api.models import Document, Job
from housetory_api.services import ai
from housetory_api.services.document_ocr import OCR_TASK


def test_expired_interactive_job_fails_without_starting_a_handler():
    with SessionLocal() as db:
        job = enqueue(
            db,
            "documents.ocr",
            {
                "document_id": "00000000-0000-0000-0000-000000000001",
                "household_id": "00000000-0000-0000-0000-000000000002",
                "correlation_id": "expired-correlation",
                "mode": "interactive",
                "deadline_at": (datetime.now(UTC) - timedelta(seconds=1)).isoformat(),
            },
            queue="documents",
            max_attempts=1,
        )
        claimed = claim_job(db, worker_id="test-documents", queue="documents")
        assert claimed is not None
        assert claimed.id == job.id

    housetory_worker.process_interactive_job(claimed)

    with SessionLocal() as db:
        stored = db.get(Job, job.id)
        assert stored.status == "failed"
        assert stored.last_error == "interactive_deadline_exceeded"


def test_stalled_interactive_handler_is_terminated_at_deadline(owner_client):
    uploaded = owner_client.post(
        "/api/v1/documents",
        files={"file": ("receipt.txt", b"receipt", "text/plain")},
        data={"document_type": "invoice"},
    )
    assert uploaded.status_code == 201, uploaded.text
    document_id = uploaded.json()["id"]

    with SessionLocal() as db:
        job = db.scalar(
            select(Job).where(
                Job.task == OCR_TASK,
                Job.payload["document_id"].astext == document_id,
            )
        )
        payload = dict(job.payload)
        payload["deadline_at"] = (datetime.now(UTC) + timedelta(seconds=0.25)).isoformat()
        job.payload = payload
        db.commit()
        claimed = claim_job(db, worker_id="test-documents", queue="documents")
        assert claimed is not None
        job_id = claimed.id

    housetory_worker.process_interactive_job(
        claimed,
        process_target=time.sleep,
        process_args=(2,),
    )

    with SessionLocal() as db:
        stored_job = db.get(Job, job_id)
        assert stored_job.status == "failed"
        assert stored_job.last_error == "interactive_deadline_exceeded"
    status = owner_client.get(f"/api/v1/documents/{document_id}/processing").json()
    assert status["stage"] == "failed"
    assert status["reason"] == "deadline_exceeded"


@pytest.mark.parametrize(
    "mode,queue,max_attempts,task",
    [
        ("interactive", "documents", 1, OCR_TASK),
        ("background", "default", 3, OCR_TASK),
        ("interactive", "ai-documents", 1, "ai.enrich"),
    ],
)
@pytest.mark.parametrize("failure_point", ["construct", "start"])
def test_child_start_failure_fails_claimed_document_job(
    owner_client, mode, queue, max_attempts, task, failure_point
):
    uploaded = owner_client.post(
        "/api/v1/documents",
        files={"file": ("receipt.txt", b"receipt", "text/plain")},
        data={"document_type": "invoice"},
    )
    document_id = uploaded.json()["id"]
    with SessionLocal() as db:
        job = db.scalar(select(Job).where(Job.payload["document_id"].astext == document_id))
        job.queue = queue
        job.task = task
        job.payload = {**job.payload, "mode": mode}
        job.max_attempts = max_attempts
        db.commit()
        claimed = claim_job(db, worker_id="test-documents", queue=queue)
        assert claimed is not None
        job_id = claimed.id

    class BrokenProcess:
        pid = None

        def start(self):
            raise OSError("synthetic start failure")

        def is_alive(self):
            return False

    class BrokenContext:
        def Process(self, **kwargs):
            if failure_point == "construct":
                raise OSError("synthetic construction failure")
            return BrokenProcess()

    housetory_worker.process_interactive_job(claimed, process_context=BrokenContext())
    with SessionLocal() as db:
        stored_job = db.get(Job, job_id)
        assert stored_job.status == "failed"
        assert stored_job.last_error == "interactive_worker_interrupted"
    status = owner_client.get(f"/api/v1/documents/{document_id}/processing").json()
    assert status["stage"] == "failed"
    assert status["reason"] == "worker_interrupted"


def test_worker_handler_failure_updates_document_processing(owner_client):
    uploaded = owner_client.post(
        "/api/v1/documents",
        files={"file": ("receipt.txt", b"receipt", "text/plain")},
        data={"document_type": "invoice"},
    )
    document_id = uploaded.json()["id"]
    with SessionLocal() as db:
        job = db.scalar(select(Job).where(Job.payload["document_id"].astext == document_id))
        job.task = "synthetic.unknown"
        db.commit()
        claimed = claim_job(db, worker_id="test-documents", queue="documents")
    housetory_worker.process_interactive_job(claimed)
    status = owner_client.get(f"/api/v1/documents/{document_id}/processing").json()
    assert status["stage"] == "failed"
    assert status["reason"] == "worker_interrupted"


def _wait_for(predicate, *, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.03)
    return None


def _process_exists(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def _children_of(parent_pid):
    output = subprocess.check_output(["ps", "-ax", "-o", "pid=", "-o", "ppid="], text=True)
    return [
        int(pid)
        for line in output.splitlines()
        if len(parts := line.split()) == 2
        for pid, ppid in [parts]
        if int(ppid) == parent_pid
    ]


def _start_ocr_descendant_and_wait(pid_file):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    Path(pid_file).write_text(str(child.pid))
    time.sleep(60)


def _run_supervised_job_until_shutdown(job_id, pid_file):
    signal.signal(signal.SIGTERM, housetory_worker._interrupt_on_termination)
    with SessionLocal() as db:
        job = db.get(Job, job_id)
    with contextlib.suppress(KeyboardInterrupt):
        housetory_worker.process_interactive_job(
            job, process_target=_start_ocr_descendant_and_wait, process_args=(pid_file,)
        )


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups")
@pytest.mark.parametrize("termination", ["cancel", "deadline", "shutdown"])
def test_interactive_supervision_terminates_ocr_descendants(tmp_path, termination):
    marker = tmp_path / "ocr-descendant-pid"
    with SessionLocal() as db:
        job = enqueue(
            db,
            "documents.ocr",
            {
                "mode": "interactive",
                "deadline_at": (
                    datetime.now(UTC) + timedelta(seconds=20 if termination == "shutdown" else 3)
                ).isoformat(),
            },
            queue="documents",
            max_attempts=1,
        )
        claimed = claim_job(db, worker_id="descendant-test", queue="documents")
        job_id = job.id

    def cancel_after_spawn():
        if _wait_for(marker.exists, timeout=2):
            with SessionLocal() as db:
                stored = db.get(Job, job_id)
                stored.status = "cancelled"
                db.commit()

    canceller = None
    if termination == "cancel":
        canceller = threading.Thread(target=cancel_after_spawn)
        canceller.start()
    supervisor = None
    try:
        if termination == "shutdown":
            supervisor = multiprocessing.get_context("spawn").Process(
                target=_run_supervised_job_until_shutdown, args=(job_id, str(marker))
            )
            supervisor.start()
            assert _wait_for(marker.exists, timeout=8)
            supervisor.terminate()
            supervisor.join(timeout=8)
            assert not supervisor.is_alive()
        else:
            housetory_worker.process_interactive_job(
                claimed, process_target=_start_ocr_descendant_and_wait, process_args=(str(marker),)
            )
        assert marker.exists()
        pid = int(marker.read_text())
        assert _wait_for(lambda: not _process_exists(pid), timeout=5)
        with SessionLocal() as db:
            assert db.get(Job, job_id).status == (
                "cancelled" if termination == "cancel" else "failed"
            )
    finally:
        if canceller:
            canceller.join(timeout=5)
        if supervisor and supervisor.is_alive():
            supervisor.kill()
            supervisor.join(timeout=5)
        if marker.exists():
            pid = int(marker.read_text())
            if _process_exists(pid):
                with contextlib.suppress(ProcessLookupError):
                    os.kill(pid, signal.SIGKILL)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX worker shutdown signals")
def test_real_document_and_ai_jobs_complete_in_reserved_worker_lanes(
    owner_client, tmp_path, configured_ai, monkeypatch
):
    class SyntheticProvider(BaseHTTPRequestHandler):
        requests = 0

        def do_POST(self):
            type(self).requests += 1
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            refinement = {
                "fields": {
                    "merchant": "Corner Hardware",
                    "evidence": {"merchant": "CORNER HARDWARE"},
                },
                "lines": [
                    {
                        "description": "Drill",
                        "kind": "product",
                        "quantity": 1,
                        "unit_price_cents": 1000,
                        "line_total_cents": 1000,
                        "evidence": "Drill 1 x 10.00 10.00",
                    }
                ],
            }
            if "rank existing household inventory candidates" in request["messages"][0]["content"]:
                lines = json.loads(request["messages"][1]["content"].rsplit("\n", 1)[-1])
                refinement = {
                    "matches": [
                        {
                            "line_id": line["line_id"],
                            "candidate_ids": [
                                candidate["id"] for candidate in reversed(line["candidates"])
                            ],
                        }
                        for line in lines
                    ]
                }
            body = json.dumps({"message": {"content": json.dumps(refinement)}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):
            pass

    provider = ThreadingHTTPServer(("127.0.0.1", 0), SyntheticProvider)
    thread = threading.Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    test_config = replace(
        configured_ai,
        base_url=f"http://127.0.0.1:{provider.server_port}",
        model="synthetic-model",
        task="documents",
        display_name="ollama",
    )
    monkeypatch.setattr(ai, "config_for", lambda *args, **kwargs: test_config)
    worker = None
    log_path = tmp_path / "worker-real-jobs.log"
    try:
        uploaded = owner_client.post(
            "/api/v1/documents",
            files={
                "file": (
                    "receipt.txt",
                    b"CORNER HARDWARE\nDrill 1 x 10.00 10.00\nTotal $10.00\n",
                    "text/plain",
                )
            },
            data={"document_type": "invoice"},
        )
        assert uploaded.status_code == 201
        document_id = uploaded.json()["id"]
        env = {
            **os.environ,
            "WORKER_QUEUE": "all",
            "WORKER_POLL_SECONDS": "0.05",
            "WORKER_HEARTBEAT_FILE": str(tmp_path / "real-worker-heartbeat"),
            "AI_PROVIDER": "ollama",
            "AI_MODEL": "synthetic-model",
            "AI_BASE_URL": f"http://127.0.0.1:{provider.server_port}",
            "PYTHONPATH": os.pathsep.join(
                [
                    str(Path(__file__).resolve().parents[2] / "worker"),
                    str(Path(__file__).resolve().parents[1]),
                    os.environ.get("PYTHONPATH", ""),
                ]
            ),
        }
        with log_path.open("w") as log:
            worker = subprocess.Popen(
                [sys.executable, "-m", "housetory_worker"],
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )

            def document_jobs_completed():
                with SessionLocal() as db:
                    ocr = db.scalar(
                        select(Job).where(
                            Job.task == OCR_TASK,
                            Job.payload["document_id"].astext == document_id,
                        )
                    )
                    ai_job = db.scalar(
                        select(Job).where(
                            Job.task == "ai.enrich",
                            Job.payload["source_id"].astext == document_id,
                        )
                    )
                    document = db.get(Document, document_id)
                    return (
                        ocr
                        and ai_job
                        and ocr.queue == "documents"
                        and ai_job.queue == "ai-documents"
                        and ocr.status == "succeeded"
                        and ai_job.status == "succeeded"
                        and (document.extracted_metadata or {})
                        .get("enhancement", {})
                        .get("ai_succeeded")
                    )

            assert _wait_for(document_jobs_completed, timeout=30), log_path.read_text()
            assert SyntheticProvider.requests == 1
            for name in ("Drill", "Drill"):
                assert owner_client.post("/api/v1/items", json={"name": name}).status_code == 201
            base = owner_client.get(f"/api/v1/documents/{document_id}/extraction").json()
            match = next(entry for entry in base["matches"] if len(entry["candidates"]) >= 2)
            expected = [candidate["id"] for candidate in reversed(match["candidates"])]
            response = owner_client.post(
                f"/api/v1/documents/{document_id}/processing/retry",
                json={"operation": "matches"},
            )
            assert response.status_code == 200, response.text

            def matching_completed():
                with SessionLocal() as db:
                    job = db.scalar(
                        select(Job).where(
                            Job.queue == "ai-documents",
                            Job.payload["correlation_id"].astext
                            == response.json()["correlation_id"],
                        )
                    )
                    return job is not None and job.status == "succeeded"

            assert _wait_for(matching_completed, timeout=25), log_path.read_text()
            review = owner_client.get(f"/api/v1/documents/{document_id}/extraction").json()
            proposal = review["suggested_refinement"]
            assert proposal is not None, log_path.read_text()
            ranked = next(
                entry for entry in proposal["matches"] if entry["line_id"] == match["line_id"]
            )
            assert [candidate["id"] for candidate in ranked["candidates"]] == expected
            assert proposal["fields"] == base["fields"]
            assert proposal["lines"] == base["lines"]
            assert SyntheticProvider.requests == 2
            worker.terminate()
            worker.wait(timeout=15)
    finally:
        if worker is not None and worker.poll() is None:
            descendants = set()
            frontier = [worker.pid]
            while frontier:
                children = _children_of(frontier.pop())
                descendants.update(children)
                frontier.extend(children)
            worker.terminate()
            try:
                worker.wait(timeout=15)
            except subprocess.TimeoutExpired:
                worker.kill()
                worker.wait(timeout=5)
            for pid in descendants:
                if _process_exists(pid):
                    with contextlib.suppress(ProcessLookupError):
                        os.kill(pid, signal.SIGKILL)
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=5)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX worker shutdown signals")
def test_all_worker_role_executes_both_reserved_lanes_and_cleans_up(tmp_path):
    heartbeat = tmp_path / "worker-heartbeat"
    env = {
        **os.environ,
        "WORKER_QUEUE": "all",
        "WORKER_POLL_SECONDS": "0.05",
        "WORKER_HEARTBEAT_FILE": str(heartbeat),
        "PYTHONPATH": os.pathsep.join(
            [
                str(Path(__file__).resolve().parents[2] / "worker"),
                str(Path(__file__).resolve().parents[1]),
                os.environ.get("PYTHONPATH", ""),
            ]
        ),
    }
    payload = {
        "mode": "interactive",
        "deadline_at": (datetime.now(UTC) + timedelta(seconds=60)).isoformat(),
    }
    with SessionLocal() as db:
        local_id = enqueue(db, "maintenance.ping", payload, queue="documents").id
        ai_id = enqueue(db, "maintenance.ping", payload, queue="ai-documents").id
    log_path = tmp_path / "worker.log"
    pids = set()
    job_child = None
    with log_path.open("w") as log:
        worker = subprocess.Popen(
            [sys.executable, "-m", "housetory_worker"],
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:

            def heartbeat_pids():
                files = {
                    "default": heartbeat,
                    **{
                        q: heartbeat.with_name(f"{heartbeat.name}-{q}")
                        for q in ("documents", "ai", "ai-documents")
                    },
                }
                try:
                    return {
                        queue: json.loads(path.read_text())["pid"] for queue, path in files.items()
                    }
                except (OSError, ValueError, KeyError):
                    return None

            lanes = _wait_for(heartbeat_pids) or {}
            pids = set(lanes.values())
            assert len(pids) == 4, log_path.read_text()

            def both_succeeded():
                with SessionLocal() as db:
                    for job_id in (local_id, ai_id):
                        job = db.get(Job, job_id)
                        if (
                            job.status != "succeeded"
                            or not job.result
                            or not job.result.get("pong")
                        ):
                            return False
                        if any(
                            job.result["echo"].get(key) != value for key, value in payload.items()
                        ):
                            return False
                    return True

            assert _wait_for(both_succeeded, timeout=12), log_path.read_text()
            local_lane_pid = lanes["documents"]
            assert _wait_for(lambda: not _children_of(local_lane_pid)), log_path.read_text()
            with SessionLocal() as db:
                stopping_id = enqueue(db, "maintenance.ping", payload, queue="documents").id
            job_child = _wait_for(lambda: next(iter(_children_of(local_lane_pid)), None))
            assert job_child is not None, log_path.read_text()
            os.kill(job_child, signal.SIGSTOP)
            worker.terminate()
            time.sleep(0.1)
            with contextlib.suppress(ProcessLookupError):
                os.kill(job_child, signal.SIGCONT)
            worker.wait(timeout=15)
            assert _wait_for(
                lambda: all(not _process_exists(pid) for pid in pids | {job_child}), timeout=8
            ), log_path.read_text()
            with SessionLocal() as db:
                assert db.get(Job, stopping_id).status == "failed"
        finally:
            descendants = set()
            frontier = [worker.pid]
            while frontier:
                children = _children_of(frontier.pop())
                descendants.update(children)
                frontier.extend(children)
            if job_child and _process_exists(job_child):
                with contextlib.suppress(ProcessLookupError):
                    os.kill(job_child, signal.SIGCONT)
                    os.kill(job_child, signal.SIGKILL)
            if worker.poll() is None:
                worker.kill()
                worker.wait(timeout=5)
            for pid in pids | descendants:
                if pid == worker.pid:
                    continue
                if _process_exists(pid):
                    with contextlib.suppress(ProcessLookupError):
                        os.kill(pid, signal.SIGKILL)
