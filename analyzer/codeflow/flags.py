"""Recognize literal flag checks and simple branch conditions."""

import ast
from collections.abc import Sequence

from tree_sitter import Node

from codeflow.graph import Guard

DEFAULT_FLAG_METHODS = (
    "is_feature_enabled",
    "get_feature_value",
    "has_feature",
    "feature_enabled",
    "get_value",
)


def dotted_name(node: Node | None) -> str | None:
    """Return a plain dotted callee, including the special super() receiver."""
    if node is None:
        return None
    if node.type == "identifier":
        return node.text.decode()
    if node.type == "attribute":
        receiver = node.child_by_field_name("object")
        head = dotted_name(receiver)
        if receiver.type == "call":
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


def flag_name_of_call(node: Node, flag_methods: Sequence[str] = DEFAULT_FLAG_METHODS) -> str | None:
    node = unwrap(node)
    if node.type != "call":
        return None
    name = dotted_name(node.child_by_field_name("function"))
    arguments = [
        child
        for child in node.child_by_field_name("arguments").named_children
        if child.type != "comment"
    ]
    if not name or name.rsplit(".", 1)[-1] not in flag_methods or not arguments:
        return None
    try:
        value = ast.literal_eval(arguments[0].text.decode())
    except (ValueError, SyntaxError):
        return None
    return value if isinstance(value, str) else None


def guard_from_condition(
    node: Node, local_flag_vars: dict[str, str], flag_methods: Sequence[str] = DEFAULT_FLAG_METHODS
) -> Guard | None:
    node = unwrap(node)
    negated = node.type == "not_operator"
    if negated:
        node = unwrap(node.child_by_field_name("argument"))
    flag = (
        local_flag_vars.get(node.text.decode())
        if node.type == "identifier"
        else flag_name_of_call(node, flag_methods)
    )
    return Guard(flag, "off" if negated else "on") if flag is not None else None


def opposite(guard: Guard | None) -> Guard | None:
    return Guard(guard.flag, "off" if guard.when == "on" else "on") if guard else None
