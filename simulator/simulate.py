"""Simulate reviewer traffic for a configured Flagsmith experiment."""

import argparse
import math
import sys
from pathlib import Path

from codeflow.diff import LONG_FLOW_MIN_DEPTH
from flagsmith.exceptions import FlagsmithClientError, FlagsmithFeatureDoesNotExistError

from clients import DEFAULT_API_URL, DryRunClient, ExperimentClient, flagsmith_client
from config import (
    DEFAULT_SIM_ENVIRONMENT,
    PRODUCTION_ENVIRONMENT,
    PRODUCTION_KEY,
    SIMULATION_KEY,
    name_value,
    named_path,
    read_settings,
)
from diffs import load_diffs
from experiments import Experiment, load_experiment
from funnels import (
    FunnelExperiment,
    FunnelSummary,
    funnel_events,
    is_funnel,
    load_funnel,
    run_funnel,
)
from history import reserve_reviewers
from model import MODELS
from panels import EXPERIENCE_BANDS, Panel, generate_panel, load_panel, profile_counts, select_panel
from personas import PersonaModel, load_personas
from runner import SimulationError, VariantSummary, run_simulation

SIMULATOR_DIR = Path(__file__).resolve().parent
REPO_ROOT = SIMULATOR_DIR.parent
EXPERIMENTS_DIR = SIMULATOR_DIR / "experiments"
PANELS_DIR = SIMULATOR_DIR / "panels"


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--experiment", default="flow_view", help="experiment name (default flow_view)"
    )
    parser.add_argument(
        "--environment",
        help="Flagsmith environment (default CODEFLOW_SIM_ENVIRONMENT or Development)",
    )
    parser.add_argument(
        "--panel", default="default", help="panel name or generated (default default)"
    )
    parser.add_argument("--limit", type=int, help="maximum number of selected reviewers")
    parser.add_argument(
        "--offset", type=int, default=0, help="skip reviewers at the start of the panel"
    )
    parser.add_argument("--profiles", action="store_true", help="print panel profiles offline")
    parser.add_argument("--n", type=int, help="generated panel size (default 1000)")
    parser.add_argument("--prefix", help="generated identity prefix (default sim-reviewer)")
    parser.add_argument(
        "--rate", type=float, default=20, help="live reviewers per second (default 20)"
    )
    parser.add_argument("--seed", type=int, default=7, help="sampling seed (default 7)")
    parser.add_argument("--model", choices=MODELS, default="hypothesis")
    parser.add_argument("--dry-run", action="store_true", help="assign and record events offline")
    parser.add_argument(
        "--allow-repeat",
        action="store_true",
        help="allow repeat events on the same flag in the same environment",
    )
    parser.add_argument(
        "--persona-summary", action="store_true", help="show simulated persona counts by variant"
    )
    args = parser.parse_args(argv)
    if args.panel != "generated" and (args.n is not None or args.prefix is not None):
        parser.error("--n and --prefix require --panel generated")
    if args.n is not None and args.n < 1:
        parser.error("--n must be positive")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    if args.offset < 0:
        parser.error("--offset must be nonnegative")
    if not math.isfinite(args.rate) or args.rate <= 0:
        parser.error("--rate must be positive and finite")
    if args.prefix is not None and (not args.prefix or args.prefix != args.prefix.strip()):
        parser.error("--prefix must be nonempty without surrounding whitespace")
    return args


def _print_summary(
    summary: dict[str, VariantSummary],
    model: str,
    source: str,
    commit_count: int,
    dry_run: bool,
    experiment: Experiment,
) -> None:
    mode = "dry run" if dry_run else "Flagsmith"
    print(f"Simulated reviewers ({model} model, {mode})")
    print(f"Experiment flag {experiment.flag} (control {experiment.control}).")
    eligible = (
        f"long-flow commits (depth >= {LONG_FLOW_MIN_DEPTH} at one hop)"
        if experiment.long_flows_only
        else "flow-changing commits"
    )
    print(f"Diffs sampled from {commit_count} {eligible} in {source}.")
    width = max(len("Variant"), *(len(variant) for variant in summary))
    print(f"{'Variant':<{width}} {'Reviewers':>9} {'Success rate':>15} {'Median ms':>12}")
    for variant, stats in summary.items():
        success = f"{stats.success_rate:.1%}" if stats.success_rate is not None else "-"
        elapsed = f"{stats.median_ms:,.0f}" if stats.median_ms is not None else "-"
        print(f"{variant:<{width}} {stats.reviewers:>9} {success:>15} {elapsed:>12}")


