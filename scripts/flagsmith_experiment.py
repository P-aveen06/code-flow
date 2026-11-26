"""Create, inspect, or complete the code-flow experiment on Flagsmith 2.295.2."""

import argparse
import fcntl
import json
import os
import re
import sys
from pathlib import Path

from flagsmith_setup import (
    DEFAULT_API_URL,
    PROJECT_NAME,
    AdminClient,
    AdminError,
    Record,
    SetupError,
    find_record,
    read_env,
    select_environment,
)

ENVIRONMENT_NAME = "Production"
FEATURE_NAME = "flow_view"
EXPERIMENT_NAME = "flow_view: overlay vs side by side"
HYPOTHESIS = (
    "Reviewers understand a code change faster and more often in an overlay flow diff "
    "with a one-line summary than in side-by-side diagrams."
)
CONTROL = "side_by_side"
TREATMENTS = ("overlay", "overlay_summary")
METRICS = (
    ("Diff understood", "occurrence", "up", "increase"),
    ("Diff time to understand (ms)", "mean", "down", "decrease"),
)
EVENT = {"version": 1, "event": "diff_understood"}


class ExperimentAPI:
    """Preview known requests without exposing the environment key in their paths."""

    def __init__(self, client: AdminClient, dry_run: bool):
        self.client = client
        self.dry_run = dry_run

    def preview(self, method: str, path: str, body: Record | None = None) -> None:
        if self.dry_run:
            safe_path = re.sub(r"^environments/[^/]+/", "environments/<environment-key>/", path)
            print(f"{method} {safe_path}" + (f" {json.dumps(body)}" if body is not None else ""))

    def list(self, path: str) -> list[Record]:
        self.preview("GET", path)
        return self.client.list(path)

    def get(self, path: str) -> Record:
        self.preview("GET", path)
        return self.client.request("GET", path)

    def post(self, path: str, body: Record) -> Record | None:
        self.preview("POST", path, body)
        if not self.dry_run:
            return self.client.request("POST", path, body)
        return None


def experiment_state(experiment: Record) -> str:
    state = experiment["status"]
    if state not in ("created", "running", "paused", "completed"):
        raise SetupError("Flagsmith returned an unknown experiment state.")
    return state


def variant_options(feature: Record) -> dict[str, Record]:
    options = {option["string_value"]: option for option in feature["multivariate_options"]}
    if (
        feature["type"] != "MULTIVARIATE"
        or len(feature["multivariate_options"]) != len(TREATMENTS)
        or set(options) != set(TREATMENTS)
        or any(option["type"] != "unicode" or not option.get("key") for option in options.values())
    ):
        raise SetupError("flow_view must have the two named string variants with experiment keys.")
    return options


def variant_weights(rows: list[Record]) -> dict[int, float]:
    return {row["multivariate_feature_option"]: row["percentage_allocation"] for row in rows}


def create(
    api: ExperimentAPI,
    environment_path: str,
    feature: Record,
    experiments: list[Record],
    experiment: Record | None,
) -> None:
    experiments_path = f"{environment_path}experiments/"
    if experiment is not None and (state := experiment_state(experiment)) != "created":
        print(f"{EXPERIMENT_NAME} is already {state}.")
        return
    if experiment is None and any(
        other["feature"]["id"] == feature["id"] and experiment_state(other) != "completed"
        for other in experiments
    ):
        raise SetupError("flow_view already has a different active experiment in Production.")

    options = variant_options(feature)
    weights = {options[name]["id"]: 33 for name in TREATMENTS}
    control_value = {"type": "string", "value": CONTROL}
    if experiment is None:
        states = api.list(f"{environment_path}featurestates/?feature={feature['id']}")
        if (
            len(states) != 1
            or states[0]["enabled"] is not True
            or states[0]["feature_state_value"] != CONTROL
            or variant_weights(states[0]["multivariate_feature_state_values"]) != weights
        ):
            raise SetupError(
                "Production flow_view must be enabled with a 34/33/33 split before creation."
            )
    else:
        detail = api.get(f"{experiments_path}{experiment['id']}/")
        existing_rollout = detail["experiment_rollout"]
        if (
            not existing_rollout
            or existing_rollout["rollout_percentage"] != 100
            or existing_rollout["feature_state_value"] != control_value
            or existing_rollout["audience"]["segments"]
            or variant_weights(existing_rollout["multivariate_feature_state_values"]) != weights
        ):
            raise SetupError(
                "The existing draft has a different rollout. Review it before starting."
            )

    metric_path = f"{environment_path}experiment-metrics/"
    existing_metrics = api.list(metric_path)
    metric_records = []
    for name, aggregation, direction, expected in METRICS:
        body = {
            "name": name,
            "aggregation": aggregation,
            "direction": direction,
            "definition": EVENT,
        }
        metric = find_record(existing_metrics, "name", name, "metric")
        if metric is not None and any(metric[key] != value for key, value in body.items()):
            raise SetupError(
                f"The existing {name} metric has a different definition or aggregation."
            )
        metric_records.append((metric, body, expected))

    if experiment is None:
        attachments = []
        # Flagsmith's dashboard treats metrics[0] as primary. There is no primary field.
        for metric, body, expected in metric_records:
            if metric is None:
                metric = api.post(metric_path, body)
                if metric is not None:
                    print(f"Created metric {body['name']}.")
            metric_id = (
                metric["id"] if metric is not None else f"<new metric ID for {body['name']}>"
            )
            attachments.append({"metric": metric_id, "expected_direction": expected})
        print("Traffic split: side_by_side 34%, overlay 33%, overlay_summary 33%.")
        experiment = api.post(
            experiments_path,
            {
                "feature": feature["id"],
                "name": EXPERIMENT_NAME,
                "hypothesis": HYPOTHESIS,
                "metrics": attachments,
                "experiment_rollout": {
                    "enabled": False,  # The start action enables the override, as in the dashboard.
                    "rollout_percentage": 100,
                    "feature_state_value": control_value,
                    "multivariate_feature_state_values": [
                        {"multivariate_feature_option": option_id, "percentage_allocation": weight}
                        for option_id, weight in weights.items()
                    ],
                },
            },
        )
    else:
        attached = [(row["metric"], row["expected_direction"]) for row in experiment["metrics"]]
        expected = [(metric["id"], direction) for metric, _, direction in metric_records if metric]
        if len(expected) != len(METRICS) or attached != expected:
            raise SetupError("The existing draft has different metrics. Review it before starting.")

    experiment_id = experiment["id"] if experiment is not None else "<new experiment ID>"
    if api.post(f"{experiments_path}{experiment_id}/start/", {}) is not None:
        print(f"Started {EXPERIMENT_NAME}.")


