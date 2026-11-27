"""Replay measured values through the offline Flagsmith client."""

import json
from itertools import product
from pathlib import Path

import pytest

from clients import DryRunClient
from experiments import load_experiment
from measured import COUNTS, SCHEMA, SIZES, VARIANTS, load_benchmark, run_measured
from panels import load_panel, select_panel
from personas import load_personas
from simulate import SIMULATOR_DIR, main


@pytest.fixture
def document(tmp_path: Path) -> Path:
    runs = []
    for index, (variant, size, count) in enumerate(product(VARIANTS, SIZES, COUNTS)):
        runs.append(
            {
                "variant": variant,
                "size": size,
                "repo_count": int(count),
                "page_load_samples": [{"ms": index + 101.25}, {"ms": index + 201.25}],
                "per_hour": {"default_300s": {"cpu_ms": index * 1000 + 250.5}},
                "freshness_samples": [
                    {"mode": "auto", "detection_to_visible_s": 0.0},
                    {"mode": "manual", "detection_to_visible_s": 305.0},
                ],
            }
        )
    path = tmp_path / "bench.json"
    path.write_text(
        json.dumps(
            {
                "schema": SCHEMA,
                "settings": {"visits_per_repo_hour": 12},
                "runs": runs,
            }
        ),
        encoding="utf-8",
    )
    return path


def test_replay_uses_matching_measurements_and_traits(document: Path) -> None:
    personas = load_personas(SIMULATOR_DIR / "personas.yaml")
    reviewers = select_panel(
        load_panel("default", personas, SIMULATOR_DIR / "panels"), offset=0, limit=30
    )
    config = load_experiment(SIMULATOR_DIR / "experiments/sync_mode.yaml", personas)
    benchmark = load_benchmark(document)
    client = DryRunClient(config.allocations)
    summary = run_measured(client, config, benchmark, reviewers=reviewers, rate=None, seed=7)
    assert sum(row.reviewers for row in summary.values()) == 30
    assert client.closed
    assert len({row["repo_size"] for row in client.identity_traits.values()}) == 3
    assert {row["repo_count"] for row in client.identity_traits.values()} == {1, 5}
    all_conversions = set()
    for identifier, traits in client.identity_traits.items():
        events = {kind: value for kind, reviewer, value in client.events if reviewer == identifier}
        cell = benchmark.runs[events["$flag_exposure"], traits["repo_size"], traits["repo_count"]]
        assert events["sync_page_load_ms"] in cell.page_ms
        assert events["sync_server_cpu_ms"] == cell.cpu_ms_per_hour
        elapsed = events["sync_freshness_s"]
        assert 0 <= elapsed <= 300 or 305 <= elapsed <= 605
        converted = "new_commit_seen_within_5min" in events
        assert converted == (elapsed <= 300)
        all_conversions.add(converted)
    assert all_conversions == {False, True}

    reverse = DryRunClient(config.allocations)
    run_measured(
        reverse,
        config,
        benchmark,
        reviewers=dict(reversed(list(reviewers.items()))),
        rate=None,
        seed=7,
    )
    assert sorted(reverse.events) == sorted(client.events)


def test_measured_cli_validates_workload_before_exposures(
    document: Path, capsys, monkeypatch
) -> None:
    monkeypatch.setenv("CODEFLOW_SIM_ENVIRONMENT", "Development")
    args = ["--experiment", "sync_mode", "--benchmark", str(document), "--dry-run"]
    assert main([*args, "--limit", "12"]) == 0
    assert "Measured sync_mode replay (dry run)" in capsys.readouterr().out
    assert main([*args, "--environment", "Production"]) == 1
    assert "only in Development" in capsys.readouterr().err

    data = json.loads(document.read_text())
    data["runs"] = data["runs"][:1]
    document.write_text(json.dumps(data), encoding="utf-8")
    assert main(args) == 1
    assert "Benchmark lacks selected workloads" in capsys.readouterr().err
