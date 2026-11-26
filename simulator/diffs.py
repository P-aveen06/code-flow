"""Sample sizes and depths from local analyzer output."""

from dataclasses import dataclass
from functools import lru_cache, partial
from pathlib import Path

from codeflow.analyze import diff_base, load_index, load_snapshot
from codeflow.diff import LONG_FLOW_MIN_DEPTH, diff_graphs, flow_depth

REPOS = ("Flagsmith__flagsmith", "shop-demo")
NODE_COUNTS = ("nodes_added", "nodes_removed", "nodes_changed")
EDGE_COUNTS = ("edges_added", "edges_removed")


@dataclass(frozen=True)
class DiffSample:
    size: int
    depth: int = 0


def _diff_size(stats: dict[str, int]) -> int | None:
    size = sum(stats[key] for key in NODE_COUNTS)
    return size if size or any(stats[key] for key in EDGE_COUNTS) else None


def _repo_diffs(directory: Path, *, long_flows_only: bool) -> list[DiffSample]:
    commits = load_index(directory)["commits"]
    # Consecutive diffs usually share a snapshot. Keep only the two most recent graphs.
    snapshot = lru_cache(maxsize=2)(partial(load_snapshot, directory))
    samples = []
    for commit in commits:
        if not long_flows_only and "stats" in commit:
            size = _diff_size(commit["stats"])
            if size is not None:
                samples.append(DiffSample(size))
            continue

        head = snapshot(commit["sha"])
        base_sha = diff_base(commit)
        base = snapshot(base_sha) if base_sha else head.empty_base()
        diff = diff_graphs(base, head)
        size = _diff_size(diff.stats)
        if size is None:
            continue
        depth = flow_depth(base, head, diff) if long_flows_only else 0
        if not long_flows_only or depth >= LONG_FLOW_MIN_DEPTH:
            samples.append(DiffSample(size, depth))
    return samples


def load_diffs(data_dir: Path, *, long_flows_only: bool = False) -> tuple[str, list[DiffSample]]:
    """Prefer Flagsmith, then find another analysis with eligible commits."""
    repos = list(REPOS)
    if long_flows_only and data_dir.is_dir():
        repos.extend(
            directory.name
            for directory in sorted(data_dir.iterdir())
            if directory.name not in REPOS and (directory / "commits.json").is_file()
        )
    for repo in repos:
        try:
            samples = _repo_diffs(data_dir / repo, long_flows_only=long_flows_only)
        except FileNotFoundError:
            continue
        if samples:
            return repo, samples
    if long_flows_only:
        raise ValueError(
            f"No analyzed commits with long flows (flow_depth >= {LONG_FLOW_MIN_DEPTH} at one hop). "
            "Import Flagsmith/flagsmith or analyze another repository with long call chains."
        )
    raise ValueError(
        "No analyzed commits with flow changes. Import Flagsmith/flagsmith or analyze shop-demo first."
    )
