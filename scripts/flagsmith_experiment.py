"""Create, inspect, refresh, or complete code-flow experiments on Flagsmith 2.295.2."""

import argparse
import fcntl
import json
import os
import re
import sys
import time
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path

from flagsmith_setup import (
    APP_FLOW_FLAG,
    DEFAULT_API_URL,
    DEFAULT_SIM_ENVIRONMENT,
    FLOW_DIRECTION_FLAG,
    GITHUB_SIGNIN_FLAG,
    PRODUCTION_ENVIRONMENT,
    PROJECT_NAME,
    SIM_ENVIRONMENT_SETTING,
    UI_SWITCH_NAMES,
    AdminClient,
    AdminError,
    Record,
    SetupError,
    find_record,
    read_env,
    select_environment,
)

MIN_REVIEWERS_PER_VARIANT = 50
MIN_CONVERSIONS_PER_VARIANT = 5
RESULTS_POLL_SECONDS = 2


@dataclass(frozen=True)
class MetricDefinition:
    name: str
    event: str
    aggregation: str
    direction: str
    expected_direction: str


@dataclass(frozen=True)
class ExperimentDefinition:
    name: str
    hypothesis: str
    control: str
    treatments: dict[str, int]
    metrics: tuple[MetricDefinition, ...]

    @property
    def allocations(self) -> dict[str, int]:
        return {self.control: 100 - sum(self.treatments.values()), **self.treatments}


EXPERIMENTS = {
    "flow_view": ExperimentDefinition(
        name="flow_view: overlay vs side by side",
        hypothesis=(
            "Reviewers understand a code change faster and more often in an overlay flow diff "
            "with a one-line summary than in side-by-side diagrams."
        ),
        control="side_by_side",
        treatments={"overlay": 33, "overlay_summary": 33},
        metrics=(
            MetricDefinition("Diff understood", "diff_understood", "occurrence", "up", "increase"),
            MetricDefinition(
                "Diff time to understand (ms)", "diff_understood", "mean", "down", "decrease"
            ),
        ),
    ),
    FLOW_DIRECTION_FLAG.name: ExperimentDefinition(
        name="flow_direction: vertical vs horizontal for long flows",
        hypothesis="Reviewers understand long flows more often and faster in a top-down layout.",
        control=str(FLOW_DIRECTION_FLAG.value),
        treatments={
            str(option.value): int(option.allocation) for option in FLOW_DIRECTION_FLAG.variants
        },
        metrics=(
            MetricDefinition(
                "Layout understood", "layout_understood", "occurrence", "up", "increase"
            ),
            MetricDefinition(
                "Layout time to understand (ms)", "layout_understood", "mean", "down", "decrease"
            ),
        ),
    ),
    GITHUB_SIGNIN_FLAG.name: ExperimentDefinition(
        name="github_signin: sign in with GitHub vs public URL import",
        hypothesis=(
            "More visitors finish an import when they can sign in with GitHub and pick a repo, "
            "including private ones, even though sign-in adds time before the first flow."
        ),
        control=str(GITHUB_SIGNIN_FLAG.value),
        treatments={
            str(option.value): int(option.allocation) for option in GITHUB_SIGNIN_FLAG.variants
        },
        metrics=(
            MetricDefinition(
                "Import completed", "import_completed", "occurrence", "up", "increase"
            ),
            MetricDefinition(
                "Time to first flow (ms)", "first_flow_viewed", "mean", "down", "increase"
            ),
            MetricDefinition(
                "Import abandoned", "import_abandoned", "occurrence", "down", "decrease"
            ),
        ),
    ),
}

# The app_flow rounds: the same journey metrics for the flow experiment (round 1 and the ablation
# rounds) and for each ui_* switch when a stacking round splits it 34/33/33. The first metric is
# the primary one in Flagsmith's dashboard. Metrics with the same name as an earlier experiment's
# (Import completed, Diff understood) are reused, so their definitions must stay identical.
JOURNEY_METRICS = (
    MetricDefinition("Journey completed", "journey_completed", "occurrence", "up", "increase"),
    MetricDefinition("Import completed", "import_completed", "occurrence", "up", "increase"),
    MetricDefinition("Diff understood", "diff_understood", "occurrence", "up", "increase"),
    MetricDefinition("Journey clicks", "journey_clicks", "mean", "down", "decrease"),
    MetricDefinition("Dead clicks", "dead_clicks", "mean", "down", "decrease"),
)
EXPERIMENTS[APP_FLOW_FLAG.name] = ExperimentDefinition(
    name="app_flow: Guided vs Workbench vs Canvas",
    hypothesis=(
        "One of the three end-to-end flows gets more visitors from the landing page through "
        "sign-in, a repo, an understood diff and a second branch than the other two."
    ),
    control=str(APP_FLOW_FLAG.value),
    treatments={str(option.value): int(option.allocation) for option in APP_FLOW_FLAG.variants},
    metrics=JOURNEY_METRICS,
)
for _switch in UI_SWITCH_NAMES:
    # A stacking round serves a 34%, b 33%, c 33% of this one switch with everything else fixed.
    EXPERIMENTS[_switch] = ExperimentDefinition(
        name=f"{_switch}: a vs b vs c",
        hypothesis=(
            f"With every other piece fixed, one version of {_switch.removeprefix('ui_')} gets "
            "more visitors through the whole journey than the other two."
        ),
        control="a",
        treatments={"b": 33, "c": 33},
        metrics=JOURNEY_METRICS,
    )


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


