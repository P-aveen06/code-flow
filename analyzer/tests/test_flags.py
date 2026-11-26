"""Check flag detection and the limited branch guard rules."""

import pytest

from codeflow.flags import DEFAULT_FLAG_METHODS
from codeflow.graph import Guard
from codeflow.parse_python import parse_file


def guarded_calls(body, methods=DEFAULT_FLAG_METHODS):
    source = "def run():\n" + "\n".join(" " + line for line in body.splitlines())
    parsed = parse_file("m.py", source.encode(), flag_methods=methods)
    return parsed, {
        call.callee: call.guard for call in parsed.calls if call.callee.startswith("do_")
    }


@pytest.mark.parametrize(
    "condition,on,off",
    [
        ("flags.is_feature_enabled('x')", "on", "off"),
        ("(flags.has_feature('x'))", "on", "off"),
        ("not (flags.feature_enabled('x'))", "off", "on"),
    ],
)
def test_direct_conditions_and_else(condition, on, off):
    parsed, calls = guarded_calls(f"if {condition}:\n do_yes()\nelse:\n do_no()")
    assert calls == {"do_yes": Guard("x", on), "do_no": Guard("x", off)}
    assert parsed.flags[0].function == "run"
    assert parsed.flags[0].file == "m.py"
    assert parsed.flags[0].line == 2


def test_elif_own_flag_wins_and_supplies_the_next_fallthrough():
    _, calls = guarded_calls(
        "if flags.has_feature('a'):\n do_a()\nelif not flags.has_feature('b'):\n"
        " do_b()\nelif other:\n do_other()\nelse:\n do_else()"
    )
    assert calls == {
        "do_a": Guard("a", "on"),
        "do_b": Guard("b", "off"),
        "do_other": Guard("b", "on"),
        "do_else": Guard("b", "on"),
    }


def test_flag_fallthrough_reaches_each_later_body():
    _, calls = guarded_calls(
        "if flags.has_feature('a'):\n do_a()\nelif other:\n do_b()\n"
        "elif another:\n do_c()\nelse:\n do_else()"
    )
    assert calls == {
        "do_a": Guard("a", "on"),
        "do_b": Guard("a", "off"),
        "do_c": Guard("a", "off"),
        "do_else": Guard("a", "off"),
    }


def test_nonflag_first_condition_keeps_existing_elif_behavior():
    _, calls = guarded_calls(
        "if ordinary:\n do_first()\nelif flags.has_feature('a'):\n do_a()\n"
        "elif other:\n do_b()\nelse:\n do_else()"
    )
    assert calls == {"do_first": None, "do_a": Guard("a", "on"), "do_b": None, "do_else": None}

    _, calls = guarded_calls(
        "if ordinary:\n do_first()\nelif flags.has_feature('a'):\n do_a()\nelse:\n do_else()"
    )
    assert calls == {"do_first": None, "do_a": Guard("a", "on"), "do_else": Guard("a", "off")}


@pytest.mark.parametrize("condition,when", [("enabled", "on"), ("not (enabled)", "off")])
def test_local_flag_variable(condition, when):
    _, calls = guarded_calls(f"enabled = flags.get_value('x')\nif {condition}:\n do_yes()")
    assert calls["do_yes"] == Guard("x", when)


def test_reassigned_variable_is_not_a_guard():
    _, calls = guarded_calls(
        "enabled = flags.has_feature('x')\nenabled = False\nif enabled:\n do_yes()"
    )
    assert calls["do_yes"] is None


def test_flag_variable_does_not_leak_into_nested_function():
    parsed, _ = guarded_calls(
        "enabled = flags.has_feature('x')\ndef inner():\n if enabled:\n  do_yes()"
    )
    assert next(call for call in parsed.calls if call.callee == "do_yes").guard is None


def test_nested_guard_wins_and_outer_guard_resumes():
    _, calls = guarded_calls(
        "if flags.has_feature('outer'):\n if flags.has_feature('inner'):\n  do_inner()\n"
        " else:\n  do_other()\n if ordinary:\n  do_outer()\n do_after()"
    )
    assert calls == {
        "do_inner": Guard("inner", "on"),
        "do_other": Guard("inner", "off"),
        "do_outer": Guard("outer", "on"),
        "do_after": Guard("outer", "on"),
    }


@pytest.mark.parametrize(
    "condition",
    [
        "flags.has_feature('x') and ready",
        "ready or flags.has_feature('x')",
        "flags.has_feature('x') == True",
        "not not flags.has_feature('x')",
    ],
)
def test_non_guard_conditions(condition):
    parsed, calls = guarded_calls(f"if {condition}:\n do_yes()")
    assert len(parsed.flags) == 1
    assert calls["do_yes"] is None


@pytest.mark.parametrize("argument", ["name", "f'{name}'", "b'x'", "123"])
def test_nonliteral_string_ignored(argument):
    parsed, calls = guarded_calls(f"if flags.has_feature({argument}):\n do_yes()")
    assert parsed.flags == []
    assert calls["do_yes"] is None


@pytest.mark.parametrize("method", DEFAULT_FLAG_METHODS)
def test_all_default_methods(method):
    parsed, calls = guarded_calls(f"if {method}('x'):\n do_yes()")
    assert parsed.flags[0].call == method
    assert calls["do_yes"] == Guard("x", "on")


def test_custom_methods_replace_defaults():
    parsed, calls = guarded_calls(
        "if client.toggle('x'):\n do_yes()\nif flags.has_feature('y'):\n do_no()", ("toggle",)
    )
    assert [flag.name for flag in parsed.flags] == ["x"]
    assert calls == {"do_yes": Guard("x", "on"), "do_no": None}


def test_module_level_flag_check():
    parsed = parse_file("m.py", b"enabled = flags.has_feature('x')\n")
    assert parsed.flags[0].function == ""
    assert parsed.calls == []


def test_comments_in_flag_arguments_and_parentheses():
    parsed, calls = guarded_calls(
        "if (\n # condition\n flags.has_feature(\n  # argument\n  'x'\n )\n):\n do_yes()"
    )
    assert [flag.name for flag in parsed.flags] == ["x"]
    assert calls["do_yes"] == Guard("x", "on")
