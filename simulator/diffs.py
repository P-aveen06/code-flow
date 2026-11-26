"""Read diff sizes from local analyzer output."""

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

REPOS = ("Flagsmith__flagsmith", "shop-demo")
NODE_COUNTS = ("nodes_added", "nodes_removed", "nodes_changed")
EDGE_COUNTS = ("edges_added", "edges_removed")


def _read_snapshot(directory: Path, sha: str) -> tuple[dict[str, str], set[tuple[str, str]]]:
    if not sha:
        return {}, set()

    snapshot = json.loads((directory / "snapshots" / f"{sha}.json").read_text(encoding="utf-8"))
    nodes = {node["id"]: node["body_hash"] for node in snapshot["nodes"]}
    edges = {(edge["source"], edge["target"]) for edge in snapshot["edges"]}
    return nodes, edges


def _indexed_diff_size(stats: dict[str, int]) -> int | None:
    size = sum(stats[key] for key in NODE_COUNTS)
    return size if size or any(stats[key] for key in EDGE_COUNTS) else None


def _repo_diff_sizes(directory: Path) -> list[int]:
    commits: list[dict[str, Any]] = json.loads(
        (directory / "commits.json").read_text(encoding="utf-8")
    )["commits"]
    # Consecutive diffs usually share a snapshot. Keep only the two most recent graphs.
    load_snapshot = lru_cache(maxsize=2)(_read_snapshot)
    sizes = []
    for commit in commits:
        if "stats" in commit:
            size = _indexed_diff_size(commit["stats"])
            if size is not None:
                sizes.append(size)
            continue

        # The on-disk index may omit stats. Use the same node and edge comparisons
        # as the analyzer's diff_graphs and the same base as the viewer.
        base_sha = commit["base"] if "base" in commit else next(iter(commit["parents"]), "")
        base_nodes, base_edges = load_snapshot(directory, base_sha)
        head_nodes, head_edges = load_snapshot(directory, commit["sha"])
        added_or_removed = len(base_nodes.keys() ^ head_nodes.keys())
        changed = sum(
            base_nodes[node] != head_nodes[node] for node in base_nodes.keys() & head_nodes.keys()
        )
        size = added_or_removed + changed
        if size or base_edges != head_edges:
            sizes.append(size)
    return sizes


def load_diff_sizes(data_dir: Path) -> tuple[str, list[int]]:
    """Use Flagsmith commits if available, then try the analyzed shop demo."""
    for repo in REPOS:
        try:
            sizes = _repo_diff_sizes(data_dir / repo)
        except FileNotFoundError:
            continue
        if sizes:
            return repo, sizes
    raise ValueError(
        "No analyzed commits with flow changes. Import Flagsmith/flagsmith or analyze shop-demo first."
    )
