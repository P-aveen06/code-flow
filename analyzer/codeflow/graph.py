"""Small graph records and deterministic JSON serialization."""

from dataclasses import asdict, dataclass
from typing import Literal


@dataclass
class Commit:
    sha: str
    parents: list[str]
    author: str
    date: str
    message: str


@dataclass
class Guard:
    flag: str
    when: Literal["on", "off"]


@dataclass
class Node:
    id: str
    kind: Literal["function", "method", "class", "module", "external"]
    name: str
    module: str
    file: str
    line: int
    end_line: int
    body_hash: str


@dataclass
class Edge:
    source: str
    target: str
    kind: str = "call"
    line: int = 0
    guard: Guard | None = None


@dataclass
class FlagCheck:
    name: str
    file: str
    line: int
    function: str
    call: str


@dataclass
class Graph:
    schema: str
    repo: str
    commit: Commit
    nodes: list[Node]
    edges: list[Edge]
    flags: list[FlagCheck]

    def to_json(self) -> dict:
        result = asdict(self)
        result["nodes"] = sorted(result["nodes"], key=lambda node: node["id"])
        result["edges"] = sorted(result["edges"], key=lambda edge: (edge["source"], edge["target"]))
        result["flags"] = sorted(
            result["flags"], key=lambda flag: (flag["name"], flag["file"], flag["line"])
        )
        return result

    @classmethod
    def from_json(cls, data: dict) -> "Graph":
        edges = []
        for value in data["edges"]:
            edge = dict(value)
            edge["guard"] = Guard(**edge["guard"]) if edge["guard"] else None
            edges.append(Edge(**edge))
        return cls(
            schema=data["schema"],
            repo=data["repo"],
            commit=Commit(**data["commit"]),
            nodes=[Node(**node) for node in data["nodes"]],
            edges=edges,
            flags=[FlagCheck(**flag) for flag in data["flags"]],
        )
