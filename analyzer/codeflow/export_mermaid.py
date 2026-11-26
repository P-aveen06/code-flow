"""Render the changed graph neighbourhood as a Mermaid flowchart."""

import re
from collections import defaultdict
from collections.abc import Iterable

from codeflow.diff import EdgeChange, GraphDiff, neighbourhood
from codeflow.graph import Graph, Node


def _ids(values: Iterable[str], prefix: str) -> dict[str, str]:
    result = {}
    used = set()
    for value in sorted(values):
        sanitized = f"{prefix}_" + re.sub(r"[^A-Za-z0-9_]", "_", value)
        candidate = sanitized
        suffix = 2
        while candidate in used:
            candidate = f"{sanitized}_{suffix}"
            suffix += 1
        result[value] = candidate
        used.add(candidate)
    return result


def _label(value: str) -> str:
    # Mermaid uses entity codes inside quoted labels.
    escapes = str.maketrans(
        {
            '"': "#quot;",
            "#": "#35;",
            "|": "#124;",
            "&": "#38;",
            "<": "#60;",
            ">": "#62;",
            "\\": "#92;",
            "`": "#96;",
        }
    )
    return '"' + " ".join(value.splitlines()).translate(escapes) + '"'


def _node_lines(nodes: dict[str, Node], node_ids: dict[str, str]) -> list[str]:
    modules: dict[str, list[str]] = defaultdict(list)
    for node_id in sorted(nodes):
        modules[nodes[node_id].module].append(node_id)

    module_ids = _ids(modules, "m")
    lines = []
    for module in sorted(modules):
        lines.append(f"  subgraph {module_ids[module]} [{_label(module or '(no module)')}]")
        for node_id in modules[module]:
            qualname = node_id.split(":", 1)[-1]
            lines.append(f"    {node_ids[node_id]}[{_label(qualname)}]")
        lines.append("  end")
    return lines


def _edge_lines(
    base: Graph, head: Graph, diff: GraphDiff, node_ids: dict[str, str]
) -> tuple[list[str], dict[str, list[str]]]:
    # A head edge supersedes the base edge of the same pair, including its guard.
    edges = {
        EdgeChange(edge.source, edge.target): edge
        for graph in (base, head)
        for edge in graph.edges
        if edge.source in node_ids and edge.target in node_ids
    }
    added = set(diff.edges.added)
    removed = set(diff.edges.removed)
    lines = []
    link_indices: dict[str, list[str]] = {"added": [], "removed": []}
    for key, edge in sorted(edges.items()):
        arrow = "-.->" if key in removed else "-->"
        label = f"|{_label(f'{edge.guard.flag}: {edge.guard.when}')}|" if edge.guard else ""
        if key in added:
            link_indices["added"].append(str(len(lines)))
        if key in removed:
            link_indices["removed"].append(str(len(lines)))
        lines.append(f"  {node_ids[edge.source]} {arrow}{label} {node_ids[edge.target]}")
    return lines, link_indices


def _style_lines(
    diff: GraphDiff, node_ids: dict[str, str], link_indices: dict[str, list[str]]
) -> list[str]:
    green = "#15803d"
    red = "#b91c1c"
    lines = [
        f"  classDef added fill:#dcfce7,stroke:{green},color:#14532d",
        f"  classDef removed fill:#fee2e2,stroke:{red},color:#7f1d1d,stroke-dasharray:5 3",
        "  classDef changed fill:#fef3c7,stroke:#b45309,color:#78350f",
        "  classDef context fill:#f3f4f6,stroke:#6b7280,color:#1f2937",
    ]
    classes = {
        node_id: status
        for status, changed in (
            ("added", diff.nodes.added),
            ("removed", diff.nodes.removed),
            ("changed", diff.nodes.changed),
        )
        for node_id in changed
    }
    for node_id in sorted(node_ids):
        lines.append(f"  class {node_ids[node_id]} {classes.get(node_id, 'context')}")
    for status, color in (("added", green), ("removed", red)):
        if link_indices[status]:
            indices = ",".join(link_indices[status])
            lines.append(f"  linkStyle {indices} stroke:{color},stroke-width:2px")
    return lines


def to_mermaid(base: Graph, head: Graph, diff: GraphDiff, hops: int = 1) -> str:
    """Overlay both snapshots within the selected distance of the changes."""
    included = neighbourhood(base, head, diff, hops)
    nodes = {node.id: node for graph in (base, head) for node in graph.nodes if node.id in included}
    node_ids = _ids(nodes, "n")
    edges, link_indices = _edge_lines(base, head, diff, node_ids)
    return "\n".join(
        [
            "flowchart LR",
            *_node_lines(nodes, node_ids),
            *edges,
            *_style_lines(diff, node_ids, link_indices),
        ]
    )
