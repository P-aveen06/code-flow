"""Serve the code-flow JSON API."""

from collections.abc import Callable
from concurrent.futures import Executor
from contextlib import asynccontextmanager
from typing import Annotated, Any

import codeflow
from fastapi import APIRouter, Body, Depends, FastAPI, HTTPException, Query, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.access import can_read
from app.auth import DEFAULT_COMMIT_COUNT, Auth
from app.branches import (
    BranchesUnavailable,
    ImportedBranches,
    branch_listing,
    branch_source,
    import_settings,
    known_imports,
)
from app.config import Settings
from app.flag_findings import find_flags
from app.flagsmith_client import FlagsmithClient
from app.github import GitHubApp, GitHubError, GitHubRest
from app.import_analysis import ImportSource
from app.importer import (
    RefreshUnavailable,
    RepoImporter,
    picked_source,
    validate_branch,
    validate_import,
)
from app.sessions import SESSION_COOKIE, SessionStore
from app.store import BadRequest, NotFound, Store

# Browsers only send this header from scripts, so cross-site forms cannot use the session.
CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "code-flow"


def create_app(
    settings: Settings | None = None,
    *,
    git_url_builder: Callable[[str], str] | None = None,
    executor: Executor | None = None,
    flagsmith_client: FlagsmithClient | None = None,
    github_app: GitHubApp | None = None,
    github_rest: GitHubRest | None = None,
    sessions: SessionStore | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    store = Store(
        settings.data_dir,
        long_flow_min_depth=settings.long_flow_min_depth,
        snapshot_cache_size=settings.snapshot_cache_size,
    )
    github = github_app or (GitHubApp(settings.github_app) if settings.github_app else None)
    auth = Auth(settings, github, sessions or SessionStore())
    github_branches = ImportedBranches(
        github_rest or GitHubRest(), github, settings.github_api_token
    )

    def clone_token(source: ImportSource) -> str | None:
        """Pick the token for a clone: none for public repos unless a local token is set."""
        if source.installation_id is None:
            return settings.github_token
        if github is None or source.github_repo_id is None:
            raise GitHubError("GitHub sign-in is not set up on this server")
        return github.installation_token(source.installation_id, source.github_repo_id)

    importer = RepoImporter(
        store,
        git_url_builder,
        executor,
        max_commits=settings.max_import_commits,
        clone_token=clone_token,
    )
    flagsmith = flagsmith_client or FlagsmithClient(
        settings.flagsmith_server_key, settings.flagsmith_api_url
    )

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
        allow_headers=["Content-Type", "X-Requested-With"],
    )

    @app.middleware("http")
    async def block_cross_site_posts(request: Request, call_next):
        """A POST that carries the session must come from the code-flow site itself."""
        if request.method == "POST" and SESSION_COOKIE in request.cookies:
            origin = request.headers.get("origin")
            if request.headers.get(CSRF_HEADER) != CSRF_VALUE or (
                origin is not None and origin != settings.web_origin
            ):
                return JSONResponse(status_code=403, content={"detail": "Request blocked"})
        return await call_next(request)

    app.include_router(auth.router())

    def repo_source(repo: str) -> dict:
        """Who owns a repo: from its running job, else from its published source.json."""
        job = importer.job(repo)
        if job is not None:
            return job.source.access_fields()
        with store.lock:
            return store.repo_source(repo)

    def check_repo_access(repo: str, request: Request) -> None:
        # Strangers get the same 404 as for a repo that does not exist.
        if not can_read(repo_source(repo), auth.uid(request)):
            raise NotFound(f"Unknown repository: {repo!r}")

    def private_import_count(uid: int, excluding: str) -> int:
        with store.lock:
            sources = store.sources()
            for job in importer.jobs():
                sources[job.source.id] = job.source.access_fields()
        return sum(
            1
            for repo, source in sources.items()
            if repo != excluding
            and source.get("visibility") == "private"
            and source.get("owner_uid") == uid
        )

    def ensure_private_capacity(source: ImportSource) -> None:
        """Refuse a private import past the limit per person. Re-importing a counted one is free."""
        if source.visibility == "private" and (
            private_import_count(source.owner_uid, source.id) >= settings.max_private_imports
        ):
            raise HTTPException(
                status_code=409,
                detail=f"You can import up to {settings.max_private_imports} private "
                "repositories on this server",
            )

    def start_picked_import(payload: dict, request: Request) -> dict[str, str]:
        repo_id, installation_id = payload.get("github_repo_id"), payload.get("installation_id")
        if type(repo_id) is not int or type(installation_id) is not int:
            raise BadRequest("Pick a repository from the list")
        session, repos = auth.repositories(request)
        repo = next(
            (r for r in repos if r.id == repo_id and r.installation_id == installation_id), None
        )
        if repo is None:
            raise NotFound("Repository not found, or code-flow has no access to it")
        source = picked_source(payload, repo, session.uid, limit=settings.max_import_commits)
        ensure_private_capacity(source)
        return importer.start(source)

    @app.exception_handler(NotFound)
    async def not_found(request: Request, exc: NotFound) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(BadRequest)
    async def bad_request(request: Request, exc: BadRequest) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(BranchesUnavailable)
    async def branches_unavailable(request: Request, exc: BranchesUnavailable) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(GitHubError)
    async def github_failed(request: Request, exc: GitHubError) -> JSONResponse:
        return JSONResponse(status_code=502, content={"detail": str(exc)})

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
        is_import = request.url.path == "/api/repos" or request.url.path.endswith("/branches")
        if request.method == "POST" and is_import:
            return JSONResponse(
                status_code=400, content={"detail": "Import request must be valid JSON"}
            )
        return await request_validation_exception_handler(request, exc)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "analyzer_version": codeflow.__version__}

    @app.get("/api/repos")
    def repos(request: Request) -> list[dict]:
        with store.lock:
            indexed = {repo["id"]: repo for repo in store.list_repos()}
            for job in importer.jobs():
                repo_id = job.source.id
                indexed[repo_id] = job.repo_entry(indexed.get(repo_id, {}))
        uid = auth.uid(request)
        visible = [
            {key: value for key, value in repo.items() if key != "owner_uid"}
            for repo in indexed.values()
            if can_read(repo, uid)
        ]
        return sorted(visible, key=lambda repo: repo["name"])

    @app.post("/api/repos", status_code=202)
    def import_repo(request: Request, payload: Annotated[Any, Body()] = None) -> dict[str, str]:
        if isinstance(payload, dict) and "github_repo_id" in payload:
            return start_picked_import(payload, request)
        return importer.start(validate_import(payload, limit=settings.max_import_commits))

    # Every route under /api/repos/{repo} checks access first, including routes added later.
    repo_routes = APIRouter(dependencies=[Depends(check_repo_access)])

    @repo_routes.post("/api/repos/{repo}/refresh", status_code=202)
    def refresh_repo(repo: str) -> dict[str, str]:
        try:
            return importer.refresh(repo)
        except RefreshUnavailable as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @repo_routes.get("/api/repos/{repo}/status")
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

    @repo_routes.get("/api/repos/{repo}/commits")
    def commits(repo: str) -> dict:
        with store.lock:
            return store.commits(repo)

    @repo_routes.get("/api/repos/{repo}/snapshots/{sha}")
    def snapshot(repo: str, sha: str) -> dict:
        with store.lock:
            return store.snapshot(repo, sha)

    @repo_routes.get("/api/repos/{repo}/flags")
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

    @repo_routes.get("/api/repos/{repo}/diff")
    def diff(repo: str, head: str, base: str | None = None, hops: int = 1) -> dict:
        with store.lock:
            return store.diff(repo, head, base, hops)

    @repo_routes.get("/api/repos/{repo}/function-diff")
    def function_diff(repo: str, head: str, node: str, base: str | None = None) -> dict:
        with store.lock:
            return store.function_diff(repo, head, node, base)

    @repo_routes.get("/api/repos/{repo}/code")
    def code(
        repo: str, sha: str, file: str, start: int | None = None, end: int | None = None
    ) -> dict:
        with store.lock:
            return store.code(repo, sha, file, start, end)

    @repo_routes.get("/api/repos/{repo}/branches")
    def list_branches(repo: str) -> dict:
        metadata = import_settings(store, importer, repo)
        default, names = github_branches.listing(metadata)
        return branch_listing(repo, metadata, default, names, known_imports(store, importer))

    @repo_routes.get("/api/repos/{repo}/branches/commits")
    def branch_commits(
        repo: str, branch: str = "", limit: Annotated[int, Query(ge=1)] = DEFAULT_COMMIT_COUNT
    ) -> dict:
        metadata = import_settings(store, importer, repo)
        branch = validate_branch(branch)
        # The server's import cap wins over a larger count from Flagsmith.
        limit = min(limit, settings.max_import_commits)
        name, commits = github_branches.commits(metadata, branch, limit)
        return {
            "branch": name,
            "limit": limit,
            "commits": [commit.response() for commit in commits],
        }

    @repo_routes.post("/api/repos/{repo}/branches", status_code=202)
    def import_branch(repo: str, payload: Annotated[Any, Body()] = None) -> dict[str, str]:
        metadata = import_settings(store, importer, repo)
        default = github_branches.default_branch(metadata)
        source = branch_source(metadata, payload, default, limit=settings.max_import_commits)
        ensure_private_capacity(source)
        return importer.start(source)

    app.include_router(repo_routes)
    return app


app = create_app()
