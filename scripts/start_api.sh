#!/bin/sh
set -eu

# Seed the writable container filesystem so imports can atomically rename demo outputs.
if [ "$CODEFLOW_DATA_DIR" = /app/data ] && [ ! -f /app/data/.seeded ]; then
    cp -R /opt/codeflow-seed/data/. /app/data/
    touch /app/data/.seeded
fi

exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8787}"
