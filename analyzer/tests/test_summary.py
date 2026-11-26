"""Verify headline priority, count wording, and one-line length."""

import pytest

from codeflow.diff import diff_graphs
from codeflow.summary import summarize


def test_new_flag_prefers_the_enabled_edge_over_the_reroute(compare_sources):
    base, head = compare_sources(
        {"shop.py": "def checkout(): old()\ndef old(): pass\n"},
        {
            "shop.py": """\
def checkout():
    if flags.has_feature("new_checkout"):
        new_checkout()
    else:
        legacy_checkout()
def legacy_checkout(): pass
def new_checkout(): pass
"""
        },
    )
    assert summarize(base, head, diff_graphs(base, head)) == (
        "`checkout` now routes to `new_checkout` behind flag `new_checkout`"
        "; 2 functions added, 1 removed, 1 changed"
    )


def test_reroute_between_existing_functions(compare_sources):
    definitions = "def old_x(): pass\ndef new_x(): pass\n"
    base, head = compare_sources(
        {"shop.py": definitions + "def checkout(): old_x()\n"},
        {"shop.py": definitions + "def checkout(): new_x()\n"},
    )
    assert summarize(base, head, diff_graphs(base, head)) == (
        "`checkout` now calls `new_x` instead of `old_x`; 1 function changed"
    )


@pytest.mark.parametrize(
    ("before", "after", "expected"),
    [
        (
            "def old(): pass\ndef x(): return 1\ndef y(): return 1\n",
            "def c(): pass\ndef a(): pass\ndef b(): pass\ndef x(): return 2\ndef y(): return 2\n",
            "adds `a`, `b` and 1 more; 3 functions added, 1 removed, 2 changed",
        ),
        ("def old(): pass\n", "", "removes `old`; 1 function removed"),
        (
            "class Cart:\n def total(self): return 1\n",
            "class Cart:\n def total(self): return 2\n",
            "changes `Cart.total`; 1 function changed",
        ),
        ("def same(): pass\n", "# comment\ndef same(): pass\n", "No flow changes"),
        ("", 'flags.has_feature("new")\n', "adds flag `new`"),
    ],
)
def test_node_headlines_and_empty_diff(compare_sources, before, after, expected):
    base, head = compare_sources({"shop.py": before}, {"shop.py": after})
    assert summarize(base, head, diff_graphs(base, head)) == expected


def test_long_headline_keeps_the_counts_and_backticks(compare_sources):
    caller = "checkout_" * 20
    callee = "new_checkout_" * 20
    flag = "flag_" * 20 + "\nflag"
    base, head = compare_sources(
        {"shop.py": f"def {caller}(): pass\n"},
        {
            "shop.py": (
                f"def {caller}():\n if flags.has_feature({flag!r}): {callee}()\n"
                f"def {callee}(): pass\n"
            )
        },
    )
    result = summarize(base, head, diff_graphs(base, head))
    assert len(result) <= 160
    assert "\n" not in result
    assert result.count("`") == 6
    assert result.endswith("; 1 function added, 1 changed")
