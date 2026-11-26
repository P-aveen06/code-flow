"""Assemble one commit's parsed files into the graph JSON model."""

from dataclasses import replace

from codeflow.graph import Commit, FlagCheck, Graph, Node
from codeflow.parse_python import ParsedFile
from codeflow.resolve import Resolver


def build_graph(
    files: list[ParsedFile], repo: str, commit: Commit, keep_external: bool = False
) -> Graph:
    nodes = [
        Node(
            id=f"{file.module}:{definition.qualname}",
            kind=definition.kind,
            name=definition.qualname.rsplit(".", 1)[-1],
            module=file.module,
            file=file.path,
            line=definition.line,
            end_line=definition.end_line,
            body_hash=definition.body_hash,
        )
        for file in files
        for definition in file.definitions
    ]
    resolver = Resolver(files, keep_external)
    edges = resolver.edges(files)
    external_ids = {edge.target for edge in edges if edge.target.startswith("external:")}
    nodes.extend(
        Node(node_id, "external", node_id.split(":", 1)[1], "", "", 0, 0, "")
        for node_id in external_ids
    )
    flags = [
        replace(flag, function=f"{file.module}:{flag.function}")
        for file in files
        for flag in file.flags
    ]
    for file in files:
        for reference in file.flag_references:
            name = resolver.flag_name(file, reference.scope, reference.name)
            if name is None:
                continue
            scope = f"{file.module}:{reference.scope}"
            definition = resolver.definitions.get(scope)
            function = scope if definition and definition.kind != "class" else f"{file.module}:"
            flags.append(FlagCheck(name, file.path, reference.line, function, reference.call))
    return Graph(
        schema="code-flow/graph@1",
        repo=repo,
        commit=commit,
        nodes=sorted(nodes, key=lambda node: node.id),
        edges=edges,
        flags=sorted(flags, key=lambda flag: (flag.name, flag.file, flag.line)),
    )