def variant_options(feature: Record, definition: ExperimentDefinition) -> dict[str, Record]:
    options = {option["string_value"]: option for option in feature["multivariate_options"]}
    # A ui_* switch also has an option for its control value (a), which gets 0% in a split.
    extra = options.keys() - definition.treatments.keys()
    if (
        feature["type"] != "MULTIVARIATE"
        or len(options) != len(feature["multivariate_options"])
        or not definition.treatments.keys() <= options.keys()
        or not extra <= {definition.control}
        or any(option["type"] != "unicode" or not option.get("key") for option in options.values())
    ):
        names = ", ".join(definition.treatments)
        raise SetupError(f"{feature['name']} must have these string variants with keys: {names}.")
    return options


def variant_weights(rows: list[Record]) -> dict[int, float]:
    """Option id -> weight, leaving out 0% options (the control's own option on ui_* switches)."""
    return {
        row["multivariate_feature_option"]: row["percentage_allocation"]
        for row in rows
        if row["percentage_allocation"]
    }


def create(
    api: ExperimentAPI,
    environment_path: str,
    feature: Record | None,
    experiment: Record | None,
    definition: ExperimentDefinition,
) -> None:
    experiments_path = f"{environment_path}experiments/"
    if experiment is not None and (state := experiment_state(experiment)) != "created":
        print(f"{definition.name} is already {state}.")
        return

    unused_options: list[int] = []
    if feature is None:
        feature_id = f"<new feature ID for {definition.name.partition(':')[0]}>"
        weights = {
            f"<new option ID for {name}>": weight for name, weight in definition.treatments.items()
        }
    else:
        feature_id = feature["id"]
        options = variant_options(feature, definition)
        weights = {options[name]["id"]: weight for name, weight in definition.treatments.items()}
        unused_options = [
            option["id"] for name, option in options.items() if name not in definition.treatments
        ]

    control_value = {"type": "string", "value": definition.control}
    if experiment is None and feature is not None:
        states = api.list(f"{environment_path}featurestates/?feature={feature_id}")
        if (
            len(states) != 1
            or states[0]["enabled"] is not True
            or states[0]["feature_state_value"] != definition.control
            or variant_weights(states[0]["multivariate_feature_state_values"]) != weights
        ):
            split = "/".join(map(str, definition.allocations.values()))
            raise SetupError(
                f"{feature['name']} must be enabled with a {split} split before creation."
            )
    elif experiment is not None:
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
    for metric_definition in definition.metrics:
        name = metric_definition.name
        body = {
            "name": name,
            "aggregation": metric_definition.aggregation,
            "direction": metric_definition.direction,
            "definition": {"version": 1, "event": metric_definition.event},
        }
        metric = find_record(existing_metrics, "name", name, "metric")
        if metric is not None and any(metric[key] != value for key, value in body.items()):
            raise SetupError(
                f"The existing {name} metric has a different definition or aggregation."
            )
        metric_records.append((metric, body, metric_definition.expected_direction))

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
        split = ", ".join(f"{name} {weight}%" for name, weight in definition.allocations.items())
        print(f"Traffic split: {split}.")
        experiment = api.post(
            experiments_path,
            {
                "feature": feature_id,
                "name": definition.name,
                "hypothesis": definition.hypothesis,
                "metrics": attachments,
                "experiment_rollout": {
                    "enabled": False,  # The start action enables the override, as in the dashboard.
                    "rollout_percentage": 100,
                    "feature_state_value": control_value,
                    "multivariate_feature_state_values": [
                        {"multivariate_feature_option": option_id, "percentage_allocation": weight}
                        for option_id, weight in (
                            *weights.items(),
                            *((option_id, 0) for option_id in unused_options),
                        )
                    ],
                },
            },
        )
    else:
        attached = [(row["metric"], row["expected_direction"]) for row in experiment["metrics"]]
        expected = [(metric["id"], direction) for metric, _, direction in metric_records if metric]
        if len(expected) != len(definition.metrics) or attached != expected:
            raise SetupError("The existing draft has different metrics. Review it before starting.")

    experiment_id = experiment["id"] if experiment is not None else "<new experiment ID>"
    if api.post(f"{experiments_path}{experiment_id}/start/", {}) is not None:
        print(f"Started {definition.name}.")