def _print_funnel_summary(
    summary: dict[str, FunnelSummary], model: str, dry_run: bool, experiment: FunnelExperiment
) -> None:
    mode = "dry run" if dry_run else "Flagsmith"
    print(f"Simulated visitors ({model} model, {mode})")
    print(f"Experiment flag {experiment.flag} (control {experiment.control}).")
    width = max(len("Variant"), *(len(variant) for variant in summary))
    print(f"{'Variant':<{width}} {'Visitors':>9} {'Completed':>10} {'Median ms to flow':>18}")
    for variant, stats in summary.items():
        rate = f"{stats.completion_rate:.1%}" if stats.completion_rate is not None else "-"
        elapsed = f"{stats.median_ms:,.0f}" if stats.median_ms is not None else "-"
        print(f"{variant:<{width}} {stats.reviewers:>9} {rate:>10} {elapsed:>18}")

    print("\nVisitors reaching each event")
    events = funnel_events(experiment)
    width = max(len("Event"), *(len(event) for event in events))
    print(f"{'Event':<{width}}" + "".join(f" {variant:>16}" for variant in summary))
    for event in events:
        print(
            f"{event:<{width}}" + "".join(f" {s.event_counts[event]:>16}" for s in summary.values())
        )


def _print_persona_summary(
    summary: dict[str, VariantSummary] | dict[str, FunnelSummary], personas: PersonaModel
) -> None:
    print("\nSimulated persona counts")
    print(f"{'Attribute':<22} {'Value':<20}" + "".join(f" {variant:>16}" for variant in summary))
    for attribute, values in (
        ("role", personas.roles),
        ("codebase_familiarity", personas.familiarity),
        ("reading_style", personas.reading_styles),
    ):
        for value in values:
            counts = "".join(
                f" {stats.persona_counts[attribute][value]:>16}" for stats in summary.values()
            )
            print(f"{attribute:<22} {value:<20}{counts}")


def _print_profiles(name: str, reviewers: Panel, personas: PersonaModel) -> None:
    print(f"Reviewer panel {name} ({len(reviewers):,} reviewers)")
    print(f"{'Attribute':<22} {'Value':<20} {'Reviewers':>9}")
    counts = profile_counts(reviewers)
    for attribute, values in (
        ("role", personas.roles),
        ("experience_years", [label for label, _ in EXPERIENCE_BANDS]),
        ("codebase_familiarity", personas.familiarity),
        ("reading_style", personas.reading_styles),
    ):
        for value in values:
            print(f"{attribute:<22} {value:<20} {counts[attribute][value]:>9,}")


def _check_repeats(flag: str, count: int, *, confirmed: bool, allow_repeat: bool) -> None:
    if not count:
        return
    counted = "already counted" if confirmed else "may already have counted"
    message = (
        f"Warning: Flagsmith {counted} {count:,} of the selected reviewers for {flag}. "
        "Re-sending events for the same reviewers on the same flag can double-count them."
    )
    if not allow_repeat:
        raise SimulationError(f"{message} Pass --allow-repeat to continue.")
    print(message, file=sys.stderr)


def _simulation_target(requested: str | None, *, dry_run: bool) -> tuple[str, str, str]:
    production = requested == PRODUCTION_ENVIRONMENT
    key_name = PRODUCTION_KEY if production else SIMULATION_KEY
    names = ("CODEFLOW_SIM_ENVIRONMENT",)
    if not dry_run:
        names += ("FLAGSMITH_API_URL", key_name)
    settings = read_settings(REPO_ROOT / ".env", *names)
    configured = settings.get("CODEFLOW_SIM_ENVIRONMENT") or DEFAULT_SIM_ENVIRONMENT
    environment = name_value(
        configured if requested is None else requested, "Flagsmith environment"
    )
    print(f"Using Flagsmith environment code-flow/{environment}.", flush=True)
    if environment.casefold() == PRODUCTION_ENVIRONMENT.casefold() and not production:
        raise SimulationError("Targeting Production requires an explicit --environment Production.")
    if dry_run:
        return environment, "", ""
    if production:
        print(
            "Warning: simulated users will go into the Production real-reviewer environment.",
            file=sys.stderr,
        )
    elif environment != configured:
        raise SimulationError(
            "The requested environment must match CODEFLOW_SIM_ENVIRONMENT to use its key."
        )
    key = settings.get(key_name, "")
    if not key:
        message = f"Set {key_name} to the client-side environment key."
        if not production:
            message += (
                " Run python3 scripts/flagsmith_setup.py --environment Development "
                "from the repo root to set up the default simulation environment."
            )
        raise SimulationError(message)
    return environment, settings.get("FLAGSMITH_API_URL") or DEFAULT_API_URL, key


