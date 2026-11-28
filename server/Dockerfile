FROM python:3.11-slim-bookworm AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS tooling
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /usr/local/bin/uv

FROM tooling AS demo
COPY analyzer/ analyzer/
RUN UV_PROJECT_ENVIRONMENT=/opt/demo uv sync --project analyzer --locked --no-dev --no-editable --no-cache
COPY scripts/build_demo_data.sh scripts/
RUN PATH="/opt/demo/bin:$PATH" bash scripts/build_demo_data.sh /app/data

FROM tooling AS build
COPY analyzer/ analyzer/
COPY server/ server/
RUN UV_PROJECT_ENVIRONMENT=/opt/api uv sync --project server --locked --no-dev --no-editable --no-cache

FROM base
ENV PATH="/opt/api/bin:$PATH" \
    CODEFLOW_DATA_DIR=/app/data \
    PYTHONUNBUFFERED=1
RUN groupadd --gid 1000 codeflow \
    && useradd --uid 10001 --gid codeflow --no-create-home codeflow \
    && install -d -o codeflow -g codeflow /app/data
COPY --from=build /opt/api /opt/api
COPY --from=demo /app/data /opt/codeflow-seed/data
COPY scripts/start_api.sh /app/
USER codeflow
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8787') + '/api/health', timeout=2).close()"]
CMD ["sh", "/app/start_api.sh"]
