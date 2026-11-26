"""Serve the code-flow JSON API."""

from collections.abc import Callable
from concurrent.futures import Executor
from contextlib import asynccontextmanager
from typing import Annotated, Any

import codeflow
from fastapi import Body, FastAPI, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import Settings
from app.importer import RepoImporter, validate_import
from app.store import BadRequest, NotFound, Store


def create_app(
    settings: Settings | None = None,
    *,
    git_url_builder: Callable[[str], str] | None = None,
    executor: Executor | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    store = Store(settings.data_dir)
    importer = RepoImporter(store, git_url_builder, executor)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        try:
            yield
        finally:
            importer.shutdown()

    app = FastAPI(title="code-flow", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.web_origin],
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    @app.exception_handler(NotFound)
    async def not_found(request: Request, exc: NotFound) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(BadRequest)
    async def bad_request(request: Request, exc: BadRequest) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
        if request.method == "POST" and request.url.path == "/api/repos":
            return JSONResponse(
                status_code=400, content={"detail": "Import request must be valid JSON"}
            )
        return await request_validation_exception_handler(request, exc)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "analyzer_version": codeflow.__version__}

    @app.get("/api/repos")
    def repos() -> list[dict]:
        with store.lock:
            indexed = {repo["id"]: repo for repo in store.list_repos()}
            for job in importer.jobs():
                repo_id = job.source.id
                indexed[repo_id] = job.repo_entry(indexed.get(repo_id, {}))
        return sorted(indexed.values(), key=lambda repo: repo["name"])

    @app.post("/api/repos", status_code=202)
    def import_repo(payload: Annotated[Any, Body()] = None) -> dict[str, str]:
        return importer.start(validate_import(payload))

    @app.get("/api/repos/{repo}/status")
    def status(repo: str) -> dict:
        job = importer.job(repo)
        if job is not None:
            return job.status_response()
        with store.lock:
            info = store.repo_info(repo)
        return {
            "id": info["id"],
            "name": info["name"],
            "status": info["status"],
            "message": info["message"],
            "current": info["commit_count"],
            "total": info["commit_count"],
            "warning": info["warning"],
            "error": None,
            "seconds": 0,
        }

    @app.get("/api/repos/{repo}/commits")
    def commits(repo: str) -> dict:
        with store.lock:
            return store.commits(repo)

    @app.get("/api/repos/{repo}/snapshots/{sha}")
    def snapshot(repo: str, sha: str) -> dict:
        with store.lock:
            return store.snapshot(repo, sha)

    @app.get("/api/repos/{repo}/diff")
    def diff(repo: str, head: str, base: str | None = None, hops: int = 1) -> dict:
        with store.lock:
            return store.diff(repo, head, base, hops)

    @app.get("/api/repos/{repo}/code")
    def code(
        repo: str, sha: str, file: str, start: int | None = None, end: int | None = None
    ) -> dict:
        with store.lock:
            return store.code(repo, sha, file, start, end)

    return app


app = create_app()
