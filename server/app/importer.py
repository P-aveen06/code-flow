"""Validate GitHub imports and run their Git and analysis work on a single background thread."""

import re
from collections.abc import Callable
from concurrent.futures import Executor, ThreadPoolExecutor
from dataclasses import dataclass, replace
from functools import partial
from pathlib import Path, PurePosixPath, PureWindowsPath
from tempfile import TemporaryDirectory
from threading import Lock
from time import monotonic

from app.config import MAX_IMPORT_COMMITS
from app.github import GitHubError, GitHubRepo
from app.import_analysis import (
    ANALYSIS_ERROR,
    ImportAnalysis,
    ImportFailure,
    ImportResult,
    ImportSource,
)
from app.store import BadRequest, Store

GITHUB_URL = re.compile(r"https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/?")
ACTIVE_STATUSES = ("queued", "cloning", "analyzing")
# GitHub logins never contain "_", so this prefix cannot collide with a public "owner__name" id.
PRIVATE_PREFIX = "p_"


def validate_import(payload: object, *, limit: int = MAX_IMPORT_COMMITS) -> ImportSource:
    """Validate an import request and normalize its GitHub URL and subfolder."""
    if not isinstance(payload, dict):
        raise BadRequest("Import request must be a JSON object")
    url = payload.get("url")
    match = GITHUB_URL.fullmatch(url) if isinstance(url, str) else None
    if match is None:
        raise BadRequest("Enter a public GitHub URL like https://github.com/owner/repo")
    owner, name = match.groups()
    name = name.removesuffix(".git")
    if any(part in ("", ".") or ".." in part for part in (owner, name)):
        raise BadRequest("GitHub URL must include a valid owner and repository name")

    subdir = payload.get("subdir", "")
    if not isinstance(subdir, str):
        raise BadRequest("Subfolder must be a relative path without '..'")
    path = PurePosixPath(subdir)
    if (
        path.is_absolute()
        or PureWindowsPath(subdir).drive
        or ".." in path.parts
        or "\\" in subdir
        or "\0" in subdir
    ):
        raise BadRequest("Subfolder must be a relative path without '..'")
    max_commits = payload.get("max_commits", min(30, limit))
    if type(max_commits) is not int or not 1 <= max_commits <= limit:
        raise BadRequest(f"max_commits must be an integer from 1 to {limit}")

    display_name = f"{owner}/{name}"
    return ImportSource(
        f"{owner}__{name}",
        display_name,
        f"https://github.com/{display_name}",
        path.as_posix() if path.parts else "",
        max_commits,
    )


def private_repo_id(uid: int, full_name: str) -> str:
    owner, name = full_name.split("/", 1)
    return f"{PRIVATE_PREFIX}{uid}__{owner}__{name}"


def picked_source(
    payload: dict, repo: GitHubRepo, uid: int, *, limit: int = MAX_IMPORT_COMMITS
) -> ImportSource:
    """Build the import for a repo chosen in the picker.

    A public repo is shared with every visitor, like a pasted URL. A private repo
    belongs to the user who picked it and is cloned through the app installation.
    """
    options = {**payload, "url": f"https://github.com/{repo.full_name}"}
    shared = validate_import(options, limit=limit)
    if not repo.private:
        return shared
    return replace(
        shared,
        id=private_repo_id(uid, shared.name),
        visibility="private",
        owner_uid=uid,
        installation_id=repo.installation_id,
        github_repo_id=repo.id,
    )


def source_from_metadata(metadata: dict, *, limit: int = MAX_IMPORT_COMMITS) -> ImportSource:
    """Rebuild an import from its source.json, keeping who owns a private repo."""
    source = validate_import(metadata, limit=limit)
    if metadata.get("visibility") != "private":
        return source
    try:
        uid = int(metadata["owner_uid"])
        installation_id = int(metadata["installation_id"])
        repo_id = int(metadata["github_repo_id"])
    except (KeyError, TypeError, ValueError):
        raise BadRequest("The stored private repository is missing its GitHub details") from None
    return replace(
        source,
        id=private_repo_id(uid, source.name),
        visibility="private",
        owner_uid=uid,
        installation_id=installation_id,
        github_repo_id=repo_id,
    )


@dataclass(frozen=True)
class ImportJob:
    """A point-in-time view of an import's progress."""

    source: ImportSource
    started: float
    status: str = "queued"
    message: str = "Queued"
    branch: str = ""
    current: int = 0
    total: int = 0
    warning: str | None = None
    error: str | None = None
    new_commits: int | None = None
    finished: float | None = None

    def status_response(self) -> dict:
        end = self.finished if self.finished is not None else monotonic()
        return {
            "id": self.source.id,
            "name": self.source.name,
            "status": self.status,
            "message": self.message,
            "current": self.current,
            "total": self.total,
            "warning": self.warning,
            "error": self.error,
            "new_commits": self.new_commits,
            "seconds": round(end - self.started, 1),
        }

    def repo_entry(self, indexed: dict) -> dict:
        return {
            "id": self.source.id,
            "name": self.source.name,
            "url": self.source.url,
            "subdir": self.source.subdir,
            "branch": self.branch or indexed.get("branch", ""),
            "commit_count": indexed.get("commit_count", 0),
            "status": self.status,
            "message": self.message,
            "warning": self.warning,
            "visibility": self.source.visibility,
            "owner_uid": self.source.owner_uid,
        }


