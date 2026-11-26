"""Verify graph diff identity rules, JSON shape, and neighbourhood expansion."""

import json

import pytest

from codeflow.diff import GraphDiff, diff_graphs, neighbourhood


@pytest.fixture
def checkout_graphs(compare_sources):
    base = """\
def hop_two(): hop_one()
def hop_one(): checkout()
def preserved(): return 1
def checkout():
    if flags.has_feature("same"):
        preserved()
    if flags.has_feature("old_flag"):
        old()
def old(): pass
def edited(): return 1
def unrelated(): return 0
"""
    head = """\
def hop_two(): hop_one()
def hop_one(): checkout()
def preserved(): return 1
def checkout():
    if not flags.has_feature("same"):
        preserved()
    if flags.has_feature("new_flag"):
        new_z()
        new_a()
    flags.has_feature("new_flag")
def new_z(): pass
def edited(): return 2
def unrelated(): return 0
def new_a(): pass
"""
    return compare_sources({"m.py": base}, {"m.py": head})


def test_diff_json_and_round_trip(checkout_graphs):
    base, head = checkout_graphs
    diff = diff_graphs(base, head)
    data = diff.to_json()
    assert data == {
        "schema": "code-flow/diff@1",
        "base": base.commit.sha,
        "head": head.commit.sha,
        "nodes": {
            "added": ["m:new_a", "m:new_z"],
            "removed": ["m:old"],
            "changed": ["m:checkout", "m:edited"],
        },
        "edges": {
            "added": [
                {"source": "m:checkout", "target": "m:new_a"},
                {"source": "m:checkout", "target": "m:new_z"},
            ],
            "removed": [{"source": "m:checkout", "target": "m:old"}],
        },
        "flags": {"added": ["new_flag"], "removed": ["old_flag"]},
        "stats": {
            "nodes_added": 2,
            "nodes_removed": 1,
            "nodes_changed": 2,
            "edges_added": 2,
            "edges_removed": 1,
        },
    }
    restored = GraphDiff.from_json(json.loads(json.dumps(data)))
    assert restored == diff
    restored.nodes.added.reverse()
    restored.edges.added.reverse()
    assert restored.to_json() == data


def test_body_hash_is_the_only_node_change_signal(compare_sources):
    base, head = compare_sources(
        {"m.py": "def shift(): pass\ndef edit(): return 1\n"},
        {"m.py": "# shift both definitions\ndef shift(): pass\ndef edit(): return 2\n"},
    )
    assert diff_graphs(base, head).nodes.changed == ["m:edit"]


def test_neighbourhood_walks_callers_and_callees(checkout_graphs):
    base, head = checkout_graphs
    diff = diff_graphs(base, head)
    seeds = {"m:checkout", "m:edited", "m:new_a", "m:new_z", "m:old"}
    one_hop = seeds | {"m:hop_one", "m:preserved"}
    assert neighbourhood(base, head, diff, hops=0) == seeds
    assert neighbourhood(base, head, diff) == one_hop
    assert neighbourhood(base, head, diff, hops=2) == one_hop | {"m:hop_two"}


def test_hops_zero_includes_endpoints_of_edge_only_changes(compare_sources):
    base, head = compare_sources(
        {
            "api.py": "from old import check\ndef checkout(): check()\n",
            "old.py": "def check(): pass\n",
            "new.py": "def check(): pass\n",
        },
        {"api.py": "from new import check\ndef checkout(): check()\n"},
    )
    diff = diff_graphs(base, head)
    assert diff.nodes.changed == []
    assert neighbourhood(base, head, diff, hops=0) == {"api:checkout", "old:check", "new:check"}
