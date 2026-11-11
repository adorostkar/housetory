# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /app/api
COPY services/api/pyproject.toml services/api/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY services/api/housetory_api ./housetory_api
RUN uv sync --frozen --no-dev

FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/api:/app/worker \
    PATH="/app/api/.venv/bin:$PATH"

# Retain Alpine's numeric identity for existing private data volumes.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libstdc++6 \
        tesseract-ocr \
        tesseract-ocr-eng \
        tesseract-ocr-swe \
        poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 101 housetory \
    && useradd --system --uid 100 --gid 101 --home-dir /home/housetory \
        --create-home housetory \
    && mkdir -p /data/uploads /data/imports /data/exports \
    && chown -R housetory:housetory /data \
    && chmod 700 /data /data/uploads /data/imports /data/exports

WORKDIR /app
COPY --from=builder /app/api /app/api
COPY services/worker/housetory_worker /app/worker/housetory_worker

USER housetory

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -m housetory_worker.health

CMD ["python", "-m", "housetory_worker"]
