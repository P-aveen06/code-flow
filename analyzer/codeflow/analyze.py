"""Build, store, and load per-commit call graphs for a Git repository."""

import json
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory

from codeflow.build import build_graph
from codeflow.git_history import list_commits, list_python_files, read_blob
from codeflow.graph import Commit, Graph
from codeflow.parse_python import ParsedFile, parse_file


@dataclass
class CommitResult:
    """Report graph counts and any files skipped while writing this snapshot."""

    commit: Commit
    snapshot_path: Path
    node_count: int
    edge_count: int
    flag_count: int
    written: bool
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
) -> list[CommitResult]:
    """Write missing snapshots and the commit index, then report results oldest first."""
    commits = list_commits(repo, branch, max_commits)
    repo_name = Path(repo).resolve().name
    out_dir = Path(out_dir)
    snapshots = out_dir / "snapshots"
    snapshots.mkdir(parents=True, exist_ok=True)
    root = PurePosixPath(source_root)
    cache: dict[tuple[str, str], ParsedFile | None] = {}
    results = []

    for commit in commits:
        snapshot_path = snapshots / f"{commit.sha}.json"
        written = not snapshot_path.exists()
        skipped = []
        if written:
            parsed_files = []
            for path, blob_sha in list_python_files(repo, commit.sha, include, exclude):
                if not PurePosixPath(path).is_relative_to(root):
                    continue
                key = (path, blob_sha)
                if key not in cache:
                    source = read_blob(repo, blob_sha)
                    try:
                        source.decode("utf-8")
                        cache[key] = parse_file(path, source, source_root)
                    except (UnicodeDecodeError, RecursionError):
                        cache[key] = None
                parsed = cache[key]
                if parsed is None:
                    skipped.append(path)
                else:
                    parsed_files.append(parsed)
            graph = build_graph(parsed_files, repo_name, commit, keep_external)
            _write_json(snapshot_path, graph.to_json())
        else:
            graph = load_snapshot(out_dir, commit.sha)

        results.append(
            CommitResult(
                commit,
                snapshot_path,
                len(graph.nodes),
                len(graph.edges),
                len(graph.flags),
                written,
                skipped,
            )
        )

    _write_json(
        out_dir / "commits.json",
        {
            "schema": "code-flow/commits@1",
            "repo": repo_name,
            "branch": branch,
            "source_root": source_root,
            "commits": [asdict(commit) for commit in commits],
        },
    )
    return results


def load_commits(out_dir: str | Path) -> list[Commit]:
    """Load the commits in the index's oldest-first order."""
    data = json.loads((Path(out_dir) / "commits.json").read_text(encoding="utf-8"))
    return [Commit(**commit) for commit in data["commits"]]


def load_snapshot(out_dir: str | Path, sha: str) -> Graph:
    """Load the graph for a full commit SHA."""
    path = Path(out_dir) / "snapshots" / f"{sha}.json"
    return Graph.from_json(json.loads(path.read_text(encoding="utf-8")))


def resolve_sha(out_dir: str | Path, ref: str) -> str:
    """Find the full SHA for an indexed commit SHA or unique prefix."""
    matches = [commit.sha for commit in load_commits(out_dir) if ref and commit.sha.startswith(ref)]
    if not matches:
        raise ValueError(f"Unknown commit SHA or prefix: {ref!r}")
    if len(matches) > 1:
        raise ValueError(f"Ambiguous commit SHA prefix: {ref!r}")
    return matches[0]