def rollout(
    api: ExperimentAPI, path: str, feature: Record, experiment: Record, variant: str
) -> None:
    body: Record = {"rollout_decision": "control"}
    if variant != CONTROL:
        body = {
            "rollout_decision": "variant",
            "rollout_variant": variant_options(feature)[variant]["id"],
        }

    state = experiment_state(experiment)
    if state == "completed":
        if all(experiment[key] == value for key, value in body.items()):
            print(
                f"Already completed with {variant} at 100% in the Production environment default."
            )
            return
        raise SetupError("The experiment was already completed with a different rollout decision.")
    if state == "created":
        raise SetupError("The experiment must be running or paused before selecting a winner.")

    api.post(f"{path}complete/", body)
    verb = "Would complete" if api.dry_run else "Completed"
    print(f"{verb} {EXPERIMENT_NAME} with {variant} at 100% in the Production environment default.")


def print_table(headers: tuple[str, ...], rows: list[tuple[str, ...]]) -> None:
    widths = [max(map(len, column)) for column in zip(headers, *rows, strict=True)]
    for row in (headers, *rows):
        print(
            "  ".join(cell.ljust(width) for cell, width in zip(row, widths, strict=True)).rstrip()
        )


def show_metric(name: str, aggregation: str, result: Record, variants: dict[str, str]) -> None:
    occurrence = aggregation == "occurrence"
    print(f"\n{name}")
    rows = []
    for label, key in variants.items():
        stats = result["variants"].get(key, {"n": 0, "sum": 0})
        exposures, total = stats["n"], stats["sum"]
        if occurrence:
            outcome = f"{total:,.0f} / {total / exposures:.1%}" if exposures else "0 / —"
        else:
            outcome = f"{total / exposures:,.1f}" if exposures else "—"
        lift, interval, win = "—", "—", "—"
        if inference := result["inference"].get(key):
            lift = f"{inference['lift']:+.1%}"
            interval = f"[{inference['ci_low']:+.1%}, {inference['ci_high']:+.1%}]"
            win = f"{inference['chance_to_win']:.1%}"
        rows.append((label, f"{exposures:,}", outcome, lift, interval, win))
    outcome_title = "Conversions / rate" if occurrence else "Mean ms / exposure"
    print_table(
        (
            "Variant",
            "Exposures",
            outcome_title,
            "Lift vs control",
            "95% credible interval",
            "Win probability",
        ),
        rows,
    )


def read_computation(api: ExperimentAPI, path: str, name: str) -> Record | None:
    try:
        computation = api.get(f"{path}{name}/")[name]
    except AdminError as error:
        if error.status not in (404, 405):
            raise
        print(f"The {name} endpoint returned HTTP {error.status}.")
        return None
    if computation and computation.get("last_error_at"):
        print(f"The most recent {name} refresh failed.")
    return computation["payload"] if computation else None


