"""Prepare repository imports and refreshes with Git and the Python analyzer."""

import json
import os
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from codeflow.analyze import BlobParseCache, analyze_repo, load_index
from codeflow.git_history import list_commits
from codeflow.graph import Commit

from app.store import python_warning

UNAVAILABLE = "Repository not found or not public"
ANALYSIS_ERROR = "Could not analyze repository"


@dataclass(frozen=True)
class ImportSource:
    """Validated settings for a public GitHub repository import."""

    id: str
    name: str
    url: str
    subdir: str
    max_commits: int


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
    staged_clone: Path,
    url: str,
    source: ImportSource,
    previous_head: str | None,
    max_commits: int,
) -> tuple[str, int]:
    depth = max(4 * source.max_commits, 100)
    git = ("-C", str(clone))

    def fetch(*options: str) -> None:
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
        _git(
            "clone",
            "--depth",
            str(depth),
            "--single-branch",
            "--no-checkout",
            "--",
            url,
            str(staged_clone),
            error=UNAVAILABLE,
        )
        branch = _git(
            "-C",
            str(staged_clone),
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            error="Repository has no default branch",
        )
        staged_clone.rename(clone)
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


@dataclass(frozen=True)
class ImportResult:
    new_commits: int | None = None
    warning: str | None = None


class ImportAnalysis:
    """Build staged output with a parse cache shared by imports and refreshes."""

    def __init__(self, max_commits: int) -> None:
        self._max_commits = max_commits
        self._parse_cache = BlobParseCache(max_entries=5000)

    def run(
        self,
        source: ImportSource,
        url: str,
        clone: Path,
        output: Path,
        staged: Path,
        *,
        refresh: bool,
        report: Callable[..., None],
    ) -> ImportResult:
        try:
            index = load_index(output)
        except FileNotFoundError:
            index = {}
        previous_commits = [entry["sha"] for entry in index["commits"]] if refresh else []
        previous_head = previous_commits[-1] if previous_commits else None
        branch, limit = _prepare_clone(
            clone,
            staged.parent / "clone",
            url,
            source,
            previous_head,
            self._max_commits,
        )
        report(
            status="analyzing",
            message="Analyzing repository",
            branch=branch.removeprefix("refs/remotes/origin/"),
        )

        def progress(current: int, total: int, _commit: Commit) -> None:
            report(
                current=current,
                total=total,
                message=f"Analyzing commit {current} of {total}",
            )

        snapshots = output / "snapshots"
        if index and index.get("source_root", "") == source.subdir and snapshots.is_dir():
            # The analyzer replaces updated files atomically, so the old output stays readable.
            shutil.copytree(snapshots, staged / "snapshots", copy_function=os.link)

        results = analyze_repo(
            clone,
            staged,
            branch=branch,
            max_commits=limit,
            source_root=source.subdir,
            touching=source.subdir or None,
            on_progress=progress,
            parse_cache=self._parse_cache,
        )
        metadata = {
            "url": source.url,
            "name": source.name,
            "subdir": source.subdir,
            "max_commits": limit,
            "imported_at": datetime.now(UTC).isoformat(),
        }
        (staged / "source.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        new_commits = (
            len({result.commit.sha for result in results}.difference(previous_commits))
            if refresh
            else None
        )
        warning = (
            python_warning(source.subdir) if not results or not results[-1].node_count else None
        )
        return ImportResult(new_commits, warning)
