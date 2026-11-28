"""Check diff sampling from stats and analyzer snapshots."""

import json
from pathlib import Path

import pytest
from codeflow.graph import Commit, Edge, Graph, Node

from diffs import DiffSample, load_diffs


def _write_index(data_dir: Path, repo: str, commits: list[dict]) -> Path:
    directory = data_dir / repo
    directory.mkdir()
    (directory / "commits.json").write_text(json.dumps({"commits": commits}))
    return directory


def _stats(**changes: int) -> dict[str, int]:
    return {
        "nodes_added": 0,
        "nodes_changed": 0,
        "nodes_removed": 0,
        "edges_added": 0,
        "edges_removed": 0,
    } | changes


def _write_snapshot(
    directory: Path, sha: str, bodies: dict[str, str], calls: list[tuple[str, str]]
) -> None:
    snapshots = directory / "snapshots"
    snapshots.mkdir(exist_ok=True)
    graph = Graph(
        "code-flow/graph@1",
        directory.name,
        Commit(sha, [], "", "", ""),
        [Node(name, "function", name, "m", "m.py", 1, 1, body) for name, body in bodies.items()],
        [Edge(source, target) for source, target in calls],
        [],
    )
    (snapshots / f"{sha}.json").write_text(json.dumps(graph.to_json()))


def test_use_flagsmith_stats_and_keep_only_flow_changes(tmp_path: Path) -> None:
    _write_index(
        tmp_path,
        "Flagsmith__flagsmith",
        [
            {"stats": _stats(nodes_added=2, nodes_removed=1, nodes_changed=3)},
            {"stats": _stats()},
            {"stats": _stats(edges_added=1)},
        ],
    )
    _write_index(tmp_path, "test-repo", [{"stats": _stats(nodes_added=3)}])
    assert load_diffs(tmp_path) == ("Flagsmith__flagsmith", [DiffSample(6), DiffSample(0)])


def test_compare_current_and_legacy_index_bases(tmp_path: Path) -> None:
    directory = _write_index(
        tmp_path,
        "Flagsmith__flagsmith",
        [
            {"sha": "a", "base": "older", "parents": []},
            {"sha": "b", "parents": ["a"]},
            {"sha": "c", "base": "b", "parents": ["b"]},
        ],
    )
    first_nodes = {"cart": "old", "tax": "gone"}
    new_nodes = {"cart": "new", "payment": "same"}
    edges = [("cart", "payment")]
    for sha, nodes, calls in (
        ("older", first_nodes, []),
        ("a", new_nodes, []),
        ("b", new_nodes, edges),
        ("c", new_nodes, edges),
    ):
        _write_snapshot(directory, sha, nodes, calls)

    assert load_diffs(tmp_path) == ("Flagsmith__flagsmith", [DiffSample(3), DiffSample(0)])


def test_no_data_has_a_setup_error(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="make analyze-flagsmith first"):
        load_diffs(tmp_path)


def _write_chain_history(data_dir: Path, repo: str, *, with_long_flow: bool) -> None:
    commits = [{"sha": "short", "parents": []}]
    if with_long_flow:
        commits.extend(
            [
                {"sha": "long", "base": "short"},
                {"sha": "unchanged", "parents": ["long"]},
                {"sha": "local_edit", "parents": ["unchanged"]},
            ]
        )
    directory = _write_index(data_dir, repo, commits)
    _write_snapshot(directory, "short", dict.fromkeys("ab", "same"), [("a", "b")])
    if with_long_flow:
        calls = [("a", "b"), ("b", "c"), ("c", "d")]
        bodies = dict.fromkeys("abcd", "same")
        _write_snapshot(directory, "long", bodies, calls)
        _write_snapshot(directory, "unchanged", bodies, calls)
        _write_snapshot(directory, "local_edit", {**bodies, "a": "changed"}, calls)


def test_long_flows_filter_by_one_hop(tmp_path: Path) -> None:
    _write_chain_history(tmp_path, "Flagsmith__flagsmith", with_long_flow=True)
    _write_chain_history(tmp_path, "alternate", with_long_flow=True)

    assert load_diffs(tmp_path, long_flows_only=True) == (
        "Flagsmith__flagsmith",
        [DiffSample(size=2, depth=4)],
    )


def test_long_flows_ignore_other_repositories(tmp_path: Path) -> None:
    _write_chain_history(tmp_path, "Flagsmith__flagsmith", with_long_flow=False)
    _write_chain_history(tmp_path, "alternate", with_long_flow=True)

    with pytest.raises(ValueError, match="No analyzed commits with long flows"):
        load_diffs(tmp_path, long_flows_only=True)


def test_no_long_flows_reports_eligibility_requirement(tmp_path: Path) -> None:
    _write_chain_history(tmp_path, "Flagsmith__flagsmith", with_long_flow=False)

    with pytest.raises(ValueError, match="No analyzed commits with long flows"):
        load_diffs(tmp_path, long_flows_only=True)
