"""Validate GitHub imports and run their Git and analysis work in a single worker."""

import json
import os
import re
import shutil
import subprocess
from collections.abc import Callable
from concurrent.futures import Executor, ThreadPoolExecutor
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath, PureWindowsPath
from tempfile import TemporaryDirectory
from threading import Lock
from time import monotonic

from codeflow.analyze import BlobParseCache, analyze_repo, load_index
from codeflow.git_history import list_commits
from codeflow.graph import Commit

from app.store import BadRequest, Store, python_warning

GITHUB_URL = re.compile(r"https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/?")
ACTIVE_STATUSES = ("queued", "cloning", "analyzing")
UNAVAILABLE = "Repository not found or not public"


@dataclass(frozen=True)
class ImportSource:
    """Validated settings for a public GitHub repository import."""

    id: str
    name: str
    url: str
    subdir: str
    max_commits: int


def validate_import(payload: object) -> ImportSource:
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
    max_commits = payload.get("max_commits", 30)
    if type(max_commits) is not int or not 1 <= max_commits <= 200:
        raise BadRequest("max_commits must be an integer from 1 to 200")

    display_name = f"{owner}/{name}"
    return ImportSource(
        f"{owner}__{name}",
        display_name,
        f"https://github.com/{display_name}",
        path.as_posix() if path.parts else "",
        max_commits,
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
        }


class ImportFailure(RuntimeError):
    """An import error safe to show in the API."""


def _git(*args: str, error: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-c", "credential.helper=", "-c", "core.askPass=", *args],
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "", "SSH_ASKPASS": ""},
            capture_output=True,
            text=True,
            errors="replace",
            timeout=300,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ImportFailure("Timed out while cloning") from exc
    except OSError as exc:
        raise ImportFailure("Could not run Git") from exc
    if result.returncode:
        raise ImportFailure(error)
    return result.stdout.strip()


def _prepare_clone(clone: Path, url: str, source: ImportSource) -> str:
    depth = max(4 * source.max_commits, 100)
    git = ("-C", str(clone))
    if clone.exists():
        remote_head = _git("ls-remote", "--symref", url, "HEAD", error=UNAVAILABLE)
        first_line = remote_head.split("\n", 1)[0]
        if not first_line.startswith("ref: refs/heads/"):
            raise ImportFailure("Repository has no default branch")
        head = first_line.removeprefix("ref: ").split("\t", 1)[0]
        branch = f"refs/remotes/origin/{head.removeprefix('refs/heads/')}"
        if _git(*git, "remote", "get-url", "origin", error=UNAVAILABLE) != url:
            _git(*git, "remote", "set-url", "origin", url, error=UNAVAILABLE)
        refspec = f"+{head}:{branch}"
        _git(*git, "fetch", "--depth", str(depth), "origin", refspec, error=UNAVAILABLE)
    else:
        with TemporaryDirectory(dir=clone.parent) as tmp:
            staged = Path(tmp) / clone.name
            _git(
                "clone",
                "--depth",
                str(depth),
                "--single-branch",
                "--no-checkout",
                "--",
                url,
                str(staged),
                error=UNAVAILABLE,
            )
            branch = _git(
                "-C",
                str(staged),
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                error="Repository has no default branch",
            )
            staged.rename(clone)
        refspec = f"+refs/heads/{branch.removeprefix('refs/remotes/origin/')}:{branch}"

    paths = (source.subdir,) if source.subdir else None
    if source.subdir:
        missing = f"Subfolder {source.subdir}/ does not exist in this repository"
        kind = _git(*git, "cat-file", "-t", f"{branch}:{source.subdir}", error=missing)
        if kind != "tree":
            raise ImportFailure(missing)

    needed = source.max_commits + 1
    for _ in range(5):
        if len(list_commits(clone, branch, needed, paths=paths)) == needed:
            break
        if _git(*git, "rev-parse", "--is-shallow-repository", error=UNAVAILABLE) == "false":
            break
        _git(*git, "fetch", f"--deepen={depth}", "origin", refspec, error=UNAVAILABLE)
    return branch


