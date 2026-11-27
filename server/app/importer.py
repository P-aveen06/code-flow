"""Validate GitHub imports and run their Git and analysis work in a single worker."""

import json
import os
import re
import shutil
import subprocess
from collections.abc import Callable
from concurrent.futures import Executor, ThreadPoolExecutor
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath, PureWindowsPath
from tempfile import TemporaryDirectory
from threading import Lock
from time import monotonic

from codeflow.analyze import BlobParseCache, analyze_repo, load_index
from codeflow.git_history import list_commits
from codeflow.graph import Commit

from app.config import MAX_IMPORT_COMMITS
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
        }


class ImportFailure(RuntimeError):
    """An import error safe to show in the API."""


class RefreshUnavailable(ValueError):
    """The published repository was not imported from GitHub."""


class RefreshBusy(RuntimeError):
    """A queued or running job already owns this repository."""


@dataclass
class RefreshStats:
    """Per-process totals and the latest automatic refresh outcome."""

    last_started: str | None = None
    last_finished: str | None = None
    last_result: str | None = None
    new_commits: int | None = None
    error: str | None = None
    runs: int = 0
    fetches: int = 0
    analysed_commits: int = 0
    seconds: float = 0
    manual_runs: int = 0

    def finish(self, new_commits: int | None, error: str | None) -> None:
        self.last_finished = datetime.now(UTC).isoformat()
        self.last_result = "error" if error else "new_commits" if new_commits else "up_to_date"
        self.new_commits = new_commits
        self.error = error


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


def _refresh_limit(
    clone: Path,
    branch: str,
    source: ImportSource,
    previous_head: str,
    fetch: Callable[..., None],
    max_commits: int,
) -> int:
    if source.max_commits == max_commits:
        return max_commits
    git = ("-C", str(clone))
    history = _git(*git, "rev-list", "--first-parent", branch, error=UNAVAILABLE).splitlines()
    if previous_head not in history:
        if _git(*git, "rev-parse", "--is-shallow-repository", error=UNAVAILABLE) == "false":
            return source.max_commits
        # A shallow boundary can hide the old head even when the branch still contains it.
        fetch("--unshallow")
        history = _git(*git, "rev-list", "--first-parent", branch, error=UNAVAILABLE).splitlines()
        if previous_head not in history:
            return source.max_commits

    if not source.subdir:
        return min(max_commits, source.max_commits + history.index(previous_head))
    count = _git(
        *git,
        "--literal-pathspecs",
        "rev-list",
        "--first-parent",
        "--count",
        f"{previous_head}..{branch}",
        "--",
        source.subdir,
        error=UNAVAILABLE,
    )
    return min(max_commits, source.max_commits + int(count))


def _prepare_clone(
    clone: Path,
    url: str,
    source: ImportSource,
    previous_head: str | None,
    on_fetch: Callable[[], None],
    max_commits: int,
) -> tuple[str, int]:
    depth = max(4 * source.max_commits, 100)
    git = ("-C", str(clone))

    def fetch(*options: str) -> None:
        on_fetch()
        _git(*git, "fetch", *options, "origin", refspec, error=UNAVAILABLE)

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
        # Keep the existing shallow boundary when fetching new commits for a refresh.
        depth_args = () if previous_head else ("--depth", str(depth))
        fetch(*depth_args)
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

    limit = (
        _refresh_limit(clone, branch, source, previous_head, fetch, max_commits)
        if previous_head
        else source.max_commits
    )
    needed = limit + 1
    for _ in range(5):
        if len(list_commits(clone, branch, needed, paths=paths)) == needed:
            break
        if _git(*git, "rev-parse", "--is-shallow-repository", error=UNAVAILABLE) == "false":
            break
        fetch(f"--deepen={depth}")
    return branch, limit


