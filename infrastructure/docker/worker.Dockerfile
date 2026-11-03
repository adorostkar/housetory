# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/api:/app/worker \
    PATH="/app/api/.venv/bin:$PATH"

RUN groupadd --system housetory \
    && useradd --system --gid housetory --create-home --home-dir /home/housetory housetory

WORKDIR /app
COPY services/api/pyproject.toml services/api/uv.lock /app/api/
RUN cd /app/api && uv sync --frozen --no-dev --no-install-project

COPY services/api/housetory_api /app/api/housetory_api
COPY services/worker/housetory_worker /app/worker/housetory_worker

USER housetory

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -m housetory_worker.health

CMD ["python", "-m", "housetory_worker"]
