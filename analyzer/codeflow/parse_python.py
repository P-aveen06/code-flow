"""Parse Python definitions, imports, calls, receiver types, and flags."""

import ast
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from hashlib import sha1
from pathlib import PurePosixPath

import tree_sitter_python
from tree_sitter import Language, Node, Parser

from codeflow.flags import (
    DEFAULT_FLAG_METHODS,
    FlagKeyReference,
    GuardBranch,
    ReferenceGuard,
    dotted_name,
    flag_check_of_call,
    guard_from_condition,
    literal_string,
    unwrap,
)
from codeflow.graph import FlagCheck, Guard


@dataclass
class Definition:
    qualname: str
    kind: str
    line: int
    end_line: int
    body_hash: str


@dataclass
class CallSite:
    caller: str
    callee: str
    line: int
    guard: Guard | None = None
    guard_branch: GuardBranch | None = None


@dataclass
class FlagReference:
    name: str
    line: int
    scope: str
    call: str


@dataclass
class ParsedFile:
    path: str
    module: str
    definitions: list[Definition] = field(default_factory=list)
    imports: dict[str, str] = field(default_factory=dict)
    bases: dict[str, list[str]] = field(default_factory=dict)
    calls: list[CallSite] = field(default_factory=list)
    flags: list[FlagCheck] = field(default_factory=list)
    receiver_types: dict[str, dict[str, str]] = field(default_factory=dict)
    receiver_shadows: dict[str, list[str]] = field(default_factory=dict)
    string_constants: dict[str, str] = field(default_factory=dict)
    flag_bindings: dict[str, dict[str, str | None]] = field(default_factory=dict)
    flag_references: list[FlagReference] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "ParsedFile":
        calls = []
        for value in data["calls"]:
            call = dict(value)
            call["guard"] = Guard(**call["guard"]) if call["guard"] else None
            if branch := call.get("guard_branch"):
                call["guard_branch"] = GuardBranch.from_dict(branch)
            calls.append(CallSite(**call))
        return cls(
            path=data["path"],
            module=data["module"],
            definitions=[Definition(**value) for value in data["definitions"]],
            imports=dict(data["imports"]),
            bases={name: list(bases) for name, bases in data["bases"].items()},
            calls=calls,
            flags=[FlagCheck(**value) for value in data["flags"]],
            receiver_types={
                scope: dict(types) for scope, types in data.get("receiver_types", {}).items()
            },
            receiver_shadows={
                scope: list(names) for scope, names in data.get("receiver_shadows", {}).items()
            },
            string_constants=dict(data.get("string_constants", {})),
            flag_bindings={
                scope: dict(names) for scope, names in data.get("flag_bindings", {}).items()
            },
            flag_references=[FlagReference(**value) for value in data.get("flag_references", [])],
        )


