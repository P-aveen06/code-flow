"""Command-line entry point for the flow_view traffic simulator."""

import argparse
import math
import os
import sys
from pathlib import Path

from flagsmith.exceptions import FlagsmithClientError, FlagsmithFeatureDoesNotExistError

from clients import DEFAULT_API_URL, DryRunClient, ExperimentClient, flagsmith_client
from diffs import load_diff_sizes
from model import MODELS, load_models
from personas import PersonaModel
from runner import SimulationError, VariantSummary, run_simulation

SIMULATOR_DIR = Path(__file__).resolve().parent
REPO_ROOT = SIMULATOR_DIR.parent


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
    parser.add_argument("--n", type=int, default=1000, help="reviewer count (default 1000)")
    parser.add_argument("--rate", type=float, default=20, help="reviewers per second (default 20)")
    parser.add_argument("--seed", type=int, default=7, help="sampling seed (default 7)")
    parser.add_argument("--model", choices=MODELS, default="hypothesis")
    parser.add_argument("--dry-run", action="store_true", help="assign and record events offline")
    parser.add_argument("--prefix", default="sim-reviewer", help="reviewer ID prefix")
    parser.add_argument(
        "--persona-summary", action="store_true", help="show simulated persona counts by variant"
    )
    args = parser.parse_args(argv)
    if args.n < 1:
        parser.error("--n must be positive")
    if not math.isfinite(args.rate) or args.rate <= 0:
        parser.error("--rate must be positive and finite")
    if not args.prefix.strip():
        parser.error("--prefix must not be empty")
    return args


def _print_summary(
    summary: dict[str, VariantSummary], model: str, source: str, commit_count: int, dry_run: bool
) -> None:
    mode = "dry run" if dry_run else "Flagsmith"
    print(f"Simulated reviewers ({model} model, {mode})")
    print(f"Diffs sampled from {commit_count} flow-changing commits in {source}.")
    print(f"{'Variant':<17} {'Reviewers':>9} {'Understood rate':>15} {'Median ms':>12}")
    for variant, stats in summary.items():
        understood = f"{stats.understood_rate:.1%}" if stats.understood_rate is not None else "-"
        elapsed = f"{stats.median_ms:,.0f}" if stats.median_ms is not None else "-"
        print(f"{variant:<17} {stats.reviewers:>9} {understood:>15} {elapsed:>12}")


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


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        model = load_models(SIMULATOR_DIR / "behaviour.yaml")[args.model]
        source, diff_sizes = load_diff_sizes(REPO_ROOT / "data")
        client: ExperimentClient
        if args.dry_run:
            client = DryRunClient()
        else:
            settings = {**_read_dotenv(REPO_ROOT / ".env"), **os.environ}
            client = flagsmith_client(
                settings.get("FLAGSMITH_API_URL") or DEFAULT_API_URL,
                settings.get("CODEFLOW_FLAGSMITH_ENV_KEY", ""),
            )
    except (OSError, KeyError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    try:
        summary = run_simulation(
            client, model, diff_sizes, n=args.n, rate=args.rate, seed=args.seed, prefix=args.prefix
        )
    except FlagsmithFeatureDoesNotExistError:
        print("The selected Flagsmith environment has no flow_view flag.", file=sys.stderr)
        return 1
    except FlagsmithClientError:
        print(
            "Flagsmith flag evaluation failed. Check the API URL and environment key.",
            file=sys.stderr,
        )
        return 1
    except SimulationError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Simulation interrupted.", file=sys.stderr)
        return 130

    _print_summary(summary, args.model, source, len(diff_sizes), args.dry_run)
    if args.persona_summary:
        _print_persona_summary(summary, model.personas)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