def rollout(
    api: ExperimentAPI,
    path: str,
    feature: Record,
    experiment: Record,
    variant: str,
    definition: ExperimentDefinition,
) -> None:
    body: Record = {"rollout_decision": "control"}
    if variant != definition.control:
        body = {
            "rollout_decision": "variant",
            "rollout_variant": variant_options(feature, definition)[variant]["id"],
        }

    state = experiment_state(experiment)
    if state == "completed":
        if all(experiment[key] == value for key, value in body.items()):
            print(f"Already completed with {variant} at 100% as the environment default.")
            return
        raise SetupError("The experiment was already completed with a different rollout decision.")
    if state == "created":
        raise SetupError("The experiment must be running or paused before selecting a winner.")

    api.post(f"{path}complete/", body)
    verb = "Would complete" if api.dry_run else "Completed"
    print(f"{verb} {definition.name} with {variant} at 100% as the environment default.")


def print_table(headers: tuple[str, ...], rows: list[tuple[str, ...]]) -> None:
    widths = [max(map(len, column)) for column in zip(headers, *rows, strict=True)]
    for row in (headers, *rows):
        print(
            "  ".join(cell.ljust(width) for cell, width in zip(row, widths, strict=True)).rstrip()
        )


def print_inference_minimum(minimum: int, unit: str, counts: dict[str, int | float]) -> None:
    current = ", ".join(f"{label} {count:,.0f}" for label, count in counts.items())
    print(
        f"Flagsmith needs >= {minimum} {unit} per variant to compute lift, credible intervals, "
        f"and win probability. Current counts are {current}."
    )


def explain_missing_inference(
    stats: dict[str, Record], missing_treatments: list[str], occurrence: bool, control: str
) -> None:
    if not missing_treatments:
        return

    # Flagsmith checks the control and treatment separately for each comparison.
    compared = [stats[label] for label in (control, *missing_treatments)]
    needs_reviewers = any(variant["n"] < MIN_REVIEWERS_PER_VARIANT for variant in compared)
    needs_conversions = occurrence and any(
        variant["sum"] < MIN_CONVERSIONS_PER_VARIANT for variant in compared
    )
    if needs_reviewers:
        print_inference_minimum(
            MIN_REVIEWERS_PER_VARIANT,
            "reviewers",
            {label: row["n"] for label, row in stats.items()},
        )
    if needs_conversions:
        print_inference_minimum(
            MIN_CONVERSIONS_PER_VARIANT,
            "conversions",
            {label: row["sum"] for label, row in stats.items()},
        )
    if not (needs_reviewers or needs_conversions):
        if stats[control]["sum"] <= 0:
            print("Flagsmith needs a positive control mean to compute relative lift.")
        else:
            print(
                "Flagsmith returned no lift, credible interval, or win probability for some variants."
            )


def show_metric(
    name: str, aggregation: str, result: Record, variants: dict[str, str], control: str
) -> None:
    occurrence = aggregation == "occurrence"
    print(f"\n{name}")
    stats_by_variant = {
        label: result["variants"].get(key, {"n": 0, "sum": 0}) for label, key in variants.items()
    }
    rows = []
    missing_treatments = []
    for label, key in variants.items():
        stats = stats_by_variant[label]
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
        elif label != control:
            missing_treatments.append(label)
        display_name = f"{label} (control)" if label == control else label
        rows.append((display_name, f"{exposures:,}", outcome, lift, interval, win))
    unit = "ms " if "(ms)" in name else ""
    outcome_title = "Conversions / rate" if occurrence else f"Mean {unit}/ exposure"
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
    explain_missing_inference(stats_by_variant, missing_treatments, occurrence, control)


def computation_is_current(computation: Record | None) -> bool:
    if not computation or not computation.get("payload"):
        return False
    if computation.get("is_final") or not (requested_at := computation.get("refresh_requested_at")):
        return True
    as_of = computation.get("as_of")
    return bool(as_of and datetime.fromisoformat(as_of) >= datetime.fromisoformat(requested_at))


