"""Serve the code-flow health endpoint."""

import os

import codeflow
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="code-flow")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("CODEFLOW_WEB_ORIGIN", "http://localhost:5173")],
    allow_methods=["GET"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "analyzer_version": codeflow.__version__}
