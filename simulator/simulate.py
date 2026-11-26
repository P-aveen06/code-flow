"""Simulate reviewer traffic for a configured Flagsmith experiment."""

import argparse
import math
import os
import sys
from pathlib import Path

from flagsmith.exceptions import FlagsmithClientError, FlagsmithFeatureDoesNotExistError

from clients import DEFAULT_API_URL, DryRunClient, ExperimentClient, flagsmith_client
from config import named_path
from diffs import load_diff_sizes
from experiments import Experiment, load_experiment
from history import reserve_reviewers
from model import MODELS
from panels import EXPERIENCE_BANDS, Panel, generate_panel, load_panel, profile_counts, select_panel
from personas import PersonaModel, load_personas
from runner import SimulationError, VariantSummary, run_simulation

SIMULATOR_DIR = Path(__file__).resolve().parent
REPO_ROOT = SIMULATOR_DIR.parent
EXPERIMENTS_DIR = SIMULATOR_DIR / "experiments"
PANELS_DIR = SIMULATOR_DIR / "panels"


def _read_dotenv(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return {}

    values = {}
    for line in lines:
        name, separator, value = line.strip().removeprefix("export ").partition("=")
        name = name.strip()
        if not separator or not name or name.startswith("#"):
            continue
        value = value.strip()
        if value.startswith(('"', "'")) and value[0] in value[1:]:
            value = value[1:].split(value[0], 1)[0]
        else:
            value = "" if value.startswith("#") else value.partition(" #")[0].strip()
        values[name] = value
    return values


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--experiment", default="flow_view", help="experiment name (default flow_view)"
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
        "--allow-repeat", action="store_true", help="allow repeat events on the same flag"
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
    print(f"Diffs sampled from {commit_count} flow-changing commits in {source}.")
    width = max(len("Variant"), *(len(variant) for variant in summary))
    print(f"{'Variant':<{width}} {'Reviewers':>9} {'Success rate':>15} {'Median ms':>12}")
    for variant, stats in summary.items():
        success = f"{stats.success_rate:.1%}" if stats.success_rate is not None else "-"
        elapsed = f"{stats.median_ms:,.0f}" if stats.median_ms is not None else "-"
        print(f"{variant:<{width}} {stats.reviewers:>9} {success:>15} {elapsed:>12}")


def _print_persona_summary(summary: dict[str, VariantSummary], personas: PersonaModel) -> None:
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


def _live_client(flag: str, identities: set[str], *, allow_repeat: bool) -> ExperimentClient:
    settings = {**_read_dotenv(REPO_ROOT / ".env"), **os.environ}
    client = flagsmith_client(
        settings.get("FLAGSMITH_API_URL") or DEFAULT_API_URL,
        settings.get("CODEFLOW_FLAGSMITH_ENV_KEY", ""),
    )
    try:
        repeats = reserve_reviewers(
            REPO_ROOT / "data" / "simulator-runs.sqlite3",
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

        experiment = load_experiment(
            named_path(EXPERIMENTS_DIR, args.experiment, ".yaml"), personas
        )
        known_repeats = set()
        if not args.dry_run and experiment.flag == "flow_view":
            # This flag already received the entire default panel in the published run.
            published_panel = (
                panel if args.panel == "default" else load_panel("default", personas, PANELS_DIR)
            )
            known_repeats = reviewers.keys() & published_panel.keys()
            _check_repeats(
                experiment.flag, len(known_repeats), confirmed=True, allow_repeat=args.allow_repeat
            )
        source, diff_sizes = load_diff_sizes(REPO_ROOT / "data")
        client = (
            DryRunClient(experiment.allocations)
            if args.dry_run
            else _live_client(
                experiment.flag, reviewers.keys() - known_repeats, allow_repeat=args.allow_repeat
            )
        )
        summary = run_simulation(
            client,
            experiment,
            diff_sizes,
            reviewers=reviewers,
            model_name=args.model,
            rate=None if args.dry_run else args.rate,
            seed=args.seed,
        )
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

    _print_summary(summary, args.model, source, len(diff_sizes), args.dry_run, experiment)
    if args.persona_summary:
        _print_persona_summary(summary, personas)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