def module_name(path: str, source_root: str = "") -> str:
    relative = PurePosixPath(path).relative_to(source_root) if source_root else PurePosixPath(path)
    parts = list(relative.with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def body_hash(node: Node) -> str:
    """Hash leaf tokens, excluding comments and nested definitions (and their decorators)."""

    def tokens(current: Node) -> list[bytes]:
        if current.type == "comment":
            return []
        if current != node and current.type in (
            "function_definition",
            "class_definition",
            "decorated_definition",
        ):
            return []
        if not current.children:
            return [current.text] if current.text else []
        return [token for child in current.children for token in tokens(child)]

    return sha1(b" ".join(tokens(node))).hexdigest()


def import_bindings(node: Node, parsed: ParsedFile) -> list[tuple[str, str]]:
    prefix = ""
    if node.type == "import_from_statement":
        module = node.child_by_field_name("module_name").text.decode()
        if module.startswith("."):
            level = len(module) - len(module.lstrip("."))
            package = parsed.module.split(".")
            if PurePosixPath(parsed.path).name != "__init__.py":
                package.pop()
            prefix_parts = package[: max(0, len(package) - level + 1)]
            suffix = module[level:]
            prefix = ".".join(prefix_parts + ([suffix] if suffix else []))
        else:
            prefix = module
    bindings = []
    for item in node.children_by_field_name("name"):
        name_node = item.child_by_field_name("name") if item.type == "aliased_import" else item
        name = name_node.text.decode()
        alias = item.child_by_field_name("alias")
        if alias:
            local = alias.text.decode()
        else:
            local = name if prefix else name.split(".")[0]
        target = f"{prefix}.{name}" if prefix else name
        if node.type == "import_statement" and not alias:
            target = local
        bindings.append((local, target))
    return bindings


def binding_names(node: Node | None) -> list[str]:
    if node is None:
        return []
    if node.type == "identifier":
        return [node.text.decode()]
    if node.type in (
        "as_pattern_target",
        "expression_list",
        "list_pattern",
        "list_splat_pattern",
        "parenthesized_expression",
        "pattern_list",
        "tuple_pattern",
    ):
        return [name for child in node.named_children for name in binding_names(child)]
    return []


def _without_none(annotation: ast.expr) -> ast.expr:
    if isinstance(annotation, ast.Subscript) and ast.unparse(annotation.value) in (
        "Optional",
        "typing.Optional",
    ):
        return annotation.slice
    if isinstance(annotation, ast.BinOp) and isinstance(annotation.op, ast.BitOr):
        if isinstance(annotation.right, ast.Constant) and annotation.right.value is None:
            return annotation.left
        if isinstance(annotation.left, ast.Constant) and annotation.left.value is None:
            return annotation.right
    return annotation


def _annotation_expression(text: str) -> ast.expr:
    # Annotations in parameter lists can use implicit line continuation.
    return ast.parse(f"({text}\n)", mode="eval").body


def _annotation_name(text: str) -> str | None:
    try:
        annotation = _annotation_expression(text)
        if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
            annotation = _annotation_expression(annotation.value)
        annotation = _without_none(annotation)
        if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
            annotation = _annotation_expression(annotation.value)
    except (SyntaxError, ValueError):
        return None
    if isinstance(annotation, (ast.Name, ast.Attribute)):
        name = ast.unparse(annotation)
        if all(part.isidentifier() for part in name.split(".")):
            return name
    return None


def _constructor_name(value: Node | None) -> str | None:
    while value is not None:
        value = unwrap(value)
        if value.type == "call":
            return dotted_name(value.child_by_field_name("function"))
        if value.type != "assignment":
            break
        value = value.child_by_field_name("right")
    return None


class _Walker:
    def __init__(self, parsed: ParsedFile, flag_methods: Sequence[str]):
        self.parsed = parsed
        self.flag_methods = flag_methods
        self.receiver_bindings: dict[str, dict[str, set[str | None]]] = {}
        self.flag_bindings: dict[str, dict[str, str | None]] = {}
        self.global_names: dict[str, set[str]] = {}

    def bind_flag_name(
        self, scope: str, name: str, imported: str | None = None, constant: str | None = None
    ) -> None:
        if scope and name in self.global_names.get(scope, ()):
            # Writes from a function make the module value uncertain.
            self.flag_bindings.setdefault("", {})[name] = None
            self.parsed.string_constants.pop(name, None)
            return
        bindings = self.flag_bindings.setdefault(scope, {})
        if imported is not None and bindings.get(name) == imported:
            return
        if name in bindings:
            bindings[name] = None
            if not scope:
                self.parsed.string_constants.pop(name, None)
        else:
            bindings[name] = imported
            if constant is not None:
                self.parsed.string_constants[name] = constant

    def collect_flag_bindings(self) -> None:
        heads = {flag.name.partition(".")[0] for flag in self.parsed.flag_references}
        for scope, bindings in self.flag_bindings.items():
            relevant = {name: bindings[name] for name in bindings.keys() & heads}
            if relevant:
                self.parsed.flag_bindings[scope] = relevant

    def receiver_binding(self, scope: str, name: str) -> set[str | None]:
        return self.receiver_bindings.setdefault(scope, {}).setdefault(name, set())

    def receiver_parameters(self, parameters: Node, scope: str) -> None:
        for parameter in parameters.named_children:
            name = parameter.child_by_field_name("name") or parameter
            annotation = parameter.child_by_field_name("type")
            if parameter.type == "typed_parameter":
                name = parameter.named_children[0]
            if name.type in ("list_splat_pattern", "dictionary_splat_pattern"):
                name = name.named_children[0]
                annotation = None
            if name.type == "identifier":
                parameter_name = name.text.decode()
                self.bind_flag_name(scope, parameter_name)
                types = self.receiver_binding(scope, parameter_name)
                if annotation:
                    type_name = _annotation_name(annotation.text.decode())
                    if type_name:
                        types.add(type_name)

    def collect_receiver_types(self) -> None:
        for scope, bindings in self.receiver_bindings.items():
            known = {}
            for name, candidates in bindings.items():
                if len(candidates) == 1:
                    candidate = next(iter(candidates))
                    if candidate is not None:
                        known[name] = candidate
            if known:
                self.parsed.receiver_types[scope] = known

        module_types = self.parsed.receiver_types.get("", {})
        for scope, bindings in self.receiver_bindings.items():
            if scope:
                shadowed = bindings.keys() & module_types.keys()
                if shadowed:
                    self.parsed.receiver_shadows[scope] = sorted(shadowed)

    def walk(
        self,
        node: Node,
        scope: str = "",
        scope_kind: str = "module",
        guard: Guard | GuardBranch | None = None,
        variables: dict[str, str | FlagKeyReference] | None = None,
    ) -> None:
        if variables is None:
            variables = {}
        if node.type in ("function_definition", "class_definition"):
            self.definition(node, scope, scope_kind)
            return
        if node.type in ("import_statement", "import_from_statement"):
            for name, target in import_bindings(node, self.parsed):
                self.parsed.imports[name] = target
                self.bind_flag_name(scope, name, imported=target)
            return
        if node.type == "if_statement":
            self.branches(node, scope, scope_kind, guard, variables)
            return
        if node.type == "assignment":
            self.assignment(node, scope, scope_kind, variables)
        elif node.type == "global_statement":
            self.global_names.setdefault(scope, set()).update(
                child.text.decode() for child in node.named_children if child.type == "identifier"
            )
        elif node.type in (
            "augmented_assignment",
            "for_statement",
            "named_expression",
            "as_pattern",
        ):
            field = {"named_expression": "name", "as_pattern": "alias"}.get(node.type, "left")
            for name in binding_names(node.child_by_field_name(field)):
                self.bind_flag_name(scope, name)
        elif node.type == "delete_statement":
            for name in binding_names(node.named_child(0)):
                self.bind_flag_name(scope, name)
        elif node.type == "call":
            self.call(node, scope, scope_kind, guard)
        for child in node.named_children:
            self.walk(child, scope, scope_kind, guard, variables)

    def assignment(
        self, node: Node, scope: str, kind: str, variables: dict[str, str | FlagKeyReference]
    ) -> None:
        left = node.child_by_field_name("left")
        if left is None or left.type != "identifier":
            for name in binding_names(left):
                self.bind_flag_name(scope, name)
            return

        name = left.text.decode()
        right = node.child_by_field_name("right")
        constant = None
        if (
            not scope
            and node.parent.type == "expression_statement"
            and node.parent.parent.type == "module"
            and right is not None
            and unwrap(right).type == "string"
        ):
            constant = literal_string(right)
        self.bind_flag_name(scope, name, constant=constant)

        if kind != "class":
            types = self.receiver_binding(scope, name)
            if right:
                types.add(_constructor_name(right))
        if right:
            check = flag_check_of_call(right, self.flag_methods)
            variables.pop(name, None)
            if check:
                variables[name] = check[1]

    def definition(self, node: Node, scope: str, scope_kind: str) -> None:
        name = node.child_by_field_name("name").text.decode()
        self.bind_flag_name(scope, name)
        qualname = f"{scope}.{name}" if scope else name
        is_class = node.type == "class_definition"
        kind = "class" if is_class else "method" if scope_kind == "class" else "function"
        self.parsed.definitions.append(
            Definition(
                qualname, kind, node.start_point.row + 1, node.end_point.row + 1, body_hash(node)
            )
        )
        if is_class:
            bases = node.child_by_field_name("superclasses")
            self.parsed.bases[qualname] = (
                [base.text.decode() for base in bases.named_children] if bases else []
            )
        else:
            self.receiver_parameters(node.child_by_field_name("parameters"), qualname)
        self.walk(node.child_by_field_name("body"), qualname, "class" if is_class else "function")

    def call(self, node: Node, scope: str, kind: str, guard: Guard | GuardBranch | None) -> None:
        caller = scope if kind == "function" else ""
        callee = dotted_name(node.child_by_field_name("function"))
        check = flag_check_of_call(node, self.flag_methods)
        line = node.start_point.row + 1
        if check:
            method, flag = check
            if isinstance(flag, FlagKeyReference):
                self.parsed.flag_references.append(FlagReference(flag.name, line, scope, method))
            else:
                self.parsed.flags.append(FlagCheck(flag, self.parsed.path, line, caller, method))
        if caller and callee:
            if isinstance(guard, GuardBranch):
                self.parsed.calls.append(CallSite(caller, callee, line, guard.resolve(), guard))
            else:
                self.parsed.calls.append(CallSite(caller, callee, line, guard))

    def branches(
        self,
        node: Node,
        scope: str,
        kind: str,
        inherited: Guard | GuardBranch | None,
        variables: dict[str, str | FlagKeyReference],
    ) -> None:
        clauses = [node] + [
            child for child in node.named_children if child.type in ("elif_clause", "else_clause")
        ]
        conditions: list[Guard | ReferenceGuard | None] = []
        for clause in clauses:
            condition = clause.child_by_field_name("condition")
            if condition:
                self.walk(condition, scope, kind, inherited, variables.copy())
                conditions.append(guard_from_condition(condition, variables, self.flag_methods))
                body = clause.child_by_field_name("consequence")
            else:
                body = clause.child_by_field_name("body")
            branch = GuardBranch(conditions.copy(), condition is None, inherited)
            if isinstance(inherited, GuardBranch) or any(
                isinstance(test, ReferenceGuard) for test in conditions
            ):
                guard = branch
            else:
                guard = branch.resolve()
            self.walk(body, scope, kind, guard, variables.copy())
        # Branch assignments may not execute: do not keep potentially stale bindings.
        assigned = self.assigned_names(node)
        for name in assigned:
            variables.pop(name, None)

    def assigned_names(self, node: Node) -> set[str]:
        if node.type in ("function_definition", "class_definition"):
            return set()
        names = set()
        if node.type == "assignment":
            left = node.child_by_field_name("left")
            if left.type == "identifier":
                names.add(left.text.decode())
        for child in node.named_children:
            names.update(self.assigned_names(child))
        return names


def parse_file(
    path: str,
    source: bytes,
    source_root: str = "",
    flag_methods: Sequence[str] = DEFAULT_FLAG_METHODS,
) -> ParsedFile:
    parsed = ParsedFile(path, module_name(path, source_root))
    parser = Parser(Language(tree_sitter_python.language()))
    walker = _Walker(parsed, flag_methods)
    walker.walk(parser.parse(source).root_node)
    walker.collect_receiver_types()
    walker.collect_flag_bindings()
    return parsed
