"""Compare analyzed flag checks and guarded calls with live environment state."""

from collections import defaultdict
from collections.abc import Sequence

from codeflow.graph import FlagCheck, Graph

from app.flagsmith_client import FlagStates

STATUS_ORDER = ("orphan", "live", "off", "unused", "unknown")
MIN_STALE_COMMITS = 5
CheckLocation = tuple[str, str, str]


def _locations(checks: Sequence[FlagCheck]) -> dict[str, set[CheckLocation]]:
    locations = defaultdict(set)
    for check in checks:
        locations[check.name].add((check.file, check.function, check.call))
    return locations


def _unchanged_flags(
    current: Sequence[FlagCheck], earlier: Sequence[Sequence[FlagCheck]]
) -> set[str]:
    expected = _locations(current)
    unchanged = set(expected)
    for checks in earlier:
        locations = _locations(checks)
        unchanged = {name for name in unchanged if locations.get(name) == expected[name]}
        if not unchanged:
            break
    return unchanged


def _status(checked: bool, enabled: bool | None, connected: bool) -> str:
    if not connected:
        return "unknown"
    if enabled is None:
        return "orphan"
    if not checked:
        return "unused"
    return "live" if enabled else "off"


def find_flags(
    snapshot: Graph,
    earlier_checks: Sequence[Sequence[FlagCheck]],
    scope: set[str],
    live_state: FlagStates | None,
) -> list[dict]:
    """Build findings for a snapshot and the listed commits preceding it."""
    states = {name: state for name, state in (live_state or {}).items() if name in scope}
    checks_by_name = defaultdict(list)
    for check in snapshot.flags:
        checks_by_name[check.name].append(
            {"file": check.file, "line": check.line, "function": check.function, "call": check.call}
        )

    edges_by_name = defaultdict(list)
    for edge in snapshot.edges:
        if edge.guard is None:
            continue
        enabled, _ = states.get(edge.guard.flag, (None, None))
        edges_by_name[edge.guard.flag].append(
            {
                "source": edge.source,
                "target": edge.target,
                "when": edge.guard.when,
                "live": enabled == (edge.guard.when == "on") if enabled is not None else None,
            }
        )

    commit_count = len(earlier_checks) + 1
    unchanged = set()
    if states and commit_count >= MIN_STALE_COMMITS:
        unchanged = _unchanged_flags(snapshot.flags, earlier_checks)

    findings = []
    for name in checks_by_name.keys() | states.keys():
        enabled, value = states.get(name, (None, None))
        checks = checks_by_name[name]
        guarded_edges = edges_by_name[name]
        stale = name in unchanged and (enabled is False or (enabled is True and value is None))
        state_label = "On" if enabled else "Off"
        findings.append(
            {
                "name": name,
                "status": _status(bool(checks), enabled, live_state is not None),
                "enabled": enabled,
                "value": value,
                "in_flagsmith": name in states,
                "checks": checks,
                "guarded_edges": guarded_edges,
                "stale": stale,
                "stale_reason": (
                    f"{state_label} in Flagsmith and unchanged for {commit_count} analyzed commits"
                    if stale
                    else None
                ),
                "dead_calls": [
                    {"source": edge["source"], "target": edge["target"]}
                    for edge in guarded_edges
                    if edge["live"] is False
                ],
            }
        )
    return sorted(findings, key=lambda flag: (STATUS_ORDER.index(flag["status"]), flag["name"]))
