"""Check line-level changes and their revision-specific line numbers."""

from codeflow.line_changes import LineDiff, LineRow, line_changes


def test_unchanged_body() -> None:
    assert line_changes(
        ["def total():", "    return 1"], ["def total():", "    return 1"], 3, 8
    ) == (
        LineDiff(
            [LineRow("context", 3, 8, "def total():"), LineRow("context", 4, 9, "    return 1")],
            0,
            0,
        )
    )


def test_edited_lines(make_repo) -> None:
    base = "def total():\n    return 1\n"
    head = "# a shifted definition\n" + base.replace("1", "2")
    repo = make_repo([{"cart.py": base}, {"cart.py": head}])

    before = repo.git("show", "HEAD^:cart.py").splitlines()
    after = repo.git("show", "HEAD:cart.py").splitlines()[1:]
    assert line_changes(before, after, 1, 2) == LineDiff(
        [
            LineRow("context", 1, 2, "def total():"),
            LineRow("removed", 2, None, "    return 1"),
            LineRow("added", None, 3, "    return 2"),
        ],
        1,
        1,
    )


def test_inserted_line() -> None:
    before = ["def total():", "    return amount"]
    after = [before[0], "    amount = 1", before[1]]
    assert line_changes(before, after, 10, 20) == LineDiff(
        [
            LineRow("context", 10, 20, before[0]),
            LineRow("added", None, 21, after[1]),
            LineRow("context", 11, 22, before[1]),
        ],
        1,
        0,
    )


def test_deleted_line() -> None:
    after = ["def total():", "    return amount"]
    before = [after[0], "    print(amount)", after[1]]
    assert line_changes(before, after, 10, 20) == LineDiff(
        [
            LineRow("context", 10, 20, after[0]),
            LineRow("removed", 11, None, before[1]),
            LineRow("context", 12, 21, after[1]),
        ],
        0,
        1,
    )


def test_added_function() -> None:
    lines = ["def total():", "    return 1"]
    assert line_changes([], lines, 1, 5) == LineDiff(
        [
            LineRow("added", None, 5, lines[0]),
            LineRow("added", None, 6, lines[1]),
        ],
        2,
        0,
    )


def test_removed_function() -> None:
    lines = ["def total():", "    return 1"]
    assert line_changes(lines, [], 5, 1) == LineDiff(
        [
            LineRow("removed", 5, None, lines[0]),
            LineRow("removed", 6, None, lines[1]),
        ],
        0,
        2,
    )
