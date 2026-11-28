"""Compare graph snapshots and find the neighbourhood around their changes."""

from collections import defaultdict
from dataclasses import asdict, dataclass
from itertools import chain
from typing import ClassVar

from codeflow.graph import Graph

LONG_FLOW_MIN_DEPTH = 4


@dataclass
class NodeChanges:
    added: list[str]
    removed: list[str]
    changed: list[str]


@dataclass(frozen=True, order=True)
class EdgeChange:
    source: str
    target: str


@dataclass
class EdgeChanges:
    added: list[EdgeChange]
    removed: list[EdgeChange]


@dataclass
class FlagChanges:
    added: list[str]
    removed: list[str]


@dataclass
class GraphDiff:
    schema: ClassVar[str] = "code-flow/diff@1"
    base: str
    head: str
    nodes: NodeChanges
    edges: EdgeChanges
    flags: FlagChanges

    @property
    def stats(self) -> dict[str, int]:
        return {
            "nodes_added": len(self.nodes.added),
            "nodes_removed": len(self.nodes.removed),
            "nodes_changed": len(self.nodes.changed),
            "edges_added": len(self.edges.added),
            "edges_removed": len(self.edges.removed),
        }

    def to_json(self) -> dict:
        return {
            "schema": self.schema,
            "base": self.base,
            "head": self.head,
            "nodes": {
                "added": sorted(self.nodes.added),
                "removed": sorted(self.nodes.removed),
                "changed": sorted(self.nodes.changed),
            },
            "edges": {
                "added": [asdict(edge) for edge in sorted(self.edges.added)],
                "removed": [asdict(edge) for edge in sorted(self.edges.removed)],
            },
            "flags": {"added": sorted(self.flags.added), "removed": sorted(self.flags.removed)},
            "stats": self.stats,
        }

    @classmethod
    def from_json(cls, data: dict) -> "GraphDiff":
        if data["schema"] != cls.schema:
            raise ValueError(f"Unknown diff schema: {data['schema']!r}")
        return cls(
            base=data["base"],
            head=data["head"],
            nodes=NodeChanges(**{status: sorted(ids) for status, ids in data["nodes"].items()}),
            edges=EdgeChanges(
                **{
                    status: sorted(EdgeChange(**edge) for edge in edges)
                    for status, edges in data["edges"].items()
                }
            ),
            flags=FlagChanges(**{status: sorted(names) for status, names in data["flags"].items()}),
        )


def diff_graphs(base: Graph, head: Graph) -> GraphDiff:
    """Compare node bodies, call pairs, and flag names."""
    base_nodes = {node.id: node.body_hash for node in base.nodes}
    head_nodes = {node.id: node.body_hash for node in head.nodes}
    base_edges = {EdgeChange(edge.source, edge.target) for edge in base.edges}
    head_edges = {EdgeChange(edge.source, edge.target) for edge in head.edges}
    base_flags = {flag.name for flag in base.flags}
    head_flags = {flag.name for flag in head.flags}
    return GraphDiff(
        base=base.commit.sha,
        head=head.commit.sha,
        nodes=NodeChanges(
            added=sorted(head_nodes.keys() - base_nodes.keys()),
            removed=sorted(base_nodes.keys() - head_nodes.keys()),
            changed=sorted(
                node
                for node in base_nodes.keys() & head_nodes.keys()
                if base_nodes[node] != head_nodes[node]
            ),
        ),
        edges=EdgeChanges(
            added=sorted(head_edges - base_edges),
            removed=sorted(base_edges - head_edges),
        ),
        flags=FlagChanges(
            added=sorted(head_flags - base_flags),
            removed=sorted(base_flags - head_flags),
        ),
    )


def neighbourhood(base: Graph, head: Graph, diff: GraphDiff, hops: int = 1) -> set[str]:
    """Expand out from changed nodes and edge endpoints in either direction."""
    included = set(chain(diff.nodes.added, diff.nodes.removed, diff.nodes.changed))
    for edge in chain(diff.edges.added, diff.edges.removed):
        included.update((edge.source, edge.target))
    if hops <= 0 or not included:
        return included

    adjacent: dict[str, set[str]] = defaultdict(set)
    for edge in chain(base.edges, head.edges):
        adjacent[edge.source].add(edge.target)
        adjacent[edge.target].add(edge.source)

    frontier = included
    for _ in range(hops):
        frontier = {neighbour for node in frontier for neighbour in adjacent[node]} - included
        if not frontier:
            break
        included.update(frontier)
    return included


def flow_depth(base: Graph, head: Graph, diff: GraphDiff, hops: int = 1) -> int:
    """Count nodes on the longest call chain after ignoring DFS back edges."""
    included = neighbourhood(base, head, diff, hops)
    if not included:
        return 0

    calls: dict[str, set[str]] = defaultdict(set)
    for edge in chain(base.edges, head.edges):
        if edge.kind == "call" and edge.source in included and edge.target in included:
            calls[edge.source].add(edge.target)

    visited: set[str] = set()
    depths: dict[str, int] = {}
    for start in sorted(included):
        if start in visited:
            continue
        visited.add(start)
        # Use an explicit stack so long call chains cannot exceed the recursion limit.
        stack = [(start, iter(sorted(calls[start])))]
        while stack:
            node, targets = stack[-1]
            target = next(targets, None)
            if target is None:
                # Only ancestors on the stack have unfinished depths here. Skip those back edges.
                depths[node] = 1 + max(
                    (depths[callee] for callee in calls[node] if callee in depths), default=0
                )
                stack.pop()
            elif target not in visited:
                visited.add(target)
                stack.append((target, iter(sorted(calls[target]))))
    return max(depths.values(), default=0)
