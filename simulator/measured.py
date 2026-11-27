"""Load measured sync samples and replay them with deterministic reviewer workloads."""

import json
from collections.abc import Callable
from dataclasses import dataclass
from itertools import product
from pathlib import Path
from random import Random
from statistics import median
from time import monotonic, sleep

from clients import ExperimentClient
from config import name_value, number, section
from panels import Panel
from personas import Persona
from runner import VariantSummary, assigned_variant, persona_counts

SCHEMA = "code-flow/sync-benchmark@1"
DEFAULT_INTERVAL = 300
VARIANTS = ("manual_button", "per_repo_toggle", "global_toggle")
SIZES = ("small", "medium", "large")
COUNTS = ("1", "5")
EVENTS = ("page_load", "server_cpu", "freshness", "conversion")
Cell = tuple[str, str, int]


@dataclass(frozen=True)
class MeasuredExperiment:
    flag: str
    control: str
    allocations: dict[str, int]
    events: dict[str, str]
    sizes: dict[str, int]
    counts: dict[str, int]

    def workload(self, identifier: str, seed: int) -> tuple[str, int]:
        random = Random(f"{seed}:{identifier}:workload")
        size = random.choices(list(self.sizes), weights=list(self.sizes.values()))[0]
        count = random.choices(list(self.counts), weights=list(self.counts.values()))[0]
        return size, int(count)


def _weights(values: dict, name: str) -> dict[str, int]:
    if any(type(weight) is not int or weight <= 0 for weight in values.values()):
        raise ValueError(f"{name} weights must be positive integers.")
    if sum(values.values()) != 100:
        raise ValueError(f"{name} weights must add up to 100.")
    return values


def measured_experiment(data: object) -> MeasuredExperiment:
    fields = section(data, "Measured experiment", "flag", "mode", "variants", "events", "workload")
    if fields["flag"] != "sync_mode":
        raise ValueError("The measured mode requires the sync_mode flag.")
    variants = section(fields["variants"], "variants", *VARIANTS)
    controls = []
    allocations = {}
    for key in VARIANTS:
        settings = section(variants[key], key, "allocation", optional=("control",))
        allocations[key] = settings["allocation"]
        if settings.get("control", False) is True:
            controls.append(key)
    if controls != ["manual_button"]:
        raise ValueError("manual_button must be the sole sync_mode control.")
    events = {
        key: name_value(value, f"events.{key}")
        for key, value in section(fields["events"], "events", *EVENTS).items()
    }
    workload = section(fields["workload"], "workload", "repo_sizes", "repo_counts")
    sizes = section(workload["repo_sizes"], "repo_sizes", *SIZES)
    counts = workload["repo_counts"]
    if isinstance(counts, dict):
        counts = {str(key): weight for key, weight in counts.items()}
    return MeasuredExperiment(
        "sync_mode",
        controls[0],
        _weights(allocations, "variants"),
        events,
        _weights(sizes, "repo_sizes"),
        _weights(section(counts, "repo_counts", *COUNTS), "repo_counts"),
    )


@dataclass(frozen=True)
class Freshness:
    measured_s: float
    automatic: bool


@dataclass(frozen=True)
class Measurements:
    page_ms: list[float]
    cpu_ms_per_hour: float
    freshness: list[Freshness]


@dataclass(frozen=True)
class Benchmark:
    runs: dict[Cell, Measurements]
    visits_per_hour: float


def _nonnegative(fields: dict, key: str, label: str) -> float:
    value = number(fields, key, label)
    if value < 0:
        raise ValueError(f"{label}.{key} must be nonnegative.")
    return value


def load_benchmark(path: Path) -> Benchmark:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(document, dict) or document.get("schema") != SCHEMA:
            raise ValueError(f"Expected benchmark schema {SCHEMA}.")
        visits = number(document["settings"], "visits_per_repo_hour", "settings")
        if visits <= 0:
            raise ValueError("settings.visits_per_repo_hour must be positive.")
        runs = {}
        for run in document["runs"]:
            cell = run["variant"], run["size"], run["repo_count"]
            label = "/".join(map(str, cell))
            if (
                cell[0] not in VARIANTS
                or cell[1] not in SIZES
                or type(cell[2]) is not int
                or str(cell[2]) not in COUNTS
            ):
                raise ValueError(f"Unknown benchmark workload {label}.")
            if cell in runs:
                raise ValueError(f"Duplicate benchmark workload {label}.")
            pages = [_nonnegative(row, "ms", label) for row in run["page_load_samples"]]
            cpu = _nonnegative(run["per_hour"]["default_300s"], "cpu_ms", label)
            freshness = []
            for row in run["freshness_samples"]:
                if row["mode"] not in ("auto", "manual"):
                    raise ValueError(f"Unknown freshness mode in {label}.")
                freshness.append(
                    Freshness(
                        _nonnegative(row, "detection_to_visible_s", label), row["mode"] == "auto"
                    )
                )
            if not pages or not freshness:
                raise ValueError(f"Missing page-load or freshness samples for {label}.")
            runs[cell] = Measurements(pages, cpu, freshness)
        if not runs:
            raise ValueError("The benchmark must contain at least one measured run.")
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"Invalid benchmark {path}: {exc}") from exc
    return Benchmark(runs, visits)


