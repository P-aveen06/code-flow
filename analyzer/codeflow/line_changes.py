"""Compare source spans and preserve line numbers from both revisions."""

from collections.abc import Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Literal


@dataclass(frozen=True)
class LineRow:
    kind: Literal["context", "added", "removed"]
    base_line: int | None
    head_line: int | None
    text: str


@dataclass(frozen=True)
class LineDiff:
    rows: list[LineRow]
    lines_added: int
    lines_removed: int


def line_changes(
    base: Sequence[str], head: Sequence[str], base_start: int, head_start: int
) -> LineDiff:
    """Diff two spans. Use an empty sequence for a symbol absent from a revision."""
    rows: list[LineRow] = []
    added = removed = 0
    for tag, first_base, last_base, first_head, last_head in SequenceMatcher(
        None, base, head, autojunk=False
    ).get_opcodes():
        if tag == "equal":
            rows.extend(
                LineRow(
                    "context", base_start + first_base + offset, head_start + index, head[index]
                )
                for offset, index in enumerate(range(first_head, last_head))
            )
        if tag in ("replace", "delete"):
            rows.extend(
                LineRow("removed", base_start + index, None, base[index])
                for index in range(first_base, last_base)
            )
            removed += last_base - first_base
        if tag in ("replace", "insert"):
            rows.extend(
                LineRow("added", None, head_start + index, head[index])
                for index in range(first_head, last_head)
            )
            added += last_head - first_head
    return LineDiff(rows, added, removed)
