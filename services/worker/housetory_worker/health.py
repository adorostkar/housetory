"""Container health check for the worker.

The worker has no socket. It updates a heartbeat file while its loop is alive,
which is enough to detect a wedged or crashed process.
"""

import os
import sys
import time
from pathlib import Path

heartbeat = Path(
    os.environ.get("WORKER_HEARTBEAT_FILE", "/tmp/housetory-worker-heartbeat")
)
max_age = float(os.environ.get("WORKER_HEARTBEAT_MAX_AGE", "120"))
role = os.environ.get("WORKER_QUEUE", "all")


def _heartbeat_path(queue: str) -> Path:
    if queue == "default":
        return heartbeat
    return heartbeat.with_name(f"{heartbeat.name}-{queue}")


required_queues = (
    ["default", "documents", "ai", "ai-documents"]
    if role == "all"
    else ["default", "documents"]
    if role == "default"
    else ["ai", "ai-documents"]
)

for queue in required_queues:
    path = _heartbeat_path(queue)
    try:
        age = time.time() - path.stat().st_mtime
    except FileNotFoundError:
        print(f"{queue} worker heartbeat not found", file=sys.stderr)
        raise SystemExit(1) from None

    if age > max_age:
        print(f"{queue} worker heartbeat is {age:.0f}s old", file=sys.stderr)
        raise SystemExit(1)

print("worker heartbeats are current")
