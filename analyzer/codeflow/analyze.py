"""Build, store, and load per-commit call graphs for a Git repository."""

import json
from collections import OrderedDict
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory

from codeflow.build import build_graph
from codeflow.git_history import batch_blobs, list_commits, list_python_files
from codeflow.graph import Commit, Graph
from codeflow.parse_python import ParsedFile, parse_file


class UnknownSHA(ValueError):
    """No indexed commit matches the requested SHA or prefix."""


class AmbiguousSHA(ValueError):
    """More than one indexed commit matches the requested prefix."""


class BlobParseCache:
    """Reuse parsed Python blobs for the same file path and source root."""

    def __init__(self, max_entries: int | None = None) -> None:
        self.max_entries = max_entries
        self._files: OrderedDict[tuple[str, str, str], ParsedFile | None] = OrderedDict()

    def parse(
        self, path: str, blob_sha: str, source_root: str, read_blob: Callable[[str], bytes]
    ) -> ParsedFile | None:
        key = (path, blob_sha, source_root)
        if key in self._files:
            self._files.move_to_end(key)
            return self._files[key]
        source = read_blob(blob_sha)
        try:
            source.decode("utf-8")
            parsed = parse_file(path, source, source_root)
        except (UnicodeDecodeError, RecursionError):
            parsed = None
        self._files[key] = parsed
        if self.max_entries is not None and len(self._files) > self.max_entries:
            self._files.popitem(last=False)
        return parsed


@dataclass
class CommitResult:
    """Report graph counts and any files skipped while writing this snapshot."""

    commit: Commit
    snapshot_path: Path
    node_count: int
    edge_count: int
    flag_count: int
    written: bool
    base: str
    skipped: list[str] = field(default_factory=list)


def _write_json(path: Path, data: dict) -> None:
    # Publish complete files so a retry never mistakes a partial snapshot for a finished one.
    with TemporaryDirectory(dir=path.parent) as directory:
        temporary_path = Path(directory) / path.name
        with temporary_path.open(
            "w", encoding="utf-8", errors="backslashreplace", newline="\n"
        ) as output:
            json.dump(data, output, indent=2, sort_keys=True, ensure_ascii=False)
            output.write("\n")
        temporary_path.replace(path)


def analyze_repo(
    repo: str | Path,
    out_dir: str | Path,
    branch: str = "HEAD",
    max_commits: int | None = None,
    include: Sequence[str] | None = None,
    exclude: Sequence[str] | None = None,
    source_root: str = "",
    keep_external: bool = False,
    on_progress: Callable[[int, int, Commit], None] | None = None,
    touching: str | None = None,
    parse_cache: BlobParseCache | None = None,
    on_analyzed: Callable[[], None] | None = None,
) -> list[CommitResult]:
    """Write missing snapshots and report progress before each indexed commit, oldest first."""
    repo = Path(repo).resolve()
    commits = list_commits(repo, branch, max_commits, paths=(touching,) if touching else None)
    oldest_base = []
    if commits and commits[0].parents:
        oldest_base = list_commits(repo, commits[0].parents[0], 1)
    snapshot_commits = oldest_base + commits
    base = oldest_base[0].sha if oldest_base else ""
    repo_name = repo.name
    out_dir = Path(out_dir)
    snapshots = out_dir / "snapshots"
    snapshots.mkdir(parents=True, exist_ok=True)
    root = PurePosixPath(source_root)
    cache = parse_cache if parse_cache is not None else BlobParseCache()
    results = []

    with batch_blobs(repo) as read_blob:
        for current, commit in enumerate(snapshot_commits, start=0 if oldest_base else 1):
            if current and on_progress is not None:
                on_progress(current, len(commits), commit)
            snapshot_path = snapshots / f"{commit.sha}.json"
            written = not snapshot_path.exists()
            if current == 0 and not written:
                continue
            skipped = []
            if written:
                parsed_files = []
                for path, blob_sha in list_python_files(repo, commit.sha, include, exclude):
                    if not PurePosixPath(path).is_relative_to(root):
                        continue
                    parsed = cache.parse(path, blob_sha, source_root, read_blob)
                    if parsed is None:
                        skipped.append(path)
                    else:
                        parsed_files.append(parsed)
                data = build_graph(parsed_files, repo_name, commit, keep_external).to_json()
                if on_analyzed is not None:
                    on_analyzed()
                _write_json(snapshot_path, data)
            else:
                data = json.loads(snapshot_path.read_text(encoding="utf-8"))
                # A shallow boundary can gain visible parents after the clone is deepened.
                metadata = asdict(commit)
                if data["commit"] != metadata:
                    data["commit"] = metadata
                    _write_json(snapshot_path, data)
                    written = True

            if current == 0:
                continue
            results.append(
                CommitResult(
                    commit,
                    snapshot_path,
                    len(data["nodes"]),
                    len(data["edges"]),
                    len(data["flags"]),
                    written,
                    base,
                    skipped,
                )
            )
            base = commit.sha

    _write_json(
        out_dir / "commits.json",
        {
            "schema": "code-flow/commits@1",
            "repo": repo_name,
            "repo_path": str(repo),
            "branch": branch,
            "source_root": source_root,
            "commits": [{**asdict(result.commit), "base": result.base} for result in results],
        },
    )
    return results


def load_index(out_dir: str | Path) -> dict:
    """Load the commit index and its repository metadata."""
    return json.loads((Path(out_dir) / "commits.json").read_text(encoding="utf-8"))


def load_commits(out_dir: str | Path) -> list[Commit]:
    """Load the commits in the index's oldest-first order."""
    return [
        Commit(**{key: value for key, value in entry.items() if key != "base"})
        for entry in load_index(out_dir)["commits"]
    ]


def diff_base(entry: dict) -> str:
    """Return the indexed base SHA, using the first parent for older indexes."""
    if "base" in entry:
        return entry["base"]
    return entry["parents"][0] if entry["parents"] else ""


def load_snapshot(out_dir: str | Path, sha: str) -> Graph:
    """Load the graph for a full commit SHA."""
    path = Path(out_dir) / "snapshots" / f"{sha}.json"
    return Graph.from_json(json.loads(path.read_text(encoding="utf-8")))


def resolve_sha(out_dir: str | Path, ref: str) -> str:
    """Find the full SHA for an indexed commit SHA or unique prefix."""
    return resolve_commit(load_index(out_dir), ref)["sha"]


def resolve_commit(index: dict, ref: str) -> dict:
    """Find the index entry for a commit SHA or unique prefix."""
    matches = [entry for entry in index["commits"] if ref and entry["sha"].startswith(ref)]
    if not matches:
        raise UnknownSHA(f"Unknown commit SHA or prefix: {ref!r}")
    if len(matches) > 1:
        raise AmbiguousSHA(f"Ambiguous commit SHA prefix: {ref!r}")
    return matches[0]