class RepoImporter:
    """Own the import queue and keep a locked table of its jobs."""

    def __init__(
        self,
        store: Store,
        git_url_builder: Callable[[str], str] | None = None,
        executor: Executor | None = None,
    ) -> None:
        self.store = store
        self.git_url_builder = git_url_builder or (lambda url: url)
        self.executor = executor if executor is not None else ThreadPoolExecutor(max_workers=1)
        self._owns_executor = executor is None
        self._parse_cache = BlobParseCache(max_entries=5000)
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
        with self._lock:
            job = self._jobs.get(source.id)
            if job is not None and job.status in ACTIVE_STATUSES:
                return {"id": source.id, "status": job.status}
            self._jobs[source.id] = ImportJob(source, monotonic())

        try:
            self.executor.submit(self._run, source)
        except RuntimeError:
            self._fail(source.id, "Could not queue repository import")
        return {"id": source.id, "status": "queued"}

    def _update(self, repo_id: str, **changes: object) -> None:
        with self._lock:
            self._jobs[repo_id] = replace(self._jobs[repo_id], **changes)

    def _fail(self, repo_id: str, message: str) -> None:
        self._update(repo_id, status="error", message=message, error=message, finished=monotonic())

    def _run(self, source: ImportSource) -> None:
        try:
            self._update(source.id, status="cloning", message="Cloning repository")
            clones = self.store.data_dir / "repos"
            clone = clones / source.id
            output = self.store.data_dir / source.id
            if any(path.is_symlink() for path in (clones, clone, output)):
                raise ImportFailure("Import paths must be directories inside the data directory")
            clones.mkdir(parents=True, exist_ok=True)
            branch = _prepare_clone(clone, self.git_url_builder(source.url), source)
            self._update(
                source.id,
                status="analyzing",
                message="Analyzing repository",
                branch=branch.removeprefix("refs/remotes/origin/"),
            )

            def progress(current: int, total: int, _commit: Commit) -> None:
                self._update(
                    source.id,
                    current=current,
                    total=total,
                    message=f"Analyzing commit {current} of {total}",
                )

            with TemporaryDirectory(dir=clones) as tmp:
                staged = Path(tmp) / source.id
                self._reuse_snapshots(output, staged, source.subdir)
                results = analyze_repo(
                    clone,
                    staged,
                    branch=branch,
                    max_commits=source.max_commits,
                    source_root=source.subdir,
                    touching=source.subdir or None,
                    on_progress=progress,
                    parse_cache=self._parse_cache,
                )
                metadata = {
                    "url": source.url,
                    "name": source.name,
                    "subdir": source.subdir,
                    "max_commits": source.max_commits,
                    "imported_at": datetime.now(UTC).isoformat(),
                }
                (staged / "source.json").write_text(
                    json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
                )
                self.store.publish_import(source.id, staged)
            warning = (
                python_warning(source.subdir) if not results or not results[-1].node_count else None
            )
            self._update(
                source.id, status="ready", message="Ready", warning=warning, finished=monotonic()
            )
        except ImportFailure as exc:
            self._fail(source.id, str(exc))
        # Unexpected failures must still move the job to a terminal status.
        except Exception:  # noqa: BLE001
            self._fail(source.id, "Could not analyze repository")

    @staticmethod
    def _reuse_snapshots(output: Path, staged: Path, source_root: str) -> None:
        try:
            index = load_index(output)
        except FileNotFoundError:
            return
        snapshots = output / "snapshots"
        if index.get("source_root", "") == source_root and snapshots.is_dir():
            # The analyzer replaces updated files atomically, so the old output stays readable.
            shutil.copytree(snapshots, staged / "snapshots", copy_function=os.link)
