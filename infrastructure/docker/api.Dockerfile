# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:python3.12-alpine AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /app

COPY services/api/pyproject.toml services/api/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY services/api/alembic.ini ./
COPY services/api/alembic ./alembic
COPY services/api/housetory_api ./housetory_api
RUN uv sync --frozen --no-dev

FROM python:3.12-alpine AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:$PATH"

RUN apk add --no-cache libstdc++ \
    && addgroup -S housetory \
    && adduser -S -G housetory -h /home/housetory housetory \
    && mkdir -p /data/uploads \
    && chown -R housetory:housetory /data \
    && chmod 700 /data /data/uploads

WORKDIR /app
COPY --from=builder /app /app

USER housetory
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health/ready', timeout=4)"

CMD ["uvicorn", "housetory_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
