"""Summarize benchmark samples and make the 300-second scaling model explicit."""

import math
from collections.abc import Sequence

DEFAULT_INTERVAL = 300
SCHEMA = "code-flow/sync-benchmark@1"
VARIANTS = ("manual_button", "per_repo_toggle", "global_toggle")
COUNTERS = ("fetches", "auto_runs", "manual_runs", "analysed_commits", "advances")

FORMULAS = {
    "percentiles": "Sort the samples and linearly interpolate at (n - 1) × percentile.",
    "observed_per_hour": "Observed counts and server CPU seconds × 3600 / observed elapsed seconds; CPU uses the elapsed time between its boundary samples.",
    "idle_cpu_s_per_hour": "Measured server CPU seconds during warm baseline × 3600 / baseline CPU sample elapsed seconds. The baseline includes API and browser sampling.",
    "refresh_cpu_s": "max(0, observed CPU seconds - idle CPU seconds/hour × observed CPU sample elapsed / 3600) / observed refresh jobs. Zero when no job ran.",
    "default_refreshes_per_hour": "Auto-followed repos × 3600 / 300 + manually checked repos × visits per repo per hour.",
    "default_cpu_ms_per_hour": "1000 × (idle CPU seconds/hour + refresh CPU seconds × default refresh jobs/hour).",
    "default_fetches_and_analysis_per_hour": "Observed count per refresh × default refresh jobs/hour, using the measured workload's mean cost per job.",
    "default_advances_per_hour": "Repository count × 3600 / 300 (one new commit per repo per interval).",
    "observed_freshness_s": "First /commits response containing the new SHA minus the upstream advance time.",
    "measured_detection_to_visible_s": "First /commits response containing the SHA minus the later of the advance and the refresh start (Git ls-remote for auto, accepted manual POST for manual). Includes polling and any API wait.",
    "default_freshness_s": "Measured detection-to-visible seconds + a seeded uniform wait of 0–300 seconds for auto or 0–(3600 / visits per repo per hour) for manual. The recorded samples use the benchmark seed; the simulator draws a new seeded wait per identity.",
    "disk_growth_bytes": "Final minus initial logical file bytes in the data directory; hardlinked copies count once per directory.",
}


def percentile(values: Sequence[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    rank = (len(ordered) - 1) * fraction
    low = int(rank)
    return round(
        ordered[low] + (ordered[math.ceil(rank)] - ordered[low]) * (rank - low), 3
    )


def distribution(values: Sequence[float]) -> dict[str, float | int | None]:
    return {
        "n": len(values),
        "p50": percentile(values, 0.5),
        "p95": percentile(values, 0.95),
    }


def scale_hourly(
    *,
    counters: dict[str, int],
    elapsed: float,
    cpu_seconds: float,
    cpu_elapsed: float,
    idle_cpu_per_hour: float,
    auto_repos: int,
    manual_repos: int,
    visits_per_hour: float,
) -> dict:
    jobs = counters["auto_runs"] + counters["manual_runs"]
    per_job = (
        max(0, cpu_seconds - idle_cpu_per_hour * cpu_elapsed / 3600) / jobs
        if jobs
        else 0
    )
    auto_rate = auto_repos * 3600 / DEFAULT_INTERVAL
    manual_rate = manual_repos * visits_per_hour
    refresh_rate = auto_rate + manual_rate
    observed = {name: counters[name] * 3600 / elapsed for name in COUNTERS}
    observed["cpu_s"] = cpu_seconds * 3600 / cpu_elapsed
    default = {
        "cpu_ms": 1000 * (idle_cpu_per_hour + per_job * refresh_rate),
        "auto_runs": auto_rate,
        "manual_runs": manual_rate,
        "refreshes": refresh_rate,
        "advances": (auto_repos + manual_repos) * 3600 / DEFAULT_INTERVAL,
    }
    for name in ("fetches", "analysed_commits"):
        default[name] = counters[name] / jobs * refresh_rate if jobs else 0
    return {
        "observed": {name: round(value, 3) for name, value in observed.items()},
        "default_300s": {name: round(value, 3) for name, value in default.items()},
        "idle_cpu_s_per_hour": round(idle_cpu_per_hour, 3),
        "incremental_cpu_s_per_refresh": round(per_job, 6),
    }


def wait_window_seconds(automatic: bool, visits_per_hour: float) -> float:
    return DEFAULT_INTERVAL if automatic else 3600 / visits_per_hour
