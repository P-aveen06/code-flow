"""Check that the health endpoint reports the installed analyzer version."""

import codeflow
from fastapi.testclient import TestClient

from app.main import app


def test_health() -> None:
    with TestClient(app) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "analyzer_version": codeflow.__version__}
