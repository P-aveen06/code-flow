"""Write the versioned sample document and a compact human-readable comparison."""

import json
from datetime import UTC, datetime
from pathlib import Path

from sync_bench.checkpoints import SavedCase
from sync_bench.metrics import FORMULAS, SCHEMA

METHOD = {
    "workloads": "Small is the 8-commit shop demo plus deterministic Python edits. Medium and large start at 50 and 200 first-parent commits touching Flagsmith api/. All upstreams are local. Each interval advances the same next commit to every repo at one seeded uniform phase.",
    "manual_visits": "Manual checks use a fixed cadence with a seeded phase per repo. The cadence is compressed by benchmark interval / 300, preserving the visit-to-commit rate ratio. Auto-followed repos rely on the scheduler; the remaining repos use manual checks.",
    "followed_repos": "A follows zero repos. B follows the first two, or the only repo in the one-repo case. C follows all repos.",
    "browser": "Puppeteer Core drives system Chrome with cold navigation storage. Full Chrome uses a fresh context. The macOS headless shell clears storage and disables HTTP caching between samples. Readiness is a complete repository list, the selected preview, and the expected count of loaded sync switches. The isolated web server returns preview flags using the configured Development client key; timings exclude external Flagsmith network latency.",
    "overlap": "A browser sample overlaps sync if its navigation-to-ready window intersects an observed Git ls-remote start to commit-index publication window for any repo.",
    "api": "Loopback wall time through response body and JSON decoding. Probe cycles target 0.5 seconds, read every repo's commits, and rotate the newest diff across repos. Slow API calls can extend a cycle.",
    "cpu": "One-second server-process samples. Git subprocess CPU and Chrome CPU are outside this measurement. CPU includes the API, including cache rebuilds after publishing, and uses a short warmed baseline with the same probes.",
    "counts": "Automatic refresh runs and analysis counts come from GET /api/auto-sync. Manual starts use its manual_runs counter, with POST attempts logged separately. Git Trace2 counts actual fetch calls; new snapshot files count the graphs built, including any missing base. Manual fetches and graphs are totals minus the automatic counters.",
    "sampling_limit": "Per-hour projections use the observed mixture of refresh costs and assume it carries over to 300 seconds. Benchmark intervals and reviewer visits control the workload. Treat projections as estimates, and review overlap counts and sample sizes.",
}


def make_result(
    environment: dict,
    settings: dict,
    templates: dict,
    runs: list[dict],
    *,
    finished_at_utc: str | None = None,
) -> dict:
    return {
        "schema": SCHEMA,
        "finished_at_utc": finished_at_utc or datetime.now(UTC).isoformat(),
        "environment": environment,
        "settings": settings,
        "methods": METHOD,
        "formulas": FORMULAS,
        "templates": templates,
        "runs": runs,
    }


def report_from_cases(settings: dict, cases: list[SavedCase]) -> dict:
    templates = {}
    for case in cases:
        templates.setdefault(case.result["size"], case.template)
    return make_result(
        cases[0].environment,
        {**settings, "elapsed_s": round(sum(case.elapsed_s for case in cases), 3)},
        {size: templates[size] for size in settings["sizes"]},
        [case.result for case in cases],
        finished_at_utc=max(case.finished_at_utc for case in cases),
    )


def _pair(stats: dict) -> str:
    return f"{stats['p50']:,.2f} / {stats['p95']:,.2f}"


def markdown(result: dict) -> str:
    settings = result["settings"]
    environment = result["environment"]
    rows = [
        f"# sync_mode benchmark · {result['finished_at_utc'][:10]}",
        "",
        (
            f"{environment['os']} · {environment['cpu']} · Python {environment['python']} · "
            f"API Python {environment['server_python']} · Node {environment['node']} · {environment['git']} · {environment['chrome']} ({environment['browser_mode']})"
        ),
        "",
        (
            f"code-flow `{environment['code_flow_sha']}`"
            f"{' with working-tree changes' if environment['dirty'] else ''}. "
            f"{'Quick smoke run. ' if settings['quick'] else ''}"
            f"Interval {settings['interval_s']:g} s, {settings['intervals']} advances per repo, "
            f"{settings['visits_per_repo_hour']:g} modeled manual visits per repo per hour "
            f"at the 300 s default, seed {settings['seed']}."
        ),
        "",
        "## Template imports",
        "",
        "| Size | Commits | Import s | API peak RSS MiB | Data MiB |",
        "|---|---:|---:|---:|---:|",
    ]
    mib = 1024**2
    for size, template in result["templates"].items():
        rows.append(
            f"| {size} | {template['commits']} | {template['import_s']:.2f} | "
            f"{template['peak_rss_bytes'] / mib:.1f} | {template['disk_bytes'] / mib:.2f} |"
        )
    rows.extend(
        [
            "",
            "## Observed latency and freshness",
            "",
            "All pairs show p50 / p95. The overlap column counts page loads observed during a refresh.",
            "",
            "| Variant | Size | Repos | Page ms | In sync / total | Repos API ms | Commits API ms | Diff API ms | Freshness s |",
            "|---|---|---:|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for run in result["runs"]:
        latencies = run["api_latency_ms"]
        overlap = sum(row["during_sync"] for row in run["page_load_samples"])
        rows.append(
            f"| {run['variant']} | {run['size']} | {run['repo_count']} | "
            f"{_pair(run['page_load_ms'])} | {overlap} / {len(run['page_load_samples'])} | "
            f"{_pair(latencies['repos'])} | {_pair(latencies['commits'])} | "
            f"{_pair(latencies['diff'])} | {_pair(run['freshness_s'])} |"
        )
    rows.extend(
        [
            "",
            "## Server work and 300 s projections",
            "",
            "| Variant | Size | Repos | Wall s | API CPU s | Peak RSS MiB | Fetches | Auto / manual jobs | Graphs built | Disk growth MiB | Projected CPU s/h | Projected freshness s (p50 / p95) |",
            "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for run in result["runs"]:
        counts = run["counts"]
        default = run["per_hour"]["default_300s"]
        rows.append(
            f"| {run['variant']} | {run['size']} | {run['repo_count']} | "
            f"{run['elapsed_s']:.2f} | {run['cpu_seconds']:.3f} | {run['peak_rss_bytes'] / mib:.1f} | "
            f"{counts['fetches']} | {counts['auto_runs']} / {counts['manual_runs']} | "
            f"{counts['analysed_commits']} | {run['disk_growth_bytes'] / mib:.3f} | "
            f"{default['cpu_ms'] / 1000:.3f} | {_pair(run['default_300s_freshness_s'])} |"
        )
    rows.extend(["", "## Measurement and scaling", ""])
    rows.extend(f"- {method}" for method in result["methods"].values())
    rows.extend(["", "Formulas", ""])
    rows.extend(
        f"- **{name}** — {formula}" for name, formula in result["formulas"].items()
    )
    return "\n".join(rows) + "\n"


def write_report(result: dict, directory: Path) -> tuple[Path, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    stem = "sync_mode-" + result["finished_at_utc"][:10]
    raw = directory / f"{stem}.json"
    summary = directory / f"{stem}.md"
    raw.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
    summary.write_text(markdown(result), encoding="utf-8")
    return raw, summary
