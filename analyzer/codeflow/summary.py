"""Describe a graph diff in one line using deterministic headline rules."""

from codeflow.diff import GraphDiff
from codeflow.graph import Graph


def _short_name(node_id: str) -> str:
    return node_id.split(":", 1)[-1]


def _counts(diff: GraphDiff) -> str:
    parts = []
    for status, nodes in (
        ("added", diff.nodes.added),
        ("removed", diff.nodes.removed),
        ("changed", diff.nodes.changed),
    ):
        count = len(nodes)
        if count:
            noun = "function" if count == 1 else "functions"
            parts.append(f"{count} {status}" if parts else f"{count} {noun} {status}")
    return ", ".join(parts)


def _headline(base: Graph, head: Graph, diff: GraphDiff) -> tuple[str, list[str]]:
    added_flags = set(diff.flags.added)
    # Prefer the enabled branch when a flag guards both sides of a split.
    flagged_route = min(
        (
            (edge.guard.when != "on", edge.guard.flag, edge.source, edge.target)
            for edge in head.edges
            if edge.guard and edge.guard.flag in added_flags
        ),
        default=None,
    )
    if flagged_route:
        _, flag, source, target = flagged_route
        return "{} now routes to {} behind flag {}", [
            _short_name(source),
            _short_name(target),
            flag,
        ]

    if diff.edges.removed and diff.edges.added:
        shared_nodes = {node.id for node in base.nodes} & {node.id for node in head.nodes}
        removed_targets = {}
        for edge in sorted(diff.edges.removed):
            removed_targets.setdefault(edge.source, edge.target)
        for edge in sorted(diff.edges.added):
            if edge.source in shared_nodes and edge.source in removed_targets:
                return "{} now calls {} instead of {}", [
                    _short_name(edge.source),
                    _short_name(edge.target),
                    _short_name(removed_targets[edge.source]),
                ]

    for verb, nodes in (
        ("adds", diff.nodes.added),
        ("removes", diff.nodes.removed),
        ("changes", diff.nodes.changed),
    ):
        if nodes:
            names = [_short_name(node) for node in sorted(nodes)[:2]]
            template = f"{verb} " + ", ".join(["{}"] * len(names))
            if len(nodes) > len(names):
                template += f" and {len(nodes) - len(names)} more"
            return template, names

    if diff.flags.added:
        return "adds flag {}", [min(diff.flags.added)]
    if diff.flags.removed:
        return "removes flag {}", [min(diff.flags.removed)]
    if diff.edges.added or diff.edges.removed:
        return "Call edges changed", []
    return "No flow changes", []


def summarize(base: Graph, head: Graph, diff: GraphDiff) -> str:
    """Choose the first applicable headline and append the nonzero node counts."""
    template, names = _headline(base, head, diff)
    counts = _counts(diff)
    suffix = f"; {counts}" if counts else ""
    names = [" ".join(name.splitlines()) for name in names]
    name_budget = 160 - len(suffix) - len(template.format(*["``"] * len(names)))
    if sum(map(len, names)) > name_budget:
        limit = name_budget // len(names)
        names = [name if len(name) <= limit else f"{name[: limit - 1]}…" for name in names]
    return template.format(*(f"`{name}`" for name in names)) + suffix