def require_workloads(
    benchmark: Benchmark, experiment: MeasuredExperiment, reviewers: Panel, seed: int
) -> None:
    workloads = {experiment.workload(identifier, seed) for identifier in reviewers}
    missing = {
        (variant, *workload) for variant, workload in product(experiment.allocations, workloads)
    }
    missing.difference_update(benchmark.runs)
    if missing:
        labels = ", ".join(f"{variant}/{size}/{count}" for variant, size, count in sorted(missing))
        raise ValueError(
            f"Benchmark lacks selected workloads: {labels}. Use the full matrix or a matching panel slice."
        )


@dataclass(frozen=True)
class Outcome:
    page_ms: float
    cpu_ms: float
    freshness_s: float

    @property
    def converted(self) -> bool:
        return self.freshness_s <= DEFAULT_INTERVAL


@dataclass(frozen=True)
class MeasuredSummary(VariantSummary):
    median_cpu_ms: float | None
    median_freshness_s: float | None


def _summarize(rows: list[tuple[Persona, Outcome]]) -> MeasuredSummary:
    count = len(rows)
    return MeasuredSummary(
        reviewers=count,
        success_rate=sum(outcome.converted for _, outcome in rows) / count if count else None,
        median_ms=median(outcome.page_ms for _, outcome in rows) if count else None,
        persona_counts=persona_counts([persona for persona, _ in rows]),
        median_cpu_ms=median(outcome.cpu_ms for _, outcome in rows) if count else None,
        median_freshness_s=median(outcome.freshness_s for _, outcome in rows) if count else None,
    )


def run_measured(
    client: ExperimentClient,
    experiment: MeasuredExperiment,
    benchmark: Benchmark,
    *,
    reviewers: Panel,
    rate: float | None,
    seed: int,
    clock: Callable[[], float] = monotonic,
    sleep_for: Callable[[float], None] = sleep,
) -> dict[str, MeasuredSummary]:
    """Evaluate one variant per identity, then replay measured values for its cell."""
    rows: dict[str, list[tuple[Persona, Outcome]]] = {
        variant: [] for variant in experiment.allocations
    }
    interval = 0 if rate is None else 1 / rate
    try:
        require_workloads(benchmark, experiment, reviewers, seed)
        for index, (identifier, persona) in enumerate(reviewers.items(), start=1):
            started = clock()
            size, count = experiment.workload(identifier, seed)
            traits = {**persona.traits(), "repo_size": size, "repo_count": count}
            variant = assigned_variant(
                client, experiment.flag, experiment.allocations, identifier, traits
            )
            measurements = benchmark.runs[(variant, size, count)]
            random = Random(f"{seed}:{identifier}:measurements")
            page_ms = random.choice(measurements.page_ms)
            fresh = random.choice(measurements.freshness)
            wait_window = DEFAULT_INTERVAL if fresh.automatic else 3600 / benchmark.visits_per_hour
            outcome = Outcome(
                page_ms,
                measurements.cpu_ms_per_hour,
                fresh.measured_s + random.uniform(0, wait_window),
            )
            values = {
                "page_load": outcome.page_ms,
                "server_cpu": outcome.cpu_ms,
                "freshness": outcome.freshness_s,
            }
            if outcome.converted:
                values["conversion"] = None
            for metric, value in values.items():
                client.track_event(
                    experiment.events[metric], identifier=identifier, value=value, traits=traits
                )
            rows[variant].append((persona, outcome))
            remaining = interval - (clock() - started)
            if index < len(reviewers) and remaining > 0:
                sleep_for(remaining)
    finally:
        client.close()
    return {variant: _summarize(outcomes) for variant, outcomes in rows.items()}
