"""Verify graph diff identity rules, JSON shape, and neighbourhood expansion."""

import json

import pytest

from codeflow.diff import GraphDiff, diff_graphs, flow_depth, neighbourhood


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
    diff = diff_graphs(base, head)
    assert diff.nodes.changed == ["m:edit"]
    assert flow_depth(base, head, diff) == 1


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


def test_flow_depth_stays_within_the_changed_neighbourhood(compare_sources):
    base_source = """\
def upstream(): caller()
def caller(): edited()
def edited(): old()
def old(): pass
def new(): leaf()
def leaf(): pass
"""
    head_source = base_source.replace("def edited(): old()", "def edited(): new()")
    base, head = compare_sources({"m.py": base_source}, {"m.py": head_source})
    diff = diff_graphs(base, head)

    assert flow_depth(base, head, diff, hops=0) == 2
    assert flow_depth(base, head, diff) == 4
    assert flow_depth(base, head, diff, hops=2) == 5


def test_flow_depth_combines_removed_and_added_calls(compare_sources):
    base, head = compare_sources(
        {"m.py": "def a(): b()\ndef b(): pass\ndef c(): pass\n"},
        {"m.py": "def a(): pass\ndef b(): c()\ndef c(): pass\n"},
    )

    assert flow_depth(base, head, diff_graphs(base, head), hops=0) == 3


def test_flow_depth_uses_longest_branch(compare_sources):
    base, head = compare_sources(
        {"m.py": "def root(): pass\n"},
        {
            "m.py": """\
def root():
    short()
    longer()
def short(): pass
def longer(): leaf()
def leaf(): pass
"""
        },
    )

    assert flow_depth(base, head, diff_graphs(base, head)) == 3


def test_flow_depth_breaks_cycles_in_sorted_dfs_order(compare_sources):
    base, head = compare_sources(
        {"m.py": "def a(): pass\n"},
        {
            "m.py": """\
def c(): b()
def b(): c()
def a():
    c()
    b()
    a()
def w(): z()
def z(): c()
"""
        },
    )
    diff = diff_graphs(base, head)

    assert flow_depth(base, head, diff) == 3
    head.nodes.reverse()
    head.edges.reverse()
    assert flow_depth(base, head, diff) == 3


def test_flow_depth_is_zero_for_empty_diff(compare_sources):
    base, head = compare_sources(
        {"m.py": "def unchanged(): pass\n"},
        {"m.py": "# Comment only\ndef unchanged(): pass\n"},
    )

    assert flow_depth(base, head, diff_graphs(base, head)) == 0
