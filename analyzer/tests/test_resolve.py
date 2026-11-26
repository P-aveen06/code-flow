"""Resolve tiny packages without inferring edges from runtime behavior."""

import pytest

from codeflow.graph import Guard
from codeflow.parse_python import parse_file
from codeflow.resolve import resolve_edges


def edges_for(sources, keep_external=False):
    return resolve_edges(
        [parse_file(path, source.encode()) for path, source in sources.items()], keep_external
    )


def pairs(edges):
    return {(edge.source, edge.target) for edge in edges}


def test_same_module_and_recursion():
    edges = edges_for({"m.py": "def a():\n b()\ndef b():\n b()\n"})
    assert pairs(edges) == {("m:a", "m:b"), ("m:b", "m:b")}


def test_nested_function_precedes_top_level():
    edges = edges_for(
        {"m.py": "def inner():\n pass\ndef outer():\n def inner():\n  inner()\n inner()\n"}
    )
    assert pairs(edges) == {("m:outer", "m:outer.inner"), ("m:outer.inner", "m:outer.inner")}


def test_nested_function_in_outer_scope():
    edges = edges_for({"m.py": "def outer():\n def helper():\n  pass\n def inner():\n  helper()\n"})
    assert pairs(edges) == {("m:outer.inner", "m:outer.helper")}


def test_imported_name():
    edges = edges_for(
        {
            "m.py": "from payment import charge as pay\ndef f():\n pay()\n",
            "payment.py": "def charge():\n pass\n",
        }
    )
    assert pairs(edges) == {("m:f", "payment:charge")}


@pytest.mark.parametrize("receiver", ["self", "cls"])
def test_self_and_cls(receiver):
    edges = edges_for(
        {
            "m.py": f"class C:\n def run({receiver}):\n  {receiver}.work()\n def work(self):\n  pass\n"
        }
    )
    assert pairs(edges) == {("m:C.run", "m:C.work")}


def test_base_class_in_another_module():
    edges = edges_for(
        {
            "base.py": "class Base:\n def work(self):\n  pass\n",
            "m.py": "from base import Base\nclass Child(Base):\n def run(self):\n  self.work()\n",
        }
    )
    assert pairs(edges) == {("m:Child.run", "base:Base.work")}


def test_super_skips_override():
    edges = edges_for(
        {
            "m.py": "class Base:\n def work(self):\n  pass\nclass Child(Base):\n def work(self):\n  super().work()\n"
        }
    )
    assert pairs(edges) == {("m:Child.work", "m:Base.work")}


def test_bases_searched_depth_first():
    edges = edges_for(
        {
            "m.py": "class Root:\n def work(self):\n  pass\nclass Left(Root):\n pass\nclass Right:\n def work(self):\n  pass\nclass Child(Left, Right):\n def run(self):\n  self.work()\n"
        }
    )
    assert pairs(edges) == {("m:Child.run", "m:Root.work")}


def test_inheritance_cycle_terminates():
    edges = edges_for(
        {"m.py": "class A(B):\n def run(self):\n  self.missing()\nclass B(A):\n pass\n"}
    )
    assert edges == []


@pytest.mark.parametrize(
    "statement,call",
    [
        ("import shop.payment as pay", "pay.charge"),
        ("import shop.payment", "shop.payment.charge"),
        ("from shop import payment", "payment.charge"),
    ],
)
def test_module_imports(statement, call):
    edges = edges_for(
        {"m.py": f"{statement}\ndef f():\n {call}()\n", "shop/payment.py": "def charge():\n pass\n"}
    )
    assert pairs(edges) == {("m:f", "shop.payment:charge")}


def test_longest_module_prefix_and_class_method():
    edges = edges_for(
        {
            "m.py": "import shop.payment as pay\ndef f():\n pay.Gateway.charge()\n",
            "shop/__init__.py": "",
            "shop/payment.py": "class Gateway:\n def charge(self):\n  pass\n",
        }
    )
    assert pairs(edges) == {("m:f", "shop.payment:Gateway.charge")}


def test_class_instantiation_and_local_class_method():
    edges = edges_for(
        {"m.py": "class Cart:\n def total(self):\n  pass\ndef f():\n Cart()\n Cart.total()\n"}
    )
    assert pairs(edges) == {("m:f", "m:Cart"), ("m:f", "m:Cart.total")}


def test_relative_import_resolution():
    edges = edges_for(
        {
            "shop/api.py": "from .payment import charge\ndef f():\n charge()\n",
            "shop/payment.py": "def charge():\n pass\n",
        }
    )
    assert pairs(edges) == {("shop.api:f", "shop.payment:charge")}


def test_unresolved_dropped():
    assert edges_for({"m.py": "import requests\ndef f():\n missing()\n requests.get('/')\n"}) == []


def test_external_packages_collapse_and_unknown_bare_calls_drop():
    edges = edges_for(
        {
            "m.py": "import requests.api as api\nfrom requests import get\ndef f():\n api.post('/')\n get('/')\n missing()\n"
        },
        True,
    )
    assert pairs(edges) == {("m:f", "external:requests")}
    assert edges[0].line == 4


def test_missing_internal_target_is_not_external():
    assert (
        edges_for(
            {
                "m.py": "import shop.payment as pay\ndef f():\n pay.missing()\n",
                "shop/payment.py": "",
            },
            True,
        )
        == []
    )


@pytest.mark.parametrize("second_guard,expected", [("x", Guard("x", "on")), ("y", None)])
def test_edge_dedup_guard_merge(second_guard, expected):
    edges = edges_for(
        {
            "m.py": f"def work():\n pass\ndef f():\n if flags.has_feature('x'):\n  work()\n if flags.has_feature('{second_guard}'):\n  work()\n"
        }
    )
    assert len(edges) == 1
    assert edges[0].line == 5
    assert edges[0].guard == expected


def test_guarded_and_unguarded_calls_merge_to_none():
    edges = edges_for(
        {"m.py": "def work():\n pass\ndef f():\n if flags.has_feature('x'):\n  work()\n work()\n"}
    )
    assert len(edges) == 1
    assert edges[0].guard is None


def test_super_with_whitespace():
    edges = edges_for(
        {
            "m.py": "class Base:\n def work(self):\n  pass\nclass Child(Base):\n def work(self):\n  super( ).work()\n"
        }
    )
    assert pairs(edges) == {("m:Child.work", "m:Base.work")}


def test_local_definition_precedes_import():
    edges = edges_for(
        {
            "m.py": "from other import work\ndef work():\n pass\ndef f():\n work()\n",
            "other.py": "def work():\n pass\n",
        }
    )
    assert pairs(edges) == {("m:f", "m:work")}


def test_base_class_through_module_alias():
    edges = edges_for(
        {
            "m.py": "import base as b\nclass Child(b.Base):\n def run(self):\n  self.work()\n",
            "base.py": "class Base:\n def work(self):\n  pass\n",
        }
    )
    assert pairs(edges) == {("m:Child.run", "base:Base.work")}
