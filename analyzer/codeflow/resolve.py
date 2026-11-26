"""Resolve parsed calls with lexical names, imports, and in-repo inheritance."""

from functools import partial

from codeflow.graph import Edge
from codeflow.parse_python import ParsedFile


class Resolver:
    def __init__(self, files: list[ParsedFile], keep_external: bool):
        self.files = {file.module: file for file in files}
        self.packages = {module.partition(".")[0] for module in self.files}
        self.definitions = {
            f"{file.module}:{definition.qualname}": definition
            for file in files
            for definition in file.definitions
        }
        self.keep_external = keep_external

    def expand(self, name: str, file: ParsedFile, caller: str = "") -> str | None:
        """Expand a local/imported dotted name into an existing node id."""
        head = name.partition(".")[0]
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
        target = self.imported_symbol(name, imported)
        if target in self.definitions:
            return target
        if self.keep_external:
            package = imported.partition(".")[0]
            if package not in self.packages:
                return f"external:{package}"
        return None

    def imported_symbol(self, name: str, imported: str) -> str | None:
        _, separator, tail = name.partition(".")
        full_name = imported + (f".{tail}" if separator else "")
        module, dot, _ = full_name.rpartition(".")
        # The longest matching module owns the name, even if the symbol is absent.
        while dot:
            if module in self.files:
                return f"{module}:{full_name[len(module) + 1 :]}"
            module, dot, _ = module.rpartition(".")
        return None

    def flag_name(self, file: ParsedFile, scope: str, reference: str) -> str | None:
        head = reference.partition(".")[0]
        enclosing = scope
        while enclosing:
            definition = self.definitions[f"{file.module}:{enclosing}"]
            # A class namespace is visible in its own body, but not to enclosed scopes.
            if enclosing == scope or definition.kind != "class":
                bindings = file.flag_bindings.get(enclosing, {})
                if head in bindings:
                    return self.imported_constant(reference, bindings[head])
            enclosing = enclosing.rpartition(".")[0]
        if reference in file.string_constants:
            return file.string_constants[reference]
        return self.imported_constant(reference, file.flag_bindings.get("", {}).get(head))

    def imported_constant(self, reference: str, imported: str | None) -> str | None:
        target = self.imported_symbol(reference, imported) if imported else None
        if target is None:
            return None
        module, _, name = target.partition(":")
        return self.files[module].string_constants.get(name)

    def enclosing_class(self, file: ParsedFile, caller: str) -> str | None:
        parts = caller.split(".")[:-1]
        while parts:
            qualname = ".".join(parts)
            if qualname in file.bases:
                return f"{file.module}:{qualname}"
            parts.pop()
        return None

    def class_id(self, name: str, file: ParsedFile, caller: str = "") -> str | None:
        target = self.expand(name, file, caller)
        if target in self.definitions and self.definitions[target].kind == "class":
            return target
        return None

    def receiver_class(self, file: ParsedFile, caller: str, receiver: str) -> str | None:
        local_type = file.receiver_types.get(caller, {}).get(receiver)
        if local_type:
            return self.class_id(local_type, file, caller)
        if receiver not in file.receiver_shadows.get(caller, []):
            module_type = file.receiver_types.get("", {}).get(receiver)
            if module_type:
                return self.class_id(module_type, file)
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
            base_id = self.class_id(base, file, qualname.rpartition(".")[0])
            if base_id:
                target = self.method(base_id, name, seen=seen)
                if target:
                    return target
        return None

    def target(self, file: ParsedFile, caller: str, callee: str) -> str | None:
        receiver, separator, name = callee.partition(".")
        if separator and receiver in ("self", "cls", "super"):
            class_id = self.enclosing_class(file, caller)
            return self.method(class_id, name, receiver == "super") if class_id else None
        if separator:
            class_id = self.receiver_class(file, caller, receiver)
            if class_id:
                return self.method(class_id, name) if "." not in name else None
        return self.expand(callee, file, caller)

    def edges(self, files: list[ParsedFile]) -> list[Edge]:
        edges: dict[tuple[str, str], Edge] = {}
        for file in files:
            for call in sorted(file.calls, key=lambda call: call.line):
                target = self.target(file, call.caller, call.callee)
                if target is None:
                    continue
                guard = call.guard
                if call.guard_branch is not None:
                    guard = call.guard_branch.resolve(partial(self.flag_name, file, call.caller))
                source = f"{file.module}:{call.caller}"
                key = (source, target)
                if key not in edges:
                    edges[key] = Edge(source, target, line=call.line, guard=guard)
                elif edges[key].guard != guard:
                    edges[key].guard = None
        return sorted(edges.values(), key=lambda edge: (edge.source, edge.target))


def resolve_edges(files: list[ParsedFile], keep_external: bool = False) -> list[Edge]:
    return Resolver(files, keep_external).edges(files)
