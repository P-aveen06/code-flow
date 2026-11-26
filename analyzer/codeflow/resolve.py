"""Resolve parsed calls with lexical names, imports, and in-repo inheritance."""

from codeflow.graph import Edge
from codeflow.parse_python import ParsedFile


class _Resolver:
    def __init__(self, files: list[ParsedFile], keep_external: bool):
        self.files = {file.module: file for file in files}
        self.definitions = {
            f"{file.module}:{definition.qualname}": definition
            for file in files
            for definition in file.definitions
        }
        self.keep_external = keep_external

    def expand(self, name: str, file: ParsedFile, caller: str = "") -> str | None:
        """Expand a local/imported dotted name into an existing node id."""
        head, separator, tail = name.partition(".")
        scopes = caller.split(".") if caller else []
        while scopes:
            scope = ".".join(scopes)
            definition = self.definitions.get(f"{file.module}:{scope}")
            if definition and definition.kind != "class":
                candidate = f"{file.module}:{scope}.{name}"
                if candidate in self.definitions:
                    return candidate
            scopes.pop()
        local = f"{file.module}:{name}"
        if local in self.definitions:
            return local
        imported = file.imports.get(head)
        if not imported:
            return None
        full_name = imported + (f".{tail}" if separator else "")
        for module in sorted(self.files, key=len, reverse=True):
            if full_name.startswith(module + "."):
                target = f"{module}:{full_name[len(module) + 1 :]}"
                if target in self.definitions:
                    return target
                break
        package = imported.split(".")[0]
        internal = any(module.split(".")[0] == package for module in self.files)
        if self.keep_external and not internal:
            return f"external:{package}"
        return None

    def enclosing_class(self, file: ParsedFile, caller: str) -> str | None:
        parts = caller.split(".")[:-1]
        while parts:
            qualname = ".".join(parts)
            if qualname in file.bases:
                return f"{file.module}:{qualname}"
            parts.pop()
        return None

    def method(
        self, class_id: str, name: str, bases_only: bool = False, seen: set[str] | None = None
    ) -> str | None:
        if seen is None:
            seen = set()
        if class_id in seen:
            return None
        seen.add(class_id)
        candidate = f"{class_id}.{name}"
        if not bases_only and candidate in self.definitions:
            return candidate
        module, qualname = class_id.split(":", 1)
        file = self.files[module]
        for base in file.bases.get(qualname, []):
            base_id = self.expand(base, file, qualname.rpartition(".")[0])
            if base_id in self.definitions and self.definitions[base_id].kind == "class":
                target = self.method(base_id, name, seen=seen)
                if target:
                    return target
        return None

    def target(self, file: ParsedFile, caller: str, callee: str) -> str | None:
        receiver, separator, name = callee.partition(".")
        if separator and receiver in ("self", "cls", "super"):
            class_id = self.enclosing_class(file, caller)
            return self.method(class_id, name, receiver == "super") if class_id else None
        return self.expand(callee, file, caller)


def resolve_edges(files: list[ParsedFile], keep_external: bool = False) -> list[Edge]:
    resolver = _Resolver(files, keep_external)
    edges: dict[tuple[str, str], Edge] = {}
    for file in files:
        for call in sorted(file.calls, key=lambda call: call.line):
            target = resolver.target(file, call.caller, call.callee)
            if target is None:
                continue
            source = f"{file.module}:{call.caller}"
            key = (source, target)
            if key not in edges:
                edges[key] = Edge(source, target, line=call.line, guard=call.guard)
            elif edges[key].guard != call.guard:
                edges[key].guard = None
    return sorted(edges.values(), key=lambda edge: (edge.source, edge.target))
