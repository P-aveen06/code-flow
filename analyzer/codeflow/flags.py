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


def _literal_string(node: Node) -> str | None:
    if unwrap(node).type not in ("string", "concatenated_string"):
        return None
    try:
        value = ast.literal_eval(f"({node.text.decode()}\n)")
    except (ValueError, SyntaxError):
        return None
    return value if isinstance(value, str) else None


def flag_check_of_call(
    node: Node, flag_methods: Sequence[str] = DEFAULT_FLAG_METHODS
) -> tuple[str, str] | None:
    """Return the evaluation method and literal flag key, if recognized."""
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
    if positional is not None and (flag := _literal_string(positional)) is not None:
        return name, flag
    for arg in arguments.named_children:
        if arg.type == "keyword_argument" and arg.child_by_field_name("name").text == b"flag_key":
            flag = _literal_string(arg.child_by_field_name("value"))
            return (name, flag) if flag is not None else None
    return None


def flag_name_of_call(node: Node, flag_methods: Sequence[str] = DEFAULT_FLAG_METHODS) -> str | None:
    """Return the flag key if this call is a recognized evaluation."""
    check = flag_check_of_call(node, flag_methods)
    return check[1] if check else None


def guard_from_condition(
    node: Node, local_flag_vars: dict[str, str], flag_methods: Sequence[str] = DEFAULT_FLAG_METHODS
) -> Guard | None:
    node = unwrap(node)
    negated = node.type == "not_operator"
    if negated:
        node = unwrap(node.child_by_field_name("argument"))
    if node.type == "identifier":
        flag = local_flag_vars.get(node.text.decode())
    else:
        flag = flag_name_of_call(node, flag_methods)
    return Guard(flag, "off" if negated else "on") if flag is not None else None


def opposite(guard: Guard | None) -> Guard | None:
    return Guard(guard.flag, "off" if guard.when == "on" else "on") if guard else None
