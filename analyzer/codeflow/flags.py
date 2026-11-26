"""Recognize flag checks and evaluate simple branch conditions."""

from __future__ import annotations

import ast
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Literal

from tree_sitter import Node

from codeflow.graph import Guard

DEFAULT_FLAG_METHODS = (
    "is_feature_enabled",
    "get_feature_value",
    "has_feature",
    "feature_enabled",
    "get_value",
    "get_boolean_value",
    "get_string_value",
    "get_integer_value",
    "get_float_value",
    "get_object_value",
    "get_boolean_details",
    "get_string_details",
    "get_integer_details",
    "get_float_details",
    "get_object_details",
)


@dataclass(frozen=True)
class FlagKeyReference:
    name: str


@dataclass
class ReferenceGuard:
    reference: str
    when: Literal["on", "off"]


@dataclass
class GuardBranch:
    """Keep the conditions of a branch until its flag key references can be resolved."""

    conditions: list[Guard | ReferenceGuard | None]
    is_else: bool
    inherited: Guard | GuardBranch | None

    def resolve(self, resolve_key: Callable[[str], str | None] | None = None) -> Guard | None:
        conditions = []
        for condition in self.conditions:
            if isinstance(condition, ReferenceGuard):
                key = resolve_key(condition.reference) if resolve_key else None
                condition = Guard(key, condition.when) if key is not None else None
            conditions.append(condition)

        last = conditions[-1]
        if last and not self.is_else:
            return last
        if conditions[0]:
            # A flag-led chain carries the last failed flag test across ordinary elifs.
            return opposite(next(guard for guard in reversed(conditions) if guard))
        if self.is_else and last:
            return opposite(last)
        if isinstance(self.inherited, GuardBranch):
            return self.inherited.resolve(resolve_key)
        return self.inherited

    @classmethod
    def from_dict(cls, data: dict) -> GuardBranch:
        inherited = data["inherited"]
        if inherited is not None:
            inherited = (
                cls.from_dict(inherited) if "conditions" in inherited else Guard(**inherited)
            )
        conditions = []
        for value in data["conditions"]:
            condition = None
            if value is not None:
                condition = ReferenceGuard(**value) if "reference" in value else Guard(**value)
            conditions.append(condition)
        return cls(conditions, data["is_else"], inherited)


def dotted_name(node: Node | None, *, allow_super: bool = True) -> str | None:
    """Return a plain dotted callee, including the special super() receiver."""
    if node is None:
        return None
    if node.type == "identifier":
        return node.text.decode()
    if node.type == "attribute":
        receiver = node.child_by_field_name("object")
        head = dotted_name(receiver, allow_super=allow_super)
        if allow_super and receiver.type == "call":
            function = receiver.child_by_field_name("function")
            arguments = receiver.child_by_field_name("arguments")
            if (
                function.type == "identifier"
                and function.text == b"super"
                and not any(child.type != "comment" for child in arguments.named_children)
            ):
                head = "super"
        if head:
            return f"{head}.{node.child_by_field_name('attribute').text.decode()}"
    return None


def unwrap(node: Node) -> Node:
    while node.type == "parenthesized_expression":
        node = next(child for child in node.named_children if child.type != "comment")
    return node


def literal_string(node: Node) -> str | None:
    if unwrap(node).type not in ("string", "concatenated_string"):
        return None
    try:
        value = ast.literal_eval(f"({node.text.decode()}\n)")
    except (ValueError, SyntaxError):
        return None
    return value if isinstance(value, str) else None


def _flag_key(node: Node) -> str | FlagKeyReference | None:
    literal = literal_string(node)
    if literal is not None:
        return literal
    reference = dotted_name(unwrap(node), allow_super=False)
    return FlagKeyReference(reference) if reference else None


def flag_check_of_call(
    node: Node, flag_methods: Sequence[str] = DEFAULT_FLAG_METHODS
) -> tuple[str, str | FlagKeyReference] | None:
    """Return the evaluation method and its literal or referenced flag key."""
    node = unwrap(node)
    if node.type != "call":
        return None
    method = node.child_by_field_name("function")
    if method.type == "attribute":
        method = method.child_by_field_name("attribute")
    if method.type != "identifier" or (name := method.text.decode()) not in flag_methods:
        return None

    arguments = node.child_by_field_name("arguments")
    if arguments.type != "argument_list":
        return None
    positional = next((arg for arg in arguments.named_children if arg.type != "comment"), None)
    if positional is not None and (flag := _flag_key(positional)) is not None:
        return name, flag
    for arg in arguments.named_children:
        if arg.type == "keyword_argument" and arg.child_by_field_name("name").text == b"flag_key":
            flag = _flag_key(arg.child_by_field_name("value"))
            return (name, flag) if flag is not None else None
    return None


def guard_from_condition(
    node: Node,
    local_flag_vars: dict[str, str | FlagKeyReference],
    flag_methods: Sequence[str] = DEFAULT_FLAG_METHODS,
) -> Guard | ReferenceGuard | None:
    node = unwrap(node)
    negated = node.type == "not_operator"
    if negated:
        node = unwrap(node.child_by_field_name("argument"))
    if node.type == "identifier":
        flag = local_flag_vars.get(node.text.decode())
    else:
        check = flag_check_of_call(node, flag_methods)
        flag = check[1] if check else None
    when = "off" if negated else "on"
    if isinstance(flag, FlagKeyReference):
        return ReferenceGuard(flag.name, when)
    return Guard(flag, when) if flag is not None else None


def opposite(guard: Guard) -> Guard:
    return Guard(guard.flag, "off" if guard.when == "on" else "on")
