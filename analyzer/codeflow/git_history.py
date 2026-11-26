"""Read commit metadata and file contents from Git without checking out commits."""

import os
import subprocess
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime
from fnmatch import fnmatchcase
from pathlib import Path

from codeflow.graph import Commit

DEFAULT_INCLUDE = ("**/*.py",)
DEFAULT_EXCLUDE = (
    "**/tests/**",
    "**/test_*.py",
    "**/*_test.py",
    "**/conftest.py",
    "**/migrations/**",
)


class GitHistoryError(RuntimeError):
    """Git could not read the requested repository, commit, or blob."""


def _git(repo: str | Path, *args: str, error: str | None = None) -> bytes:
    try:
        result = subprocess.run(["git", "-C", str(repo), *args], check=False, capture_output=True)
    except FileNotFoundError as exc:
        raise GitHistoryError("Git executable not found") from exc
    if result.returncode:
        detail = result.stderr.decode(errors="replace").strip()
        message = error or f"git {args[0]} failed in {repo}"
        raise GitHistoryError(f"{message}: {detail}" if detail else message)
    return result.stdout


def list_commits(
    repo: str | Path,
    branch: str = "HEAD",
    max_count: int | None = None,
    paths: Sequence[str] | None = None,
) -> list[Commit]:
    """Return first-parent commits affecting the given paths, oldest first."""
    _git(repo, "rev-parse", "--git-dir", error=f"Not a Git repository: {repo}")
    tip = (
        _git(
            repo,
            "rev-parse",
            "--verify",
            "--end-of-options",
            f"{branch}^{{commit}}",
            error=f"Unknown Git branch or ref {branch!r} in {repo}",
        )
        .decode()
        .strip()
    )

    args = [
        "--literal-pathspecs",
        "rev-list",
        "--first-parent",
        "--reverse",
        "--no-commit-header",
        "--encoding=UTF-8",
        "--format=%H%x00%P%x00%an%x00%aI%x00%s",
    ]
    if max_count is not None:
        if max_count < 0:
            raise ValueError("max_count must be non-negative")
        args.append(f"--max-count={max_count}")

    commits = []
    for line in _git(repo, *args, tip, "--", *(paths or ())).decode(errors="replace").split("\n"):
        if not line:
            continue
        sha, parents, author, date, message = line.split("\0", 4)
        utc = datetime.fromisoformat(date).astimezone(UTC).isoformat().replace("+00:00", "Z")
        commits.append(Commit(sha, parents.split(), author, utc, message))
    return commits


def _matches(path: str, patterns: Sequence[str]) -> bool:
    return any(
        fnmatchcase(path, pattern) or (pattern.startswith("**/") and fnmatchcase(path, pattern[3:]))
        for pattern in patterns
    )


def list_python_files(
    repo: str | Path,
    sha: str,
    include: Sequence[str] | None = None,
    exclude: Sequence[str] | None = None,
) -> list[tuple[str, str]]:
    """Return matching repository-relative paths and their blob IDs at one commit."""
    include = DEFAULT_INCLUDE if include is None else include
    exclude = DEFAULT_EXCLUDE if exclude is None else exclude
    entries = _git(repo, "ls-tree", "-rz", "--full-tree", sha, "--").split(b"\0")
    files = []
    for entry in entries:
        if not entry:
            continue
        metadata, raw_path = entry.split(b"\t", 1)
        _, kind, blob_sha = metadata.split()
        path = os.fsdecode(raw_path)
        if kind == b"blob" and _matches(path, include) and not _matches(path, exclude):
            files.append((path, blob_sha.decode()))
    return files


def read_blob(repo: str | Path, blob_sha: str) -> bytes:
    """Read the exact bytes stored in a Git blob."""
    return _git(repo, "cat-file", "blob", blob_sha)


@contextmanager
def batch_blobs(repo: str | Path) -> Iterator[Callable[[str], bytes]]:
    """Read blobs by SHA through a single Git process for this analysis."""
    try:
        process = subprocess.Popen(
            ["git", "-C", str(repo), "cat-file", "--batch"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise GitHistoryError("Git executable not found") from exc

    with process:
        request, response = process.stdin, process.stdout
        assert request is not None and response is not None

        def read(blob_sha: str) -> bytes:
            try:
                request.write(f"{blob_sha}\n".encode())
                request.flush()
            except BrokenPipeError as exc:
                raise GitHistoryError(f"git cat-file failed while reading blob {blob_sha}") from exc

            # Git sends an object header, the exact payload bytes, then a newline.
            header = response.readline().split()
            if len(header) != 3:
                raise GitHistoryError(f"Cannot read Git blob {blob_sha} in {repo}")
            size = int(header[2])
            source = response.read(size)
            if len(source) != size or response.read(1) != b"\n":
                raise GitHistoryError(f"Incomplete Git blob {blob_sha} in {repo}")
            if header[1] != b"blob":
                raise GitHistoryError(f"Git object {blob_sha} in {repo} is not a blob")
            return source

        yield read
