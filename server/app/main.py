"""Serve the code-flow JSON API."""

from collections.abc import Callable
from concurrent.futures import Executor
from contextlib import asynccontextmanager
from typing import Annotated, Any

import codeflow
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.auto_sync import AutoSync
from app.config import Settings
from app.flag_findings import find_flags
from app.flagsmith_client import FlagsmithClient
from app.importer import RefreshUnavailable, RepoImporter, validate_import
from app.store import BadRequest, NotFound, Store


def create_app(
    settings: Settings | None = None,
    *,
    git_url_builder: Callable[[str], str] | None = None,
    executor: Executor | None = None,
    flagsmith_client: FlagsmithClient | None = None,
    auto_sync_interval: float | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    store = Store(
        settings.data_dir,
        long_flow_min_depth=settings.long_flow_min_depth,
        snapshot_cache_size=settings.snapshot_cache_size,
    )
    importer = RepoImporter(
        store, git_url_builder, executor, max_commits=settings.max_import_commits
    )
    auto_sync = AutoSync(
        importer, settings.auto_sync_interval if auto_sync_interval is None else auto_sync_interval
    )
    flagsmith = flagsmith_client or FlagsmithClient(
        settings.flagsmith_server_key, settings.flagsmith_api_url
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        auto_sync.start()
        try:
            yield
        finally:
            auto_sync.stop()
            importer.shutdown()

    app = FastAPI(title="code-flow", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.web_origin],
        allow_methods=["GET", "POST", "PUT"],
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
        if request.method == "PUT" and request.url.path == "/api/auto-sync":
            return JSONResponse(
                status_code=400, content={"detail": "Auto-sync settings must be valid JSON"}
            )
        if request.method == "POST" and request.url.path == "/api/repos":
            return JSONResponse(
                status_code=400, content={"detail": "Import request must be valid JSON"}
            )
        return await request_validation_exception_handler(request, exc)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "analyzer_version": codeflow.__version__}

    @app.get("/api/auto-sync")
    def auto_sync_status() -> dict:
        return auto_sync.response()

    @app.put("/api/auto-sync")
    def update_auto_sync(payload: Annotated[Any, Body()] = None) -> dict:
        try:
            return auto_sync.update(payload)
        except RefreshUnavailable as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(
                status_code=500, detail="Could not save auto-sync settings"
            ) from exc

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
        return importer.start(validate_import(payload, limit=settings.max_import_commits))

    @app.post("/api/repos/{repo}/refresh", status_code=202)
    def refresh_repo(repo: str) -> dict[str, str]:
        try:
            return importer.refresh(repo)
        except RefreshUnavailable as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

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
            "new_commits": None,
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

    @app.get("/api/repos/{repo}/flags")
    def flags(repo: str, sha: str | None = None) -> dict:
        with store.lock:
            snapshot, earlier_checks = store.flag_history(repo, sha)
        environment, scope = settings.flag_scope(repo)
        state = flagsmith.get_state()
        return {
            "repo": repo,
            "sha": snapshot.commit.sha,
            "flagsmith": {
                "connected": state.flags is not None,
                "environment": environment,
                "fetched_at": state.fetched_at,
                "error": state.error,
            },
            "flags": find_flags(snapshot, earlier_checks, scope, state.flags),
        }

    @app.get("/api/repos/{repo}/diff")
    def diff(repo: str, head: str, base: str | None = None, hops: int = 1) -> dict:
        with store.lock:
            return store.diff(repo, head, base, hops)

    @app.get("/api/repos/{repo}/function-diff")
    def function_diff(repo: str, head: str, node: str, base: str | None = None) -> dict:
        with store.lock:
            return store.function_diff(repo, head, node, base)

    @app.get("/api/repos/{repo}/code")
    def code(
        repo: str, sha: str, file: str, start: int | None = None, end: int | None = None
    ) -> dict:
        with store.lock:
            return store.code(repo, sha, file, start, end)

    return app


app = create_app()
