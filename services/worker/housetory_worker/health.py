"""Container health check for the worker.

The worker has no socket. It updates a heartbeat file while its loop is alive,
which is enough to detect a wedged or crashed process.
"""

import os
import sys
import time
from pathlib import Path

heartbeat = Path(os.environ.get("WORKER_HEARTBEAT_FILE", "/tmp/housetory-worker-heartbeat"))
max_age = float(os.environ.get("WORKER_HEARTBEAT_MAX_AGE", "120"))

try:
    age = time.time() - heartbeat.stat().st_mtime
except FileNotFoundError:
    print("worker heartbeat not found", file=sys.stderr)
    raise SystemExit(1) from None

if age > max_age:
    print(f"worker heartbeat is {age:.0f}s old", file=sys.stderr)
    raise SystemExit(1)

print(f"worker heartbeat is {age:.1f}s old")
