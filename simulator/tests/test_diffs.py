"""Check diff sampling from stats and analyzer snapshots."""

import json
from pathlib import Path

import pytest

from diffs import load_diff_sizes


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
    _write_index(tmp_path, "shop-demo", [{"stats": _stats(nodes_added=3)}])
    assert load_diff_sizes(tmp_path) == ("Flagsmith__flagsmith", [6, 0])


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
    snapshots = directory / "snapshots"
    snapshots.mkdir()
    first_nodes = [{"id": "cart", "body_hash": "old"}, {"id": "tax", "body_hash": "gone"}]
    new_nodes = [{"id": "cart", "body_hash": "new"}, {"id": "payment", "body_hash": "same"}]
    edges = [{"source": "cart", "target": "payment"}]
    for sha, nodes, calls in (
        ("older", first_nodes, []),
        ("a", new_nodes, []),
        ("b", new_nodes, edges),
        ("c", new_nodes, edges),
    ):
        (snapshots / f"{sha}.json").write_text(json.dumps({"nodes": nodes, "edges": calls}))

    assert load_diff_sizes(tmp_path) == ("Flagsmith__flagsmith", [3, 0])


@pytest.mark.parametrize("flagsmith_exists", [False, True])
def test_fall_back_to_shop_demo(tmp_path: Path, flagsmith_exists: bool) -> None:
    if flagsmith_exists:
        _write_index(tmp_path, "Flagsmith__flagsmith", [{"stats": _stats()}])
    _write_index(tmp_path, "shop-demo", [{"stats": _stats(nodes_changed=2)}])
    assert load_diff_sizes(tmp_path) == ("shop-demo", [2])


def test_no_data_has_a_setup_error(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="analyze shop-demo first"):
        load_diff_sizes(tmp_path)
