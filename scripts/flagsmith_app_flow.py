"""Show or switch the app_flow and ui_* flags between experiment rounds.

Round 1 splits app_flow 34/33/33 with every ui_* switch following it ("flow"). An ablation round
turns more switches off (today's UI). A stacking round splits one switch 34/33/33 ("split") as
its own experiment, or pins it to a, b or c. Usage:

    python3 scripts/flagsmith_app_flow.py show
    python3 scripts/flagsmith_app_flow.py set ui_flow_view_layout=off ui_branch_switch=off
    python3 scripts/flagsmith_app_flow.py reset        # back to the round 1 state

Simulation environments only (Development by default); Production is refused.
"""

import argparse
import fcntl
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from flagsmith_setup import (
    APP_FLOW_FLAG,
    DEFAULT_API_URL,
    DEFAULT_SIM_ENVIRONMENT,
    PRODUCTION_ENVIRONMENT,
    PROJECT_NAME,
    SIM_ENVIRONMENT_SETTING,
    UI_SWITCH_NAMES,
    AdminClient,
    AdminError,
    Flag,
    Record,
    SetupError,
    apply_flag_defaults,
    find_record,
    get_flag_state,
    read_env,
    select_environment,
)

FLOWS = ("a", "b", "c")
# 34/33/33 in whole percentages, as app_flow's split and the simulator's STACKING_SPLIT.
SPLIT = {"a": 0, "b": 33, "c": 33}
APP_FLOW_SETTINGS = ("off", "split", *FLOWS)
UI_SETTINGS = ("off", "flow", "split", *FLOWS)
FLAG_NAMES = (APP_FLOW_FLAG.name, *UI_SWITCH_NAMES)
ACTIVE_STATES = ("running", "paused")


@dataclass(frozen=True)
class Target:
    enabled: bool
    value: str
    weights: dict[str, int]


def settings_for(name: str) -> tuple[str, ...]:
    return APP_FLOW_SETTINGS if name == APP_FLOW_FLAG.name else UI_SETTINGS


def parse_assignments(entries: list[str]) -> dict[str, str]:
    """Parse NAME=SETTING entries, such as ui_buttons=off, into flag name -> setting."""
    assignments: dict[str, str] = {}
    for entry in entries:
        name, separator, setting = entry.partition("=")
        name, setting = name.strip(), setting.strip()
        if not separator or not name or not setting:
            raise SetupError(f"Use NAME=SETTING, such as ui_buttons=off; got {entry!r}.")
        if name not in FLAG_NAMES:
            raise SetupError(f"Unknown flag {name!r}. Use app_flow or a ui_ switch name.")
        if setting not in settings_for(name):
            raise SetupError(
                f"{name} takes one of {', '.join(settings_for(name))}; got {setting!r}."
            )
        if name in assignments and assignments[name] != setting:
            raise SetupError(f"{name} is set twice.")
        assignments[name] = setting
    if not assignments:
        raise SetupError("Name at least one flag, such as ui_buttons=off.")
    return assignments


def option_values(feature: Record) -> dict[int, str]:
    return {option["id"]: option["string_value"] for option in feature["multivariate_options"]}


def describe(feature: Record, state: Record) -> str:
    """The setting a live state matches, or its raw value and weights."""
    values = option_values(feature)
    weights = {
        values.get(row["multivariate_feature_option"], "?"): row["percentage_allocation"]
        for row in state["multivariate_feature_state_values"]
    }
    value = state["feature_state_value"]
    if not state["enabled"]:
        return "off"
    if not any(weights.values()) and (value in FLOWS or value == "flow"):
        return str(value)
    if value == "a" and {name: weight for name, weight in weights.items() if weight} == {
        name: weight for name, weight in SPLIT.items() if weight
    }:
        return "split"
    shown = ", ".join(f"{name} {weight:g}%" for name, weight in sorted(weights.items()) if weight)
    return f"custom (value {value!r}{', ' + shown if shown else ''})"


def target_for(name: str, setting: str, feature: Record, state: Record) -> Target:
    """The enabled state, control value and option weights for one setting."""
    values = set(option_values(feature).values())
    if setting == "off":
        # Only the switch changes, so turning it back on restores the same split or pin.
        current = {
            option_values(feature).get(row["multivariate_feature_option"]): row[
                "percentage_allocation"
            ]
            for row in state["multivariate_feature_state_values"]
        }
        weights = {value: int(current.get(value) or 0) for value in values}
        return Target(False, str(state["feature_state_value"]), weights)
    if setting == "split":
        return Target(True, "a", {value: SPLIT.get(value, 0) for value in values})
    return Target(True, setting, {value: 0 for value in values})


def find_features(client: AdminClient, environment_name: str) -> tuple[Record, dict[str, Record]]:
    organisations = client.list("organisations/")
    if len(organisations) != 1:
        raise SetupError("The admin API key must identify exactly one Flagsmith organisation.")
    projects = client.list(f"projects/?organisation={organisations[0]['id']}")
    project = find_record(projects, "name", PROJECT_NAME, "project")
    if project is None:
        raise SetupError("The code-flow project was not found.")
    project_path = f"projects/{project['id']}/"
    environment = select_environment(client.list(f"{project_path}environments/"), environment_name)
    features = {feature["name"]: feature for feature in client.list(f"{project_path}features/")}
    missing = [name for name in FLAG_NAMES if name not in features]
    if missing:
        raise SetupError(
            f"Missing flags: {', '.join(missing)}. Run make flagsmith-setup-app-flow first."
        )
    return environment, {name: features[name] for name in FLAG_NAMES}