def read_computation(
    api: ExperimentAPI, path: str, name: str, wait_seconds: int = 0
) -> Record | None:
    deadline = time.monotonic() + wait_seconds if wait_seconds else 0
    try:
        while True:
            computation = api.get(f"{path}{name}/")[name]
            if not wait_seconds or computation_is_current(computation):
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                print(f"Timed out after {wait_seconds}s waiting for refreshed {name}.")
                break
            time.sleep(min(RESULTS_POLL_SECONDS, remaining))
    except AdminError as error:
        if error.status not in (404, 405):
            raise
        print(f"The {name} endpoint returned HTTP {error.status}.")
        return None
    if computation and computation.get("last_error_at"):
        print(f"The most recent {name} refresh failed.")
    return computation["payload"] if computation else None


def status(
    api: ExperimentAPI,
    path: str,
    feature: Record,
    experiment: Record,
    definition: ExperimentDefinition,
    wait_seconds: int = 0,
) -> None:
    print(f"{definition.name} is {experiment_state(experiment)}.")
    variants = {definition.control: "control"}
    options = variant_options(feature, definition)
    variants.update({name: options[name]["key"] for name in definition.treatments})
    results = read_computation(api, path, "results", wait_seconds)
    if results:
        by_id = {metric["metric_id"]: metric for metric in results["metrics"]}
        by_name = {row["metric_name"]: row["metric"] for row in experiment["metrics"]}
        displayed = False
        for metric in definition.metrics:
            if metric_result := by_id.get(by_name.get(metric.name)):
                show_metric(
                    metric.name, metric.aggregation, metric_result, variants, definition.control
                )
                displayed = True
        if displayed:
            return

    print("No cached results for the code-flow metrics. Run refresh after traffic arrives.")
    if exposures := read_computation(api, path, "exposures"):
        points = exposures["timeseries"]["points"]
        counts = {
            label: sum(point["new_identities"].get(key, 0) for point in points)
            for label, key in variants.items()
        }
        rows = [
            (f"{label} (control)" if label == definition.control else label, f"{count:,}")
            for label, count in counts.items()
        ]
        print_table(("Variant", "Exposures"), rows)
        if any(count < MIN_REVIEWERS_PER_VARIANT for count in counts.values()):
            print_inference_minimum(MIN_REVIEWERS_PER_VARIANT, "reviewers", counts)


def refresh(api: ExperimentAPI, path: str) -> None:
    for name in ("exposures", "results"):
        try:
            api.post(f"{path}{name}/refresh/", {})
        except AdminError as error:
            if error.status != 429:
                raise
            print(f"Flagsmith allows one {name} refresh every 5 minutes. Try again shortly.")
        else:
            if not api.dry_run:
                print(f"Requested {name} refresh.")


