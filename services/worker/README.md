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
- reads `/data/uploads` read-only and writes extracted vault files only to the
  separate `/data/imports` volume
- writes `/tmp/housetory-worker-heartbeat` for its container health check

Current tasks:

| Task | Purpose |
| --- | --- |
| `maintenance.prune_expired_sessions` | Delete expired authentication sessions |
| `maintenance.prune_finished_jobs` | Delete succeeded/failed jobs older than 30 days |
| `maintenance.ping` | Queue/pipeline smoke test |
| `documents.ocr` | Local Tesseract/Poppler document text extraction |
| `imports.process` | Safe source parsing, vault extraction, proposal matching |
| `ai.recognize` | Optional vision inference with OCR fallback |

No network port is exposed by the worker. Local AI requires an operator-provided
Ollama endpoint/model; cloud inference requires explicit consent configuration.
The worker never downloads models automatically.