def status(api: ExperimentAPI, path: str, feature: Record, experiment: Record) -> None:
    print(f"{EXPERIMENT_NAME} is {experiment_state(experiment)}.")
    variants = {f"{CONTROL} (control)": "control"}
    variants.update({name: option["key"] for name, option in variant_options(feature).items()})
    results = read_computation(api, path, "results")
    if results:
        by_id = {metric["metric_id"]: metric for metric in results["metrics"]}
        by_name = {row["metric_name"]: row["metric"] for row in experiment["metrics"]}
        displayed = False
        for name, aggregation, _, _ in METRICS:
            if metric_result := by_id.get(by_name.get(name)):
                show_metric(name, aggregation, metric_result, variants)
                displayed = True
        if displayed:
            return

    print(
        "No cached results for the code-flow metrics. Use Refresh in the Flagsmith dashboard after traffic arrives."
    )
    if exposures := read_computation(api, path, "exposures"):
        points = exposures["timeseries"]["points"]
        rows = [
            (label, f"{sum(point['new_identities'].get(key, 0) for point in points):,}")
            for label, key in variants.items()
        ]
        print_table(("Variant", "Exposures"), rows)


def run(api: ExperimentAPI, command: str, variant: str | None = None) -> None:
    organisations = api.list("organisations/")
    if len(organisations) != 1:
        raise SetupError("The admin API key must identify exactly one Flagsmith organisation.")
    projects = api.list(f"projects/?organisation={organisations[0]['id']}")
    project = find_record(projects, "name", PROJECT_NAME, "project")
    if project is None:
        raise SetupError("The code-flow project was not found.")
    project_path = f"projects/{project['id']}/"
    environment = select_environment(api.list(f"{project_path}environments/"), ENVIRONMENT_NAME)
    environment_path = f"environments/{environment['api_key']}/"
    print(f"Using Flagsmith environment {PROJECT_NAME}/{ENVIRONMENT_NAME}.")

    experiments = api.list(f"{environment_path}experiments/?q={FEATURE_NAME}")
    experiment = find_record(experiments, "name", EXPERIMENT_NAME, "experiment")
    if experiment is None and command != "create":
        if command == "rollout":
            raise SetupError(f"No experiment named {EXPERIMENT_NAME} exists.")
        print(f"No experiment named {EXPERIMENT_NAME} exists.")
        return

    features = api.list(f"{project_path}features/?search={FEATURE_NAME}")
    feature = find_record(features, "name", FEATURE_NAME, "feature")
    if feature is None or (experiment is not None and experiment["feature"]["id"] != feature["id"]):
        raise SetupError("The experiment requires the flow_view feature in code-flow.")
    if command == "create":
        create(api, environment_path, feature, experiments, experiment)
    elif experiment is not None:
        path = f"{environment_path}experiments/{experiment['id']}/"
        if variant is not None:
            rollout(api, path, feature, experiment, variant)
        else:
            status(api, path, feature, experiment)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env-file", type=Path, default=Path(__file__).resolve().parents[1] / ".env"
    )
    parser.add_argument("--dry-run", action="store_true", help="Preview using only GET requests.")
    commands = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("create", "Create the metrics and start the experiment."),
        ("status", "Show the state and cached results."),
        ("rollout", "Complete the experiment and apply a winner."),
    ):
        subcommand = commands.add_parser(name, help=help_text)
        subcommand.add_argument("--dry-run", action="store_true", default=argparse.SUPPRESS)
        if name == "rollout":
            subcommand.add_argument("--variant", choices=(CONTROL, *TREATMENTS), required=True)
    args = parser.parse_args()

    try:
        settings = read_env(args.env_file)
        if not (admin_key := settings.get("FLAGSMITH_ADMIN_API_KEY")):
            raise SetupError("Set FLAGSMITH_ADMIN_API_KEY in the environment file.")
        client = AdminClient(settings.get("FLAGSMITH_API_URL") or DEFAULT_API_URL, admin_key)
        api = ExperimentAPI(client, args.dry_run)
        variant = getattr(args, "variant", None)
        if args.dry_run or args.command == "status":
            if args.dry_run:
                print("Dry run. Only GET requests will be sent.")
            run(api, args.command, variant)
        else:
            # Serialize writers in this checkout. Flagsmith permits duplicate metric names.
            directory = os.open(Path(__file__).resolve().parent, os.O_RDONLY)
            try:
                fcntl.flock(directory, fcntl.LOCK_EX)
                run(api, args.command, variant)
            finally:
                os.close(directory)
    except SetupError as error:
        print(f"Flagsmith experiment failed. {error}", file=sys.stderr)
        return 1
    except OSError:
        print(
            "Flagsmith experiment failed. Could not read the environment file or lock scripts.",
            file=sys.stderr,
        )
        return 1
    except (AttributeError, KeyError, TypeError, ValueError):
        print(
            "Flagsmith experiment failed. The Admin API URL or response was invalid.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
