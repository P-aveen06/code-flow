"""Measure sync-mode variants with local Git upstreams, the real API, and Chrome."""

import argparse
import math
import platform
import subprocess
import sys
from itertools import product
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic

from sync_bench.metrics import VARIANTS
from sync_bench.report import make_result, write_report
from sync_bench.run import import_template, run_case
from sync_bench.runtime import (
    api_listener,
    api_server,
    build_web,
    development_key,
    web_server,
)
from sync_bench.sampling import chrome
from sync_bench.workload import Workload
from sync_bench.workspace import (
    ROOT,
    SIZES,
    build_history,
    copy_template,
    flagsmith_cache,
    git,
    make_upstreams,
    validate_workdir,
)

VARIANT_NAMES = dict(zip(("A", "B", "C"), VARIANTS))


def _selected(values: list[str] | None, choices: tuple, default: tuple) -> tuple:
    if values is None:
        return default
    options = {str(choice): choice for choice in choices}
    if choices == VARIANTS:
        options.update(VARIANT_NAMES)
    try:
        return tuple(
            dict.fromkeys(
                options[item] for value in values for item in value.split(",")
            )
        )
    except KeyError as exc:
        raise ValueError(
            f"Unknown selection {exc.args[0]!r}. Choose from {', '.join(options)}."
        ) from None


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workdir", required=True, type=Path)
    parser.add_argument("--sizes", nargs="+", help="small, medium, large")
    parser.add_argument("--repos", nargs="+", help="1, 5")
    parser.add_argument("--variants", nargs="+", help="A, B, C or the flag values")
    parser.add_argument(
        "--interval", type=float, help="auto-sync interval in seconds (default 30)"
    )
    parser.add_argument(
        "--intervals", type=int, help="number of advances per repo (default 8)"
    )
    parser.add_argument("--visits-per-hour", type=float, default=12)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument(
        "--offline", action="store_true", help="use the existing Flagsmith Git cache"
    )
    parser.add_argument(
        "--quick", action="store_true", help="small, 1 repo, 3 × 2 s, all variants"
    )
    args = parser.parse_args(argv)
    try:
        args.workdir = validate_workdir(args.workdir)
        args.sizes = _selected(args.sizes, SIZES, ("small",) if args.quick else SIZES)
        args.repos = _selected(args.repos, (1, 5), (1,) if args.quick else (1, 5))
        args.variants = _selected(args.variants, VARIANTS, VARIANTS)
        if args.interval is None:
            args.interval = 2 if args.quick else 30
        if args.intervals is None:
            args.intervals = 3 if args.quick else 8
        if not math.isfinite(args.interval) or args.interval < 1:
            raise ValueError("--interval must be at least one second.")
        if args.intervals < 1:
            raise ValueError("--intervals must be positive.")
        if not math.isfinite(args.visits_per_hour) or args.visits_per_hour <= 0:
            raise ValueError("--visits-per-hour must be positive and finite.")
    except ValueError as exc:
        parser.error(str(exc))
    return args


def _environment(browser_version: str) -> dict:
    cpu = platform.processor() or platform.machine()
    if platform.system() == "Darwin":
        result = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            cpu = result.stdout.strip()
    return {
        "os": platform.platform(),
        "cpu": cpu,
        "python": platform.python_version(),
        "node": subprocess.check_output(["node", "--version"], text=True).strip(),
        "git": git("--version"),
        "chrome": browser_version,
        "code_flow_sha": git("rev-parse", "HEAD", repo=ROOT),
        "dirty": bool(git("status", "--porcelain", repo=ROOT)),
    }


def _prepare_templates(
    args: argparse.Namespace, directory: Path, origin: str
) -> tuple[dict, dict]:
    cache = None
    if any(size != "small" for size in args.sizes):
        print("Preparing the pinned Flagsmith Git cache.", flush=True)
        cache = flagsmith_cache(args.workdir, args.intervals, offline=args.offline)
    histories = {}
    templates = {}
    for size in args.sizes:
        print(f"Importing the {size} template.", flush=True)
        stage = directory / size
        stage.mkdir()
        history = build_history(size, stage, args.intervals, cache)
        histories[size] = history
        upstreams = make_upstreams(stage / "upstreams", history, 1)
        data = directory / "templates" / size
        with (
            api_listener() as listener,
            api_server(
                stage, listener, data, upstreams, origin, args.interval
            ) as server,
        ):
            templates[size] = import_template(
                server, data, next(iter(upstreams)), history
            )
    return histories, templates


def run(args: argparse.Namespace) -> tuple[Path, Path]:
    key = development_key()
    if not key:
        raise ValueError(
            "Set CODEFLOW_SIM_FLAGSMITH_ENV_KEY to the Development client key."
        )
    args.workdir.mkdir(parents=True, exist_ok=True)
    started = monotonic()
    with TemporaryDirectory(prefix="run-", dir=args.workdir) as scratch:
        directory = Path(scratch)
        build = directory / "site"
        build.mkdir()
        (directory / "templates").mkdir()
        with web_server(build, key) as origin, chrome(directory) as browser:
            histories, templates = _prepare_templates(args, directory, origin)
            environment = _environment(browser.version)
            environment["browser_mode"] = browser.mode
            environment["server_python"] = next(iter(templates.values()))["python"]
            runs = []
            for variant, size, count in product(args.variants, args.sizes, args.repos):
                print(f"Measuring {variant}, {size}, {count} repo(s).", flush=True)
                workload = Workload(
                    variant,
                    size,
                    count,
                    args.interval,
                    args.intervals,
                    args.visits_per_hour,
                    args.seed,
                )
                with TemporaryDirectory(prefix="case-", dir=directory) as case:
                    stage = Path(case)
                    data = stage / "data"
                    upstreams = make_upstreams(
                        stage / "upstreams", histories[size], count
                    )
                    copy_template(directory / "templates" / size, data, upstreams)
                    with (
                        api_listener() as listener,
                        api_server(
                            stage, listener, data, upstreams, origin, args.interval
                        ) as server,
                    ):
                        build_web(build, server.api.origin, origin, key)
                        runs.append(
                            run_case(
                                server,
                                browser,
                                origin,
                                data,
                                upstreams,
                                histories[size],
                                workload,
                            )
                        )
        settings = {
            "quick": args.quick,
            "offline": args.offline,
            "interval_s": args.interval,
            "intervals": args.intervals,
            "visits_per_repo_hour": args.visits_per_hour,
            "seed": args.seed,
            "elapsed_s": round(monotonic() - started, 3),
            "sizes": args.sizes,
            "repo_counts": args.repos,
            "variants": args.variants,
        }
    return write_report(
        make_result(environment, settings, templates, runs), ROOT / "docs/benchmarks"
    )


def main() -> int:
    try:
        raw, summary = run(parse_args())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"Benchmark failed: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    print(f"Wrote {raw.relative_to(ROOT)} and {summary.relative_to(ROOT)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
