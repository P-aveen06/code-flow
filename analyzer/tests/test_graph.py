"""Verify the public graph JSON schema and one-commit assembly."""

import json

from codeflow.build import build_graph
from codeflow.graph import Commit, Edge, FlagCheck, Graph, Guard, Node
from codeflow.parse_python import parse_file


def commit():
    return Commit("abc123", ["def456"], "Author", "2026-11-26T10:00:00Z", "A commit")


def test_json_round_trip_and_deterministic_order():
    nodes = [Node(name, "function", name, "m", "m.py", 1, 2, "hash") for name in ["z", "a"]]
    edges = [Edge("z", "a", line=3), Edge("a", "z", line=5, guard=Guard("x", "on"))]
    flags = [
        FlagCheck("x", "z.py", 2, "z", "has_feature"),
        FlagCheck("x", "a.py", 3, "a", "has_feature"),
        FlagCheck("x", "a.py", 1, "a", "has_feature"),
    ]
    graph = Graph("code-flow/graph@1", "shop", commit(), nodes, edges, flags)
    data = graph.to_json()
    assert [node["id"] for node in data["nodes"]] == ["a", "z"]
    assert [edge["source"] for edge in data["edges"]] == ["a", "z"]
    assert [(flag["file"], flag["line"]) for flag in data["flags"]] == [
        ("a.py", 1),
        ("a.py", 3),
        ("z.py", 2),
    ]
    assert data["edges"][0] == {
        "source": "a",
        "target": "z",
        "kind": "call",
        "line": 5,
        "guard": {"flag": "x", "when": "on"},
    }
    assert Graph.from_json(json.loads(json.dumps(data))).to_json() == data
    graph.nodes.reverse()
    graph.edges.reverse()
    graph.flags.reverse()
    assert graph.to_json() == data


def test_three_file_package_build(tmp_path):
    sources = {
        "shop/__init__.py": "from .api import checkout\n",
        "shop/api.py": "from .payment import charge\ndef checkout():\n if flags.has_feature('new_checkout'):\n  charge()\n",
        "shop/payment.py": "def charge():\n pass\n",
    }
    files = []
    for path, source in sources.items():
        destination = tmp_path / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(source)
        files.append(parse_file(path, destination.read_bytes()))
    graph = build_graph(files, "review-fixture", commit())
    assert graph.schema == "code-flow/graph@1"
    assert graph.repo == "review-fixture"
    assert graph.commit == commit()
    assert [node.id for node in graph.nodes] == ["shop.api:checkout", "shop.payment:charge"]
    assert graph.nodes[0].name == "checkout"
    assert graph.edges == [
        Edge("shop.api:checkout", "shop.payment:charge", line=4, guard=Guard("new_checkout", "on"))
    ]
    assert graph.flags == [
        FlagCheck("new_checkout", "shop/api.py", 3, "shop.api:checkout", "has_feature")
    ]
    assert (
        build_graph(list(reversed(files)), "review-fixture", commit()).to_json() == graph.to_json()
    )


def test_build_external_nodes():
    file = parse_file(
        "m.py", b"import requests\ndef f():\n requests.get('/')\n requests.post('/')\n"
    )
    graph = build_graph([file], "repo", commit(), keep_external=True)
    assert [node.id for node in graph.nodes] == ["external:requests", "m:f"]
    assert graph.nodes[0].kind == "external"
    assert len(graph.edges) == 1
    assert [node.id for node in build_graph([file], "repo", commit()).nodes] == ["m:f"]


def test_build_class_method_and_nested_function_ids():
    file = parse_file("m.py", b"class C:\n def f(self):\n  def inner():\n   pass\n")
    graph = build_graph([file], "repo", commit())
    assert [(node.id, node.kind) for node in graph.nodes] == [
        ("m:C", "class"),
        ("m:C.f", "method"),
        ("m:C.f.inner", "function"),
    ]