def _live_client(
    api_url: str,
    key: str,
    environment: str,
    flag: str,
    identities: set[str],
    *,
    allow_repeat: bool,
) -> ExperimentClient:
    client = flagsmith_client(api_url, key)
    try:
        repeats = reserve_reviewers(
            REPO_ROOT / "data" / "simulator-runs.sqlite3",
            environment,
            flag,
            identities,
            allow_repeat=allow_repeat,
        )
        _check_repeats(flag, repeats, confirmed=False, allow_repeat=allow_repeat)
    except BaseException:
        client.close()
        raise
    return client


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        personas = load_personas(SIMULATOR_DIR / "personas.yaml")
        if args.panel == "generated":
            panel = generate_panel(
                personas, n=args.n or 1000, prefix=args.prefix or "sim-reviewer", seed=args.seed
            )
        else:
            panel = load_panel(args.panel, personas, PANELS_DIR)
        reviewers = select_panel(panel, offset=args.offset, limit=args.limit)
        if args.profiles:
            _print_profiles(args.panel, reviewers, personas)
            return 0

        path = named_path(EXPERIMENTS_DIR, args.experiment, ".yaml")
        funnel = load_funnel(path, personas) if is_funnel(path) else None
        experiment = funnel or load_experiment(path, personas)
        environment, api_url, key = _simulation_target(args.environment, dry_run=args.dry_run)
        if funnel is None:
            source, diffs = load_diffs(
                REPO_ROOT / "data", long_flows_only=experiment.long_flows_only
            )

        known_repeats = set()
        if (
            not args.dry_run
            and environment == PRODUCTION_ENVIRONMENT
            and experiment.flag in ("flow_view", "flow_direction")
        ):
            # Both published Production runs counted the entire default panel.
            published_panel = (
                panel if args.panel == "default" else load_panel("default", personas, PANELS_DIR)
            )
            known_repeats = reviewers.keys() & published_panel.keys()
            _check_repeats(
                experiment.flag, len(known_repeats), confirmed=True, allow_repeat=args.allow_repeat
            )
        client = (
            DryRunClient(experiment.allocations)
            if args.dry_run
            else _live_client(
                api_url,
                key,
                environment,
                experiment.flag,
                reviewers.keys() - known_repeats,
                allow_repeat=args.allow_repeat,
            )
        )
        rate = None if args.dry_run else args.rate
        if funnel is not None:
            summary = run_funnel(
                client,
                funnel,
                reviewers=reviewers,
                model_name=args.model,
                rate=rate,
                seed=args.seed,
            )
            _print_funnel_summary(summary, args.model, args.dry_run, funnel)
        else:
            summary = run_simulation(
                client,
                experiment,
                diffs,
                reviewers=reviewers,
                model_name=args.model,
                rate=rate,
                seed=args.seed,
            )
            _print_summary(summary, args.model, source, len(diffs), args.dry_run, experiment)
    except FlagsmithFeatureDoesNotExistError:
        print(f"The selected Flagsmith environment has no {experiment.flag} flag.", file=sys.stderr)
        return 1
    except FlagsmithClientError:
        print(
            "Flagsmith flag evaluation failed. Check the API URL and environment key.",
            file=sys.stderr,
        )
        return 1
    except (OSError, KeyError, ValueError, SimulationError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Simulation interrupted.", file=sys.stderr)
        return 130

    if args.persona_summary:
        _print_persona_summary(summary, personas)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
