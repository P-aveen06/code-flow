"""Verify the Mermaid overlay, quoting, and stable collision-free IDs."""

import re

from codeflow.diff import diff_graphs
from codeflow.export_mermaid import to_mermaid


def test_overlay_snapshot(compare_sources):
    base, head = compare_sources(
        {
            "shop/api.py": """\
from .cart import steady
def start():
    if flags.has_feature("prior"):
        old()
    if flags.has_feature("switch"):
        steady()
def old(): pass
""",
            "shop/cart.py": "def steady(): pass\n",
        },
        {
            "shop/api.py": """\
from .cart import steady
def start():
    if flags.has_feature("new"):
        added()
    if not flags.has_feature("switch"):
        steady()
def added(): pass
"""
        },
    )
    expected = """\
flowchart LR
  subgraph m_shop_api ["shop.api"]
    n_shop_api_added["added"]
    n_shop_api_old["old"]
    n_shop_api_start["start"]
  end
  subgraph m_shop_cart ["shop.cart"]
    n_shop_cart_steady["steady"]
  end
  n_shop_api_start -->|"new: on"| n_shop_api_added
  n_shop_api_start -.->|"prior: on"| n_shop_api_old
  n_shop_api_start -->|"switch: off"| n_shop_cart_steady
  classDef added fill:#dcfce7,stroke:#15803d,color:#14532d
  classDef removed fill:#fee2e2,stroke:#b91c1c,color:#7f1d1d,stroke-dasharray:5 3
  classDef changed fill:#fef3c7,stroke:#b45309,color:#78350f
  classDef context fill:#f3f4f6,stroke:#6b7280,color:#1f2937
  class n_shop_api_added added
  class n_shop_api_old removed
  class n_shop_api_start changed
  class n_shop_cart_steady context
  linkStyle 0 stroke:#15803d,stroke-width:2px
  linkStyle 1 stroke:#b91c1c,stroke-width:2px"""
    assert to_mermaid(base, head, diff_graphs(base, head)) == expected
    for graph in (base, head):
        graph.nodes.reverse()
        graph.edges.reverse()
    assert to_mermaid(base, head, diff_graphs(base, head)) == expected


def test_sanitized_ids_are_unique_and_labels_are_escaped(compare_sources):
    base, head = compare_sources(
        {"empty.py": ""},
        {
            "pkg-a.py": "def same(): pass\n",
            "pkg/a.py": "def same(): pass\n",
            "pkg_a.py": "def same(): pass\n",
            "pkg_a_2.py": "def same(): pass\n",
            'look"up.py': """\
def caller():
    if flags.has_feature('say "hello" | #'):
        café()
def café(): pass
""",
        },
    )
    mermaid = to_mermaid(base, head, diff_graphs(base, head))
    node_ids = re.findall(r"^    (\S+)\[", mermaid, re.MULTILINE)
    module_ids = re.findall(r"^  subgraph (\S+) \[", mermaid, re.MULTILINE)
    assert len(node_ids) == 6
    assert len(module_ids) == 5
    all_ids = module_ids + node_ids
    assert len(set(all_ids)) == len(all_ids)
    assert all(re.fullmatch(r"[A-Za-z0-9_]+", identifier) for identifier in all_ids)
    assert '["look#quot;up"]' in mermaid
    assert '["café"]' in mermaid
    assert '|"say #quot;hello#quot; #124; #35;: on"|' in mermaid