class RefreshUnavailable(ValueError):
    """The published repository was not imported from GitHub."""


class RepoImporter:
    """Own the import queue and keep a locked table of its jobs."""

    def __init__(
        self,
        store: Store,
        git_url_builder: Callable[[str], str] | None = None,
        executor: Executor | None = None,
        *,
        max_commits: int = MAX_IMPORT_COMMITS,
        clone_token: Callable[[ImportSource], str | None] | None = None,
    ) -> None:
        self.store = store
        self.git_url_builder = git_url_builder or (lambda url: url)
        # Returns the token for a clone, or None for an anonymous public clone.
        self.clone_token = clone_token or (lambda _source: None)
        self.executor = executor if executor is not None else ThreadPoolExecutor(max_workers=1)
        self._owns_executor = executor is None
        self._max_commits = max_commits
        self._analysis = ImportAnalysis(max_commits)
        self._lock = Lock()
        self._jobs: dict[str, ImportJob] = {}

    def shutdown(self) -> None:
        if self._owns_executor:
            self.executor.shutdown()

    def jobs(self) -> list[ImportJob]:
        with self._lock:
            return list(self._jobs.values())

    def job(self, repo_id: str) -> ImportJob | None:
        with self._lock:
            return self._jobs.get(repo_id)

    def start(self, source: ImportSource) -> dict[str, str]:
        return self._start(source.id, source)

    def refresh(self, repo_id: str) -> dict[str, str]:
        return self._start(repo_id, None)

    def _github_source(self, repo_id: str) -> ImportSource:
        """Validate published source metadata with the caller holding the store lock."""
        metadata = self.store.repo_source(repo_id)
        url = metadata.get("url") if isinstance(metadata, dict) else None
        if not isinstance(url, str) or GITHUB_URL.fullmatch(url) is None:
            raise RefreshUnavailable(
                "Only repositories imported from GitHub can check for new commits"
            )
        source = source_from_metadata(metadata)
        if source.id != repo_id:
            raise BadRequest("The stored GitHub URL does not match the repository ID")
        return replace(source, max_commits=min(source.max_commits, self._max_commits))

    def _start(self, repo_id: str, source: ImportSource | None) -> dict[str, str]:
        refresh = source is None
        with self.store.lock, self._lock:
            job = self._jobs.get(repo_id)
            if job is not None and job.status in ACTIVE_STATUSES:
                return {"id": repo_id, "status": job.status}
            if source is None:
                source = self._github_source(repo_id)
            self._jobs[repo_id] = ImportJob(source, monotonic())

        try:
            self.executor.submit(self._run, source, refresh)
        except RuntimeError:
            self._fail(repo_id, "Could not queue repository import")
        return {"id": repo_id, "status": "queued"}

    def _update(self, repo_id: str, **changes: object) -> None:
        with self._lock:
            self._jobs[repo_id] = replace(self._jobs[repo_id], **changes)

    def _fail(self, repo_id: str, message: str) -> None:
        self._update(repo_id, status="error", message=message, error=message, finished=monotonic())

    def _run(self, source: ImportSource, refresh: bool) -> None:
        error = None
        result = ImportResult()
        try:
            self._update(source.id, status="cloning", message="Cloning repository")
            clones = self.store.data_dir / "repos"
            clone = clones / source.id
            output = self.store.data_dir / source.id
            if any(path.is_symlink() for path in (clones, clone, output)):
                raise ImportFailure("Import paths must be directories inside the data directory")
            clones.mkdir(parents=True, exist_ok=True)
            with TemporaryDirectory(dir=clones) as tmp:
                staged = Path(tmp) / source.id
                try:
                    token = self.clone_token(source)
                except GitHubError as exc:
                    raise ImportFailure(str(exc)) from exc
                result = self._analysis.run(
                    source,
                    self.git_url_builder(source.url),
                    clone,
                    output,
                    staged,
                    refresh=refresh,
                    report=partial(self._update, source.id),
                    token=token,
                )
                self.store.publish_import(source.id, staged)
        except ImportFailure as exc:
            error = str(exc)
        # Unexpected failures must still move the job to a terminal status.
        except Exception:  # noqa: BLE001
            error = ANALYSIS_ERROR

        finished = monotonic()
        with self._lock:
            self._jobs[source.id] = replace(
                self._jobs[source.id],
                status="error" if error else "ready",
                message=error or "Ready",
                error=error,
                warning=result.warning if error is None else None,
                new_commits=result.new_commits if error is None else None,
                finished=finished,
            )
