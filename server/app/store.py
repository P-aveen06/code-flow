"""Read analyzer output and assemble the API's commit and diff views."""

import json
import subprocess
from dataclasses import asdict
from pathlib import Path, PurePosixPath
from threading import Lock

from codeflow.analyze import (
    AmbiguousSHA,
    UnknownSHA,
    diff_base,
    load_index,
    load_snapshot,
    resolve_commit,
)
from codeflow.diff import (
    LONG_FLOW_MIN_DEPTH,
    EdgeChange,
    GraphDiff,
    diff_graphs,
    flow_depth,
    neighbourhood,
)
from codeflow.graph import FlagCheck, Graph, Node
from codeflow.line_changes import LineDiff, LineRow, line_changes
from codeflow.summary import summarize


class NotFound(LookupError):
    """The requested repository, commit, or file is unavailable."""


class BadRequest(ValueError):
    """A request parameter is invalid or ambiguous."""


def _valid_repo_name(name: str) -> bool:
    return (
        bool(name)
        and name not in (".", "repos")
        and not any(part in name for part in ("/", "\\", "..", "\0"))
    )


def python_warning(subdir: str) -> str:
    """Explain why an imported repository has an empty graph."""
    location = f"{subdir}/" if subdir else "the repository"
    return f"No Python files found in {location}. code-flow analyzes Python only for now."


