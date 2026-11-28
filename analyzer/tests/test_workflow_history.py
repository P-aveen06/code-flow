"""Verify guarded calls and reroutes across a small Git history."""

from codeflow.analyze import analyze_repo, load_snapshot
from codeflow.diff import diff_graphs
from codeflow.graph import Guard


def test_guarded_calls_and_reroutes(workflow_repo, tmp_path):
    out = tmp_path / "output"
    first, guarded, refactored = analyze_repo(workflow_repo.path, out, branch="main")
    assert all(result.written and not result.skipped for result in (first, guarded, refactored))
    base, head, latest = (
        load_snapshot(out, result.commit.sha) for result in (first, guarded, refactored)
    )
    assert {(edge.source, edge.target) for edge in base.edges} == {
        ("workflow.api:run", "workflow.jobs:process")
    }

    assert any(
        (edge.source, edge.target, edge.guard)
        == ("workflow.jobs:process_standard", "workflow.rates:rate", None)
        for edge in head.edges
    )
    guards = {edge.target: edge.guard for edge in head.edges if edge.source == "workflow.api:run"}
    assert guards == {
        "workflow.jobs:process_fast": Guard("fast_path", "on"),
        "workflow.jobs:process_standard": Guard("fast_path", "off"),
    }
    diff = diff_graphs(base, head)
    assert diff.stats["edges_removed"] == 1
    assert diff.stats["nodes_added"] == 2

    latest_edges = {(edge.source, edge.target) for edge in latest.edges}
    assert ("workflow.jobs:process_fast", "workflow.jobs:Processor.send") in latest_edges
    assert ("workflow.jobs:Processor.send", "workflow.jobs:Processor.prepare") in latest_edges
    assert diff_graphs(head, latest).stats["nodes_removed"] == 1