class RepoImporter:
    """Own the import queue and keep a locked table of its jobs."""

    def __init__(
        self,
        store: Store,
        git_url_builder: Callable[[str], str] | None = None,
        executor: Executor | None = None,
        *,
        max_commits: int = MAX_IMPORT_COMMITS,
    ) -> None:
        self.store = store
        self.git_url_builder = git_url_builder or (lambda url: url)
        self.executor = executor if executor is not None else ThreadPoolExecutor(max_workers=1)
        self._owns_executor = executor is None
        self._max_commits = max_commits
        self._parse_cache = BlobParseCache(max_entries=5000)
        self._lock = Lock()
        self._jobs: dict[str, ImportJob] = {}
        self._refresh_stats: dict[str, RefreshStats] = {}

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

    def refresh(self, repo_id: str, *, automatic: bool = False) -> dict[str, str]:
        return self._start(repo_id, None, automatic=automatic)

    def refresh_stats(self) -> dict[str, dict]:
        with self._lock:
            return {repo_id: asdict(stats) for repo_id, stats in self._refresh_stats.items()}

    def record_auto_error(self, repo_id: str, message: str) -> None:
        with self._lock:
            self._refresh_stats.setdefault(repo_id, RefreshStats()).finish(None, message)

    def github_source(self, repo_id: str) -> ImportSource:
        """Validate published source metadata with the caller holding the store lock."""
        metadata = self.store.repo_source(repo_id)
        url = metadata.get("url") if isinstance(metadata, dict) else None
        if not isinstance(url, str) or GITHUB_URL.fullmatch(url) is None:
            raise RefreshUnavailable(
                "Only repositories imported from GitHub can check for new commits"
            )
        source = validate_import(metadata)
        if source.id != repo_id:
            raise BadRequest("The stored GitHub URL does not match the repository ID")
        return replace(source, max_commits=min(source.max_commits, self._max_commits))

    def _start(
        self, repo_id: str, source: ImportSource | None, *, automatic: bool = False
    ) -> dict[str, str]:
        refresh = source is None
        with self.store.lock, self._lock:
            job = self._jobs.get(repo_id)
            if job is not None and job.status in ACTIVE_STATUSES:
                if automatic:
                    raise RefreshBusy
                return {"id": repo_id, "status": job.status}
            if source is None:
                source = self.github_source(repo_id)
            self._jobs[repo_id] = ImportJob(source, monotonic())

        try:
            self.executor.submit(self._run, source, refresh, automatic)
        except RuntimeError:
            if automatic:
                self.record_auto_error(repo_id, "Could not queue repository import")
            self._fail(repo_id, "Could not queue repository import")
        return {"id": repo_id, "status": "queued"}

    def _update(self, repo_id: str, **changes: object) -> None:
        with self._lock:
            self._jobs[repo_id] = replace(self._jobs[repo_id], **changes)

    def _fail(self, repo_id: str, message: str) -> None:
        self._update(repo_id, status="error", message=message, error=message, finished=monotonic())

    def _run(self, source: ImportSource, refresh: bool, automatic: bool) -> None:
        started = monotonic()
        fetches = analysed_commits = 0
        new_commits = error = warning = None
        if refresh:
            with self._lock:
                stats = self._refresh_stats.setdefault(source.id, RefreshStats())
                if automatic:
                    stats.runs += 1
                    stats.last_started = datetime.now(UTC).isoformat()
                else:
                    stats.manual_runs += 1

        def count_fetch() -> None:
            nonlocal fetches
            fetches += 1

        def count_analysis() -> None:
            nonlocal analysed_commits
            analysed_commits += 1

        try:
            self._update(source.id, status="cloning", message="Cloning repository")
            clones = self.store.data_dir / "repos"
            clone = clones / source.id
            output = self.store.data_dir / source.id
            if any(path.is_symlink() for path in (clones, clone, output)):
                raise ImportFailure("Import paths must be directories inside the data directory")
            clones.mkdir(parents=True, exist_ok=True)
            try:
                index = load_index(output)
            except FileNotFoundError:
                index = {}
            previous_commits = [entry["sha"] for entry in index["commits"]] if refresh else []
            previous_head = previous_commits[-1] if previous_commits else None
            branch, limit = _prepare_clone(
                clone,
                self.git_url_builder(source.url),
                source,
                previous_head,
                count_fetch,
                self._max_commits,
            )
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
                self._reuse_snapshots(output, staged, source.subdir, index)
                results = analyze_repo(
                    clone,
                    staged,
                    branch=branch,
                    max_commits=limit,
                    source_root=source.subdir,
                    touching=source.subdir or None,
                    on_progress=progress,
                    parse_cache=self._parse_cache,
                    on_analyzed=count_analysis if automatic else None,
                )
                metadata = {
                    "url": source.url,
                    "name": source.name,
                    "subdir": source.subdir,
                    "max_commits": limit,
                    "imported_at": datetime.now(UTC).isoformat(),
                }
                (staged / "source.json").write_text(
                    json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
                )
                self.store.publish_import(source.id, staged)
            new_commits = (
                len({result.commit.sha for result in results}.difference(previous_commits))
                if refresh
                else None
            )
            warning = (
                python_warning(source.subdir) if not results or not results[-1].node_count else None
            )
        except ImportFailure as exc:
            error = str(exc)
        # Unexpected failures must still move the job to a terminal status.
        except Exception:  # noqa: BLE001
            error = "Could not analyze repository"

        finished = monotonic()
        with self._lock:
            if automatic:
                stats = self._refresh_stats[source.id]
                stats.fetches += fetches
                stats.analysed_commits += analysed_commits
                stats.seconds += finished - started
                stats.finish(new_commits if error is None else None, error)
            self._jobs[source.id] = replace(
                self._jobs[source.id],
                status="error" if error else "ready",
                message=error or "Ready",
                error=error,
                warning=warning,
                new_commits=new_commits if error is None else None,
                finished=finished,
            )

    @staticmethod
    def _reuse_snapshots(output: Path, staged: Path, source_root: str, index: dict) -> None:
        snapshots = output / "snapshots"
        if index and index.get("source_root", "") == source_root and snapshots.is_dir():
            # The analyzer replaces updated files atomically, so the old output stays readable.
            shutil.copytree(snapshots, staged / "snapshots", copy_function=os.link)
