# Housetory worker

A small CPU-only process that executes durable jobs stored in PostgreSQL.

```bash
# From the repository root, using the API virtual environment:
PYTHONPATH=services/api:services/worker \
  services/api/.venv/bin/python -m housetory_worker
```

Docker Compose runs this automatically. The process:

- claims jobs with `FOR UPDATE SKIP LOCKED`
- retries failures with capped exponential backoff
- requeues jobs abandoned by crashed workers
- schedules session pruning every six hours
- writes `/tmp/housetory-worker-heartbeat` for its container health check

Current tasks:

| Task | Purpose |
| --- | --- |
| `maintenance.prune_expired_sessions` | Delete expired authentication sessions |
| `maintenance.prune_finished_jobs` | Delete succeeded/failed jobs older than 30 days |
| `maintenance.ping` | Queue/pipeline smoke test |

No network port is exposed by the worker.
