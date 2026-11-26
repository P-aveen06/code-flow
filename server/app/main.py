"""Serve the code-flow JSON API."""

import codeflow
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import Settings
from app.store import BadRequest, NotFound, Store


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    store = Store(settings.data_dir)
    app = FastAPI(title="code-flow")
    app.add_middleware(CORSMiddleware, allow_origins=[settings.web_origin], allow_methods=["GET"])

    @app.exception_handler(NotFound)
    async def not_found(request: Request, exc: NotFound) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(BadRequest)
    async def bad_request(request: Request, exc: BadRequest) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "analyzer_version": codeflow.__version__}

    @app.get("/api/repos")
    def repos() -> list[dict]:
        return store.list_repos()

    @app.get("/api/repos/{repo}/commits")
    def commits(repo: str) -> dict:
        return store.commits(repo)

    @app.get("/api/repos/{repo}/snapshots/{sha}")
    def snapshot(repo: str, sha: str) -> dict:
        return store.snapshot(repo, sha)

    @app.get("/api/repos/{repo}/diff")
    def diff(repo: str, head: str, base: str | None = None, hops: int = 1) -> dict:
        return store.diff(repo, head, base, hops)

    @app.get("/api/repos/{repo}/code")
    def code(
        repo: str, sha: str, file: str, start: int | None = None, end: int | None = None
    ) -> dict:
        return store.code(repo, sha, file, start, end)

    return app


app = create_app()