class Store:
    def __init__(self, data_dir: Path, *, long_flow_min_depth: int = LONG_FLOW_MIN_DEPTH) -> None:
        self.data_dir = data_dir.resolve()
        self.long_flow_min_depth = long_flow_min_depth
        self.lock = Lock()
        self._snapshots: dict[tuple[Path, str], Graph] = {}
        self._commit_lists: dict[str, tuple[dict, dict]] = {}
        self._flag_checks: dict[tuple[Path, str], list[FlagCheck]] = {}
        self._files: dict[tuple[str, str, str], list[str]] = {}

    def _is_repo_dir(self, directory: Path) -> bool:
        return directory.is_dir() and directory.resolve().parent == self.data_dir

    def _repo_dir(self, name: str) -> Path:
        if not _valid_repo_name(name):
            raise BadRequest(f"Invalid repository name: {name!r}")
        directory = self.data_dir / name
        if not self._is_repo_dir(directory):
            raise NotFound(f"Unknown repository: {name!r}")
        return directory

    def _index(self, directory: Path) -> dict:
        try:
            return load_index(directory)
        except (FileNotFoundError, IsADirectoryError) as exc:
            raise NotFound(f"Unknown repository: {directory.name!r}") from exc

    def _resolve_commit(self, index: dict, sha: str) -> dict:
        try:
            return resolve_commit(index, sha)
        except UnknownSHA as exc:
            raise NotFound(str(exc)) from exc
        except AmbiguousSHA as exc:
            raise BadRequest(str(exc)) from exc

    def _snapshot(self, directory: Path, sha: str) -> Graph:
        key = (directory, sha)
        if key not in self._snapshots:
            try:
                graph = load_snapshot(directory, sha)
            except FileNotFoundError as exc:
                raise NotFound(f"No snapshot for commit {sha}") from exc
            if len(self._snapshots) == 64:
                del self._snapshots[next(iter(self._snapshots))]
            self._snapshots[key] = graph
        return self._snapshots[key]

    def _default_base(self, directory: Path, head: Graph, entry: dict) -> Graph:
        sha = diff_base(entry)
        return self._snapshot(directory, sha) if sha else head.empty_base()

    def publish_import(self, repo_id: str, staged: Path) -> None:
        """Swap a complete import into place while excluding API readers."""
        directory = self.data_dir / repo_id
        previous = staged.with_name("previous")
        with self.lock:
            if directory.exists():
                directory.rename(previous)
            try:
                staged.rename(directory)
            except OSError:
                if previous.exists():
                    previous.rename(directory)
                raise
            self._commit_lists.pop(repo_id, None)
            self._snapshots = {
                key: graph for key, graph in self._snapshots.items() if key[0] != directory
            }
            self._flag_checks = {
                key: checks for key, checks in self._flag_checks.items() if key[0] != directory
            }

    @staticmethod
    def _read_source(directory: Path) -> dict:
        try:
            return json.loads((directory / "source.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}

    def repo_source(self, repo: str) -> dict:
        """Read the source settings of a published repository."""
        directory = self._repo_dir(repo)
        self._index(directory)
        return self._read_source(directory)

    def repo_info(self, repo: str) -> dict:
        directory = self._repo_dir(repo)
        index = self._index(directory)
        source = self._read_source(directory)
        commits = index["commits"]
        subdir = source.get("subdir", "")
        warning = None
        if source and (not commits or not self._snapshot(directory, commits[-1]["sha"]).nodes):
            warning = python_warning(subdir)
        return {
            "id": repo,
            "name": source.get("name", repo),
            "url": source.get("url"),
            "subdir": subdir,
            "branch": self._branch(index),
            "commit_count": len(commits),
            "status": "ready",
            "message": "Ready",
            "warning": warning,
        }

    @staticmethod
    def _branch(index: dict) -> str:
        return index["branch"].removeprefix("refs/remotes/origin/")

    def list_repos(self) -> list[dict]:
        if not self.data_dir.is_dir():
            return []
        repos = []
        for directory in self.data_dir.iterdir():
            if not _valid_repo_name(directory.name):
                continue
            try:
                repos.append(self.repo_info(directory.name))
            except NotFound:
                continue
        return repos

    def commits(self, repo: str) -> dict:
        directory = self._repo_dir(repo)
        index = self._index(directory)
        cached = self._commit_lists.get(repo)
        if cached and cached[0] == index:
            return cached[1]

        commits = []
        for commit in index["commits"]:
            head = self._snapshot(directory, commit["sha"])
            base = self._default_base(directory, head, commit)
            diff = diff_graphs(base, head)
            commits.append({**commit, "stats": diff.stats, "summary": summarize(base, head, diff)})
        result = {"repo": repo, "branch": self._branch(index), "commits": commits}
        self._commit_lists[repo] = (index, result)
        return result

    def snapshot(self, repo: str, sha: str) -> dict:
        directory = self._repo_dir(repo)
        entry = self._resolve_commit(self._index(directory), sha)
        return self._snapshot(directory, entry["sha"]).to_json()

    def flag_history(self, repo: str, sha: str | None) -> tuple[Graph, list[list[FlagCheck]]]:
        """Load the selected graph and flag checks from preceding listed commits."""
        directory = self._repo_dir(repo)
        index = self._index(directory)
        commits = index["commits"]
        if not commits:
            raise NotFound(f"No analyzed commits for {repo!r}")
        entry = commits[-1] if sha is None else self._resolve_commit(index, sha)
        snapshot = self._snapshot(directory, entry["sha"])
        earlier_checks = [
            self._snapshot_checks(directory, commit["sha"])
            for commit in commits[: commits.index(entry)]
        ]
        return snapshot, earlier_checks

    def _snapshot_checks(self, directory: Path, sha: str) -> list[FlagCheck]:
        key = (directory, sha)
        if key in self._snapshots:
            return self._snapshots[key].flags
        if key not in self._flag_checks:
            path = directory / "snapshots" / f"{sha}.json"
            try:
                snapshot = json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                # Without this snapshot we cannot establish unchanged checks.
                return []
            self._flag_checks[key] = [FlagCheck(**check) for check in snapshot["flags"]]
        return self._flag_checks[key]

    def _diff_graphs(
        self, directory: Path, index: dict, head: str, base: str | None
    ) -> tuple[Graph, Graph]:
        entry = self._resolve_commit(index, head)
        head_graph = self._snapshot(directory, entry["sha"])
        base_graph = (
            self._default_base(directory, head_graph, entry)
            if base is None
            else self._snapshot(directory, self._resolve_commit(index, base)["sha"])
        )
        return base_graph, head_graph

    def diff(self, repo: str, head: str, base: str | None, hops: int) -> dict:
        if not 0 <= hops <= 3:
            raise BadRequest("hops must be between 0 and 3")
        directory = self._repo_dir(repo)
        index = self._index(directory)
        base_graph, head_graph = self._diff_graphs(directory, index, head, base)
        diff = diff_graphs(base_graph, head_graph)
        included = neighbourhood(base_graph, head_graph, diff, hops)
        depth = flow_depth(base_graph, head_graph, diff, hops)
        return {
            "base": diff.base,
            "head": diff.head,
            "summary": summarize(base_graph, head_graph, diff),
            "diff": diff.to_json(),
            "flow_depth": depth,
            "long_flow": depth >= self.long_flow_min_depth,
            "nodes": self._overlay_nodes(repo, index, base_graph, head_graph, included),
            "edges": _overlay_edges(base_graph, head_graph, diff, included),
        }

    @staticmethod
    def _file_path(file: str) -> str:
        path = PurePosixPath(file)
        if not path.parts or path.is_absolute() or ".." in path.parts or "\0" in file:
            raise BadRequest("file must be a relative path without '..'")
        return str(path)

    def _file_lines(self, repo: str, index: dict, sha: str, file: str) -> list[str]:
        path = self._file_path(file)
        repo_path = index.get("repo_path")
        if not repo_path:
            raise NotFound(f"No source repository path recorded for {repo!r}. Re-run the analyzer.")
        key = (repo_path, sha, path)
        if key not in self._files:
            source = subprocess.run(
                ["git", "-C", repo_path, "cat-file", "blob", f"{sha}:{path}"],
                check=False,
                capture_output=True,
            )
            if source.returncode:
                raise NotFound(f"No file {file!r} at commit {sha}")
            if len(self._files) == 512:
                del self._files[next(iter(self._files))]
            self._files[key] = [
                line.decode("utf-8", errors="replace") for line in source.stdout.splitlines()
            ]
        return self._files[key]

    def code(self, repo: str, sha: str, file: str, start: int | None, end: int | None) -> dict:
        self._file_path(file)
        if start is not None and end is not None and start > end:
            raise BadRequest("start must be less than or equal to end")

        directory = self._repo_dir(repo)
        index = self._index(directory)
        sha = self._resolve_commit(index, sha)["sha"]
        lines = self._file_lines(repo, index, sha, file)
        first = max(1, min(start if start is not None else 1, len(lines)))
        last = max(1, min(end, len(lines))) if lines and end is not None else len(lines)
        return {
            "sha": sha,
            "file": file,
            "start": first,
            "end": last,
            "lines": [
                {"number": number, "text": line}
                for number, line in enumerate(lines[first - 1 : last], start=first)
            ],
        }

    def _node_lines(self, repo: str, index: dict, sha: str, node: Node | None) -> list[str]:
        if node is None:
            return []
        if not node.file or node.line < 1:
            raise NotFound(f"No source location for node {node.id!r} at commit {sha}")
        lines = self._file_lines(repo, index, sha, node.file)
        return lines[node.line - 1 : node.end_line]

    def _overlay_nodes(
        self, repo: str, index: dict, base: Graph, head: Graph, included: set[str]
    ) -> list[dict]:
        base_nodes = {node.id: node for node in base.nodes if node.id in included}
        head_nodes = {node.id: node for node in head.nodes if node.id in included}
        nodes = []
        for node_id, node in sorted((base_nodes | head_nodes).items()):
            before, after = base_nodes.get(node_id), head_nodes.get(node_id)
            status = _node_status(before, after)
            added = removed = 0
            if status != "context":
                try:
                    base_lines = self._node_lines(repo, index, base.commit.sha, before)
                    head_lines = self._node_lines(repo, index, head.commit.sha, after)
                    if before is not None and after is not None:
                        changes = line_changes(base_lines, head_lines, before.line, after.line)
                        added, removed = changes.lines_added, changes.lines_removed
                    else:
                        added, removed = len(head_lines), len(base_lines)
                except (NotFound, BadRequest):
                    added = removed = None
            nodes.append(
                {
                    "id": node_id,
                    "name": node.name,
                    "qualname": node_id.split(":", 1)[-1],
                    "module": node.module,
                    "kind": node.kind,
                    "file": node.file,
                    "line": node.line,
                    "end_line": node.end_line,
                    "status": status,
                    "in_base": before is not None,
                    "in_head": after is not None,
                    "lines_added": added,
                    "lines_removed": removed,
                }
            )
        return nodes

    def function_diff(self, repo: str, head: str, node: str, base: str | None) -> dict:
        directory = self._repo_dir(repo)
        index = self._index(directory)
        base_graph, head_graph = self._diff_graphs(directory, index, head, base)
        base_sha, head_sha = base_graph.commit.sha, head_graph.commit.sha
        before = next((item for item in base_graph.nodes if item.id == node), None)
        after = next((item for item in head_graph.nodes if item.id == node), None)
        location = after or before
        if location is None:
            raise NotFound(f"Unknown node: {node!r}")
        status = _node_status(before, after)
        changes = line_changes(
            self._node_lines(repo, index, base_sha, before),
            self._node_lines(repo, index, head_sha, after),
            before.line if before else 1,
            after.line if after else 1,
        )
        if status == "context":
            # The graph ignores comments and whitespace. Show head text and map matching base lines.
            changes = LineDiff(
                [
                    LineRow("context", row.base_line, row.head_line, row.text)
                    for row in changes.rows
                    if row.head_line is not None
                ],
                0,
                0,
            )
        return {
            "node": node,
            "base": base_sha,
            "head": head_sha,
            "file": location.file,
            "status": status,
            **asdict(changes),
        }


def _node_status(before: Node | None, after: Node | None) -> str:
    if before is None:
        return "added"
    if after is None:
        return "removed"
    return "changed" if before.body_hash != after.body_hash else "context"


def _overlay_edges(base: Graph, head: Graph, diff: GraphDiff, included: set[str]) -> list[dict]:
    base_edges = {
        EdgeChange(edge.source, edge.target): edge
        for edge in base.edges
        if edge.source in included and edge.target in included
    }
    head_edges = {
        EdgeChange(edge.source, edge.target): edge
        for edge in head.edges
        if edge.source in included and edge.target in included
    }
    statuses = {key: "added" for key in diff.edges.added}
    statuses.update({key: "removed" for key in diff.edges.removed})
    return [
        {
            "source": key.source,
            "target": key.target,
            "status": statuses.get(key, "context"),
            "guard": asdict(edge.guard) if edge.guard else None,
            "in_base": key in base_edges,
            "in_head": key in head_edges,
        }
        for key, edge in sorted((base_edges | head_edges).items())
    ]
