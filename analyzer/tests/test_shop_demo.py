"""Verify the demo repo is repeatable and the analyzer sees its key edges."""

from codeflow.analyze import analyze_repo, load_snapshot
from codeflow.git_history import list_commits
from codeflow.graph import Guard


def test_shop_demo(make_shop_demo, tmp_path):
    repo, log = make_shop_demo()
    commits = list_commits(repo, "main")
    assert len(commits) == len(log.splitlines()) == 8
    assert [commit.date for commit in commits] == [
        f"2026-11-20T{hour:02}:00:00Z" for hour in range(9, 17)
    ]
    assert {commit.author for commit in commits} == {"code-flow demo"}
    assert make_shop_demo() == (repo, log)
    assert list_commits(repo)[-1].sha == commits[-1].sha

    out = tmp_path / "output"
    results = analyze_repo(repo, out, branch="main")
    assert all(result.written and not result.skipped for result in results)

    cart_graph = load_snapshot(out, commits[0].sha)
    assert ("shop.api:add_to_cart", "shop.cart:Cart.add_item") in {
        (edge.source, edge.target) for edge in cart_graph.edges
    }

    flag_graph = load_snapshot(out, commits[4].sha)
    assert ("shop.checkout:legacy_checkout", "shop.cart:Cart.total") in {
        (edge.source, edge.target) for edge in flag_graph.edges
    }
    checkout_edges = {
        edge.target: edge.guard for edge in flag_graph.edges if edge.source == "shop.api:checkout"
    }
    assert checkout_edges["shop.checkout:new_checkout"] == Guard("new_checkout", "on")
    assert checkout_edges["shop.checkout:legacy_checkout"] == Guard("new_checkout", "off")

    payment_graph = load_snapshot(out, commits[6].sha)
    payment_edges = {(edge.source, edge.target) for edge in payment_graph.edges}
    assert ("shop.checkout:new_checkout", "shop.payment:PaymentGateway.charge") in payment_edges
    assert (
        "shop.payment:PaymentGateway.charge",
        "shop.payment:PaymentGateway._authorize",
    ) in payment_edges
