"""Measure sync-mode variants with local Git upstreams, the real API, and Chrome."""

import argparse
import math
import platform
import signal
import subprocess
import sys
from contextlib import ExitStack
from datetime import UTC, datetime
from itertools import product
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic

from sync_bench.checkpoints import Case, CaseStore, SavedCase, lock_workdir, run_key
from sync_bench.metrics import VARIANTS
from sync_bench.report import report_from_cases, write_report
from sync_bench.run import import_template, run_case
from sync_bench.runtime import (
    api_listener,
    api_server,
    build_web,
    development_key,
    web_server,
)
from sync_bench.sampling import Chrome, chrome
from sync_bench.suspension import Suspended, SuspensionCheck
from sync_bench.workload import Workload
from sync_bench.workspace import (
    ROOT,
    SIZES,
    History,
    build_history,
    cached_template,
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
        "--fresh",
        action="store_true",
        help="remeasure cases, reusing imported templates",
    )
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


def _environment(browser: Chrome, code_flow_sha: str) -> dict:
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
        "chrome": browser.version,
        "browser_mode": browser.mode,
        "code_flow_sha": code_flow_sha,
        "dirty": bool(git("status", "--porcelain", repo=ROOT)),
    }


def _prepare_template(
    args: argparse.Namespace,
    stage: Path,
    origin: str,
    size: str,
    cache: Path | None,
    code_flow_sha: str,
) -> tuple[History, Path, dict]:
    stage.mkdir()
    history = build_history(size, stage, args.intervals, cache)

    def build(data: Path) -> dict:
        upstreams = make_upstreams(stage / "upstreams", history, 1)
        with (
            api_listener() as listener,
            api_server(
                stage, listener, data, upstreams, origin, args.interval
            ) as server,
        ):
            return import_template(server, data, next(iter(upstreams)), history)

    template, metadata = cached_template(
        args.workdir, size, history, code_flow_sha, build
    )
    return history, template, metadata


def pending_cases(store: CaseStore, cases: list[Case], *, fresh: bool) -> list[Case]:
    pending = []
    for case in cases:
        if not fresh and store.load(case) is not None:
            variant, size, count = case
            print(f"Reusing {variant}, {size}, {count} repo(s).", flush=True)
        else:
            pending.append(case)
    return pending


def _measure_case(
    directory: Path,
    build: Path,
    origin: str,
    key: str,
    browser: Chrome,
    history: History,
    template: Path,
    workload: Workload,
    suspension: SuspensionCheck,
) -> dict:
    with TemporaryDirectory(prefix="case-", dir=directory) as case:
        stage = Path(case)
        data = stage / "data"
        upstreams = make_upstreams(stage / "upstreams", history, workload.repo_count)
        copy_template(template, data, upstreams)
        with (
            api_listener() as listener,
            api_server(
                stage, listener, data, upstreams, origin, workload.interval
            ) as server,
        ):
            build_web(build, server.api.origin, origin, key)
            suspension.check()
            return run_case(
                server, browser, origin, data, upstreams, history, workload, suspension
            )


