"""Verify the demo repo is repeatable and the analyzer sees its key edges."""

import subprocess
from pathlib import Path

from codeflow.analyze import analyze_repo, load_snapshot
from codeflow.git_history import list_commits
from codeflow.graph import Guard


def test_shop_demo(git_available, tmp_path):
    script = Path(__file__).resolve().parents[2] / "examples" / "make_shop_demo.sh"
    repo = tmp_path / "shop demo"

    def generate():
        return subprocess.run(
            ["bash", str(script), repo.name],
            cwd=tmp_path,
            check=True,
            capture_output=True,
            text=True,
        ).stdout

    log = generate()
    commits = list_commits(repo, "main")
    assert len(commits) == len(log.splitlines()) == 8
    assert [commit.date for commit in commits] == [
        f"2026-11-20T{hour:02}:00:00Z" for hour in range(9, 17)
    ]
    assert {commit.author for commit in commits} == {"code-flow demo"}
    assert generate() == log
    assert list_commits(repo)[-1].sha == commits[-1].sha

    out = tmp_path / "output"
    results = analyze_repo(repo, out, branch="main")
    assert all(result.written and not result.skipped for result in results)

    flag_graph = load_snapshot(out, commits[4].sha)
    checkout_edges = {
        edge.target: edge.guard for edge in flag_graph.edges if edge.source == "shop.api:checkout"
    }
    assert checkout_edges["shop.checkout:new_checkout"] == Guard("new_checkout", "on")
    assert checkout_edges["shop.checkout:legacy_checkout"] == Guard("new_checkout", "off")

    payment_graph = load_snapshot(out, commits[6].sha)
    assert ("shop.payment:PaymentGateway.charge", "shop.payment:PaymentGateway._authorize") in {
        (edge.source, edge.target) for edge in payment_graph.edges
    }