def active_experiments(client: AdminClient, environment: Record) -> dict[int, str]:
    """Feature id -> name of its running or paused experiment."""
    try:
        experiments = client.list(f"environments/{environment['api_key']}/experiments/")
    except AdminError as error:
        if error.status in (403, 404):
            return {}
        raise
    return {
        experiment["feature"]["id"]: experiment["name"]
        for experiment in experiments
        if experiment["status"] in ACTIVE_STATES
    }


def show(client: AdminClient, environment_name: str) -> None:
    environment, features = find_features(client, environment_name)
    running = active_experiments(client, environment)
    print(f"Flagsmith environment {PROJECT_NAME}/{environment['name']}:")
    for name, feature in features.items():
        state = get_flag_state(client, environment, feature["id"])
        setting = describe(feature, state) if state else "no state"
        note = (
            f"  (experiment running: {running[feature['id']]})" if feature["id"] in running else ""
        )
        print(f"  {name:<24} {setting}{note}")


def set_flags(
    client: AdminClient, environment_name: str, assignments: dict[str, str], dry_run: bool
) -> None:
    environment, features = find_features(client, environment_name)
    running = active_experiments(client, environment)
    blocked = [name for name in assignments if features[name]["id"] in running]
    if blocked:
        # Flagsmith manages a flag's state while its experiment runs.
        raise SetupError(
            f"{', '.join(blocked)} has a running experiment. Complete it before switching."
        )
    print(f"Flagsmith environment {PROJECT_NAME}/{environment['name']}:")
    for name, setting in assignments.items():
        feature = features[name]
        state = get_flag_state(client, environment, feature["id"])
        if state is None:
            raise SetupError(f"{name} has no state in {environment['name']}.")
        before = describe(feature, state)
        if before == setting:
            print(f"  {name}: already {setting}")
            continue
        target = target_for(name, setting, feature, state)
        by_value = {value: option for option, value in option_values(feature).items()}
        weights = {by_value[value]: weight for value, weight in target.weights.items()}
        if dry_run:
            print(f"  {name}: would change {before} -> {setting}")
            continue
        flag = Flag(name, target.enabled, target.value, "MULTIVARIATE")
        apply_flag_defaults(client, environment, feature["id"], flag, weights, state)
        print(f"  {name}: {before} -> {setting}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--env-file", type=Path, default=Path(__file__).resolve().parents[1] / ".env"
    )
    parser.add_argument(
        "--environment",
        help="Flagsmith environment (default CODEFLOW_SIM_ENVIRONMENT or Development).",
    )
    parser.add_argument("--dry-run", action="store_true", help="Preview using only GET requests.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("show", help="Show each flag's setting.")
    setter = commands.add_parser("set", help="Switch flags, such as ui_buttons=off.")
    setter.add_argument("assignments", nargs="+", metavar="NAME=SETTING")
    commands.add_parser("reset", help="Round 1 state: app_flow split, every ui_* switch flow.")
    args = parser.parse_args()
    try:
        try:
            settings = read_env(args.env_file)
        except FileNotFoundError:
            settings = {}
        configured = os.environ.get(SIM_ENVIRONMENT_SETTING, settings.get(SIM_ENVIRONMENT_SETTING))
        environment = args.environment or configured or DEFAULT_SIM_ENVIRONMENT
        if environment.casefold() == PRODUCTION_ENVIRONMENT.casefold():
            raise SetupError("Rounds run in a simulation environment; Production is refused.")
        if not (admin_key := settings.get("FLAGSMITH_ADMIN_API_KEY")):
            raise SetupError("Set FLAGSMITH_ADMIN_API_KEY in the environment file.")
        client = AdminClient(settings.get("FLAGSMITH_API_URL") or DEFAULT_API_URL, admin_key)
        if args.command == "show":
            show(client, environment)
            return 0
        if args.command == "reset":
            assignments = {
                APP_FLOW_FLAG.name: "split",
                **{name: "flow" for name in UI_SWITCH_NAMES},
            }
        else:
            assignments = parse_assignments(args.assignments)
        if args.dry_run:
            print("Dry run. Only GET requests will be sent.")
            set_flags(client, environment, assignments, dry_run=True)
            return 0
        directory = os.open(Path(__file__).resolve().parent, os.O_RDONLY)
        try:
            fcntl.flock(directory, fcntl.LOCK_EX)
            set_flags(client, environment, assignments, dry_run=False)
        finally:
            os.close(directory)
    except SetupError as error:
        print(f"Flagsmith app_flow switch failed. {error}", file=sys.stderr)
        return 1
    except OSError:
        print(
            "Flagsmith app_flow switch failed. Could not read the environment file.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