def _measure_pending(
    args: argparse.Namespace,
    store: CaseStore,
    pending: list[Case],
    cache: Path | None,
    code_flow_sha: str,
) -> None:
    key = development_key()
    if not key:
        raise ValueError(
            "Set CODEFLOW_SIM_FLAGSMITH_ENV_KEY to the Development client key."
        )
    started = monotonic()
    with TemporaryDirectory(prefix="run-", dir=args.workdir) as scratch:
        directory = Path(scratch)
        build = directory / "site"
        build.mkdir()
        with web_server(build, key) as origin, ExitStack() as browsers:
            templates = {}
            browser = None
            for case in pending:
                variant, size, count = case
                if size not in templates:
                    templates[size] = _prepare_template(
                        args, directory / size, origin, size, cache, code_flow_sha
                    )
                history, template, metadata = templates[size]
                workload = Workload(
                    variant,
                    size,
                    count,
                    args.interval,
                    args.intervals,
                    args.visits_per_hour,
                    args.seed,
                )
                label = f"{variant}, {size}, {count} repo(s)"
                setup_s = monotonic() - started
                for attempt in range(2):
                    print(f"Measuring {label}.", flush=True)
                    attempt_started = monotonic()
                    suspension = SuspensionCheck()
                    try:
                        try:
                            if browser is None:
                                browser = browsers.enter_context(chrome(directory))
                                environment = _environment(browser, code_flow_sha)
                            row = _measure_case(
                                directory,
                                build,
                                origin,
                                key,
                                browser,
                                history,
                                template,
                                workload,
                                suspension,
                            )
                        except Exception:
                            suspension.check()
                            raise
                        suspension.check()
                    except Suspended as exc:
                        message = f"Invalid case {label}: {exc} (possible sleep or suspension)."
                        if attempt:
                            raise RuntimeError(
                                f"{message} Case was invalid twice."
                            ) from exc
                        print(f"{message} Retrying once.", flush=True)
                        browsers.close()
                        browser = None
                        continue
                    store.save(
                        case,
                        SavedCase(
                            row,
                            {**environment, "server_python": metadata["python"]},
                            metadata,
                            setup_s + monotonic() - attempt_started,
                            datetime.now(UTC).isoformat(),
                        ),
                    )
                    started = monotonic()
                    break


def run(args: argparse.Namespace) -> tuple[Path, Path]:
    args.workdir.mkdir(parents=True, exist_ok=True)
    with lock_workdir(args.workdir):
        code_flow_sha = git("rev-parse", "HEAD", repo=ROOT)
        cache = None
        flagsmith_sha = None
        if any(size != "small" for size in args.sizes):
            print("Preparing the pinned Flagsmith Git cache.", flush=True)
            cache = flagsmith_cache(args.workdir, args.intervals, offline=args.offline)
            flagsmith_sha = git("rev-parse", "HEAD", repo=cache)
        key = run_key(
            code_flow_sha,
            interval=args.interval,
            intervals=args.intervals,
            visits_per_hour=args.visits_per_hour,
            seed=args.seed,
            flagsmith_sha=flagsmith_sha,
            quick=args.quick,
        )
        store = CaseStore(args.workdir, key)
        cases = list(product(args.variants, args.sizes, args.repos))
        pending = pending_cases(store, cases, fresh=args.fresh)
        if pending:
            _measure_pending(args, store, pending, cache, code_flow_sha)
        saved = []
        for case in cases:
            record = store.load(case)
            if record is None:
                raise RuntimeError(f"Missing a valid result at {store.path(case)}.")
            saved.append(record)
        settings = {
            "quick": args.quick,
            "offline": args.offline,
            "interval_s": args.interval,
            "intervals": args.intervals,
            "visits_per_repo_hour": args.visits_per_hour,
            "seed": args.seed,
            "sizes": args.sizes,
            "repo_counts": args.repos,
            "variants": args.variants,
        }
        return write_report(
            report_from_cases(settings, saved), ROOT / "docs/benchmarks"
        )


class BenchmarkInterrupted(KeyboardInterrupt):
    def __init__(self, signum: int) -> None:
        self.signum = signum


def _interrupt(signum: int, _frame: object) -> None:
    # Let context managers finish shutting down even if Ctrl-C is pressed again.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise BenchmarkInterrupted(signum)


def main() -> int:
    handlers = {
        sig: signal.signal(sig, _interrupt) for sig in (signal.SIGINT, signal.SIGTERM)
    }
    try:
        raw, summary = run(parse_args())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"Benchmark failed: {exc}", file=sys.stderr)
        return 1
    except BenchmarkInterrupted as exc:
        print("Benchmark interrupted. Completed cases are saved.", file=sys.stderr)
        return 128 + exc.signum
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
    print(f"Wrote {raw.relative_to(ROOT)} and {summary.relative_to(ROOT)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
