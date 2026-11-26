"""Read analyzer output and assemble the API's commit and diff views."""

import subprocess
from dataclasses import asdict
from pathlib import Path, PurePosixPath
from threading import Lock

from codeflow.analyze import AmbiguousSHA, UnknownSHA, load_index, load_snapshot, resolve_sha
from codeflow.diff import EdgeChange, GraphDiff, diff_graphs, neighbourhood
from codeflow.graph import Graph
from codeflow.summary import summarize


class NotFound(LookupError):
    """The requested repository, commit, or file is unavailable."""


class BadRequest(ValueError):
    """A request parameter is invalid or ambiguous."""


def _valid_repo_name(name: str) -> bool:
    return bool(name) and name != "." and not any(part in name for part in ("/", "\\", "..", "\0"))


class Store:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir.resolve()
        self._snapshots: dict[tuple[Path, str], Graph] = {}
        self._snapshot_lock = Lock()
        self._commit_lists: dict[str, tuple[dict, dict]] = {}

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

    def _resolve_sha(self, directory: Path, sha: str) -> str:
        try:
            return resolve_sha(directory, sha)
        except (FileNotFoundError, IsADirectoryError) as exc:
            raise NotFound(f"Unknown repository: {directory.name!r}") from exc
        except UnknownSHA as exc:
            raise NotFound(str(exc)) from exc
        except AmbiguousSHA as exc:
            raise BadRequest(str(exc)) from exc

    def _snapshot(self, directory: Path, sha: str) -> Graph:
        key = (directory, sha)
        with self._snapshot_lock:
            if key not in self._snapshots:
                try:
                    graph = load_snapshot(directory, sha)
                except FileNotFoundError as exc:
                    raise NotFound(f"No snapshot for commit {sha}") from exc
                if len(self._snapshots) == 64:
                    del self._snapshots[next(iter(self._snapshots))]
                self._snapshots[key] = graph
            return self._snapshots[key]

    def _first_parent(self, directory: Path, head: Graph) -> Graph:
        if head.commit.parents:
            return self._snapshot(directory, head.commit.parents[0])
        return head.empty_base()

    def list_repos(self) -> list[dict]:
        if not self.data_dir.is_dir():
            return []
        repos = []
        for directory in sorted(self.data_dir.iterdir()):
            if _valid_repo_name(directory.name) and self._is_repo_dir(directory):
                try:
                    index = self._index(directory)
                except NotFound:
                    continue
                repos.append(
                    {
                        "name": directory.name,
                        "branch": index["branch"],
                        "commit_count": len(index["commits"]),
                    }
                )
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
            base = self._first_parent(directory, head)
            diff = diff_graphs(base, head)
            commits.append({**commit, "stats": diff.stats, "summary": summarize(base, head, diff)})
        result = {"repo": repo, "branch": index["branch"], "commits": commits}
        self._commit_lists[repo] = (index, result)
        return result

    def snapshot(self, repo: str, sha: str) -> dict:
        directory = self._repo_dir(repo)
        return self._snapshot(directory, self._resolve_sha(directory, sha)).to_json()

    def diff(self, repo: str, head: str, base: str | None, hops: int) -> dict:
        if not 0 <= hops <= 3:
            raise BadRequest("hops must be between 0 and 3")
        directory = self._repo_dir(repo)
        head_graph = self._snapshot(directory, self._resolve_sha(directory, head))
        base_graph = (
            self._first_parent(directory, head_graph)
            if base is None
            else self._snapshot(directory, self._resolve_sha(directory, base))
        )
        diff = diff_graphs(base_graph, head_graph)
        included = neighbourhood(base_graph, head_graph, diff, hops)
        return {
            "base": diff.base,
            "head": diff.head,
            "summary": summarize(base_graph, head_graph, diff),
            "diff": diff.to_json(),
            "nodes": _overlay_nodes(base_graph, head_graph, diff, included),
            "edges": _overlay_edges(base_graph, head_graph, diff, included),
        }

    def code(self, repo: str, sha: str, file: str, start: int | None, end: int | None) -> dict:
        path = PurePosixPath(file)
        if not path.parts or path.is_absolute() or ".." in path.parts or "\0" in file:
            raise BadRequest("file must be a relative path without '..'")
        if start is not None and end is not None and start > end:
            raise BadRequest("start must be less than or equal to end")

        directory = self._repo_dir(repo)
        sha = self._resolve_sha(directory, sha)
        repo_path = self._index(directory).get("repo_path")
        if not repo_path:
            raise NotFound(f"No source repository path recorded for {repo!r}. Re-run the analyzer.")
        git = ["git", "-C", repo_path]
        ref = f"{sha}:{path}"
        kind = subprocess.run([*git, "cat-file", "-t", ref], check=False, capture_output=True)
        if kind.returncode or kind.stdout.strip() != b"blob":
            raise NotFound(f"No file {file!r} at commit {sha}")
        source = subprocess.run([*git, "show", ref], check=False, capture_output=True)
        if source.returncode:
            raise NotFound(f"No file {file!r} at commit {sha}")

        lines = source.stdout.splitlines()
        first = max(1, min(start if start is not None else 1, len(lines)))
        last = max(1, min(end, len(lines))) if lines and end is not None else len(lines)
        return {
            "sha": sha,
            "file": file,
            "start": first,
            "end": last,
            "lines": [
                {"number": number, "text": line.decode("utf-8", errors="replace")}
                for number, line in enumerate(lines[first - 1 : last], start=first)
            ],
        }


def _overlay_nodes(base: Graph, head: Graph, diff: GraphDiff, included: set[str]) -> list[dict]:
    base_nodes = {node.id: node for node in base.nodes if node.id in included}
    head_nodes = {node.id: node for node in head.nodes if node.id in included}
    statuses = {
        node_id: status
        for status, ids in (
            ("added", diff.nodes.added),
            ("removed", diff.nodes.removed),
            ("changed", diff.nodes.changed),
        )
        for node_id in ids
    }
    return [
        {
            "id": node_id,
            "name": node.name,
            "qualname": node_id.split(":", 1)[-1],
            "module": node.module,
            "kind": node.kind,
            "file": node.file,
            "line": node.line,
            "end_line": node.end_line,
            "status": statuses.get(node_id, "context"),
            "in_base": node_id in base_nodes,
            "in_head": node_id in head_nodes,
        }
        for node_id, node in sorted((base_nodes | head_nodes).items())
    ]


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