def run(
    api: ExperimentAPI,
    command: str,
    variant: str | None = None,
    *,
    environment_name: str = DEFAULT_SIM_ENVIRONMENT,
    experiment_flag: str = "flow_view",
    wait_seconds: int = 0,
    round_label: str | None = None,
) -> None:
    definition = EXPERIMENTS[experiment_flag]
    if round_label:
        # Each app_flow round is its own experiment on the same flag, named after the round.
        definition = replace(definition, name=f"{definition.name} [{round_label}]")
    organisations = api.list("organisations/")
    if len(organisations) != 1:
        raise SetupError("The admin API key must identify exactly one Flagsmith organisation.")
    projects = api.list(f"projects/?organisation={organisations[0]['id']}")
    project = find_record(projects, "name", PROJECT_NAME, "project")
    if project is None:
        raise SetupError("The code-flow project was not found.")
    project_path = f"projects/{project['id']}/"
    environment = select_environment(api.list(f"{project_path}environments/"), environment_name)
    environment_path = f"environments/{environment['api_key']}/"

    experiments = api.list(f"{environment_path}experiments/?q={experiment_flag}")
    experiment = find_record(experiments, "name", definition.name, "experiment")
    if experiment is None and command != "create":
        message = f"No experiment named {definition.name} exists."
        if command in ("refresh", "rollout"):
            raise SetupError(message)
        print(message)
        return

    features = api.list(f"{project_path}features/?search={experiment_flag}")
    feature = find_record(features, "name", experiment_flag, "feature")
    if feature is None:
        if (
            api.dry_run
            and command == "create"
            and experiment is None
            and experiment_flag == FLOW_DIRECTION_FLAG.name
        ):
            print(f"Prerequisite: setup must create {experiment_flag} before these requests.")
            create(api, environment_path, None, None, definition)
            return
        raise SetupError(f"The experiment requires the {experiment_flag} feature in code-flow.")
    if experiment is not None and experiment["feature"]["id"] != feature["id"]:
        raise SetupError("The existing experiment is attached to a different feature.")
    if command == "create":
        if experiment is None and any(
            other["feature"]["id"] == feature["id"] and experiment_state(other) != "completed"
            for other in experiments
        ):
            raise SetupError(
                f"{experiment_flag} already has a different active experiment in this environment."
            )
        create(api, environment_path, feature, experiment, definition)
    elif experiment is not None:
        path = f"{environment_path}experiments/{experiment['id']}/"
        if command == "refresh":
            refresh(api, path)
            if wait_seconds and not api.dry_run:
                status(api, path, feature, experiment, definition, wait_seconds)
        elif variant is not None:
            rollout(api, path, feature, experiment, variant, definition)
        else:
            status(api, path, feature, experiment, definition)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env-file", type=Path, default=Path(__file__).resolve().parents[1] / ".env"
    )
    parser.add_argument("--dry-run", action="store_true", help="Preview using only GET requests.")
    parser.add_argument(
        "--environment",
        help="Flagsmith environment (default CODEFLOW_SIM_ENVIRONMENT or Development).",
    )
    parser.add_argument(
        "--experiment",
        choices=EXPERIMENTS,
        default="flow_view",
        help="Experiment flag (default flow_view).",
    )
    parser.add_argument(
        "--round",
        dest="round_label",
        metavar="LABEL",
        help="Name a repeat experiment on the same flag, such as 'round 2' (app_flow rounds).",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("create", "Create the metrics and start the experiment."),
        ("status", "Show the state and cached results."),
        ("refresh", "Request a refresh of experiment exposures and results."),
        ("rollout", "Complete the experiment and apply a winner."),
    ):
        subcommand = commands.add_parser(name, help=help_text)
        subcommand.add_argument("--dry-run", action="store_true", default=argparse.SUPPRESS)
        subcommand.add_argument("--environment", default=argparse.SUPPRESS)
        subcommand.add_argument("--experiment", choices=EXPERIMENTS, default=argparse.SUPPRESS)
        subcommand.add_argument(
            "--round", dest="round_label", metavar="LABEL", default=argparse.SUPPRESS
        )
        if name == "rollout":
            subcommand.add_argument("--variant", required=True)
        if name == "refresh":
            subcommand.add_argument(
                "--wait", type=int, default=0, metavar="SECONDS", help="Wait for refreshed results."
            )
    args = parser.parse_args()
    wait_seconds = getattr(args, "wait", 0)
    if wait_seconds < 0:
        parser.error("--wait must be zero or more seconds.")
    variant = getattr(args, "variant", None)
    if variant is not None and variant not in EXPERIMENTS[args.experiment].allocations:
        choices = ", ".join(EXPERIMENTS[args.experiment].allocations)
        parser.error(f"--variant for {args.experiment} must be one of {choices}.")
    try:
        try:
            settings = read_env(args.env_file)
        except FileNotFoundError:
            settings = {}
        configured = os.environ.get(SIM_ENVIRONMENT_SETTING, settings.get(SIM_ENVIRONMENT_SETTING))
        environment = (
            args.environment
            if args.environment is not None
            else configured or DEFAULT_SIM_ENVIRONMENT
        )
        print(f"Using Flagsmith environment {PROJECT_NAME}/{environment}.", flush=True)
        if (
            environment.casefold() == PRODUCTION_ENVIRONMENT.casefold()
            and args.environment != PRODUCTION_ENVIRONMENT
            and args.command != "status"
            and not args.dry_run
        ):
            raise SetupError("Production writes require an explicit --environment Production.")
        if not (admin_key := settings.get("FLAGSMITH_ADMIN_API_KEY")):
            raise SetupError("Set FLAGSMITH_ADMIN_API_KEY in the environment file.")
        options = {
            "environment_name": environment,
            "experiment_flag": args.experiment,
            "wait_seconds": wait_seconds,
            "round_label": (args.round_label or "").strip() or None,
        }
        client = AdminClient(settings.get("FLAGSMITH_API_URL") or DEFAULT_API_URL, admin_key)
        api = ExperimentAPI(client, args.dry_run)
        if args.dry_run or args.command == "status":
            if args.dry_run:
                print("Dry run. Only GET requests will be sent.")
            run(api, args.command, variant, **options)
        else:
            # Serialize writers in this checkout. Flagsmith permits duplicate metric names.
            directory = os.open(Path(__file__).resolve().parent, os.O_RDONLY)
            try:
                fcntl.flock(directory, fcntl.LOCK_EX)
                run(api, args.command, variant, **options)
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
