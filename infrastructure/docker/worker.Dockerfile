# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:python3.12-alpine AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /app/api
COPY services/api/pyproject.toml services/api/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY services/api/housetory_api ./housetory_api
RUN uv sync --frozen --no-dev

FROM python:3.12-alpine AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/api:/app/worker \
    PATH="/app/api/.venv/bin:$PATH"

RUN apk add --no-cache \
        libstdc++ \
        tesseract-ocr \
        tesseract-ocr-data-eng \
        poppler-utils \
    && addgroup -S housetory \
    && adduser -S -G housetory -h /home/housetory housetory

WORKDIR /app
COPY --from=builder /app/api /app/api
COPY services/worker/housetory_worker /app/worker/housetory_worker

USER housetory

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -m housetory_worker.health

CMD ["python", "-m", "housetory_worker"]
