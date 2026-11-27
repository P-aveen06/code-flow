"""Check the benchmark's pure calculations, private paths and local Git fixtures."""

import json
import os
import subprocess
import sys
from contextlib import nullcontext
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sync_benchmark
from sync_bench import checkpoints
from sync_bench.checkpoints import Case, CaseStore, SavedCase, run_key, template_key
from sync_bench.metrics import (
    FORMULAS,
    SCHEMA,
    percentile,
    scale_hourly,
    wait_window_seconds,
)
from sync_bench.process_tree import ProcessUsage, peak_rss, sample_tree, tree_sampler
from sync_bench.report import make_result, markdown, report_from_cases, report_paths, write_report
from sync_bench.sampling import trace_git, window_samples
from sync_bench.suspension import Suspended, SuspensionCheck
from sync_bench.workload import _manual_request
from sync_bench.workspace import (
    History,
    advance_upstream,
    cached_template,
    copy_template,
    git,
    make_upstreams,
    safe_port,
    validate_workdir,
)


def test_percentiles_and_hourly_scaling() -> None:
    assert percentile([], 0.5) is None
    assert percentile([8], 0.95) == 8
    assert percentile([30, 10, 20], 0.95) == 29
    result = scale_hourly(
        counters={
            "fetches": 6,
            "auto_runs": 4,
            "manual_runs": 2,
            "analysed_commits": 3,
            "advances": 6,
        },
        elapsed=60,
        cpu_seconds=7,
        cpu_elapsed=60,
        idle_cpu_per_hour=60,
        auto_repos=2,
        manual_repos=3,
        visits_per_hour=6,
    )
    assert result["observed"]["cpu_s"] == 420
    assert result["incremental_cpu_s_per_refresh"] == 1
    assert result["default_300s"] == {
        "auto_runs": 24,
        "manual_runs": 18,
        "refreshes": 42,
        "advances": 60,
        "fetches": 42,
        "analysed_commits": 21,
        "cpu_ms": 102_000,
    }
    assert wait_window_seconds(True, 6) == 300
    assert wait_window_seconds(False, 6) == 600


def test_private_ports_and_workdir(tmp_path: Path) -> None:
    repo = tmp_path / "app"
    data = repo / "data"
    data.mkdir(parents=True)
    link = tmp_path / "shortcut"
    link.symlink_to(data)
    for port in (5173, 5174, 8787, 8788, -1):
        with pytest.raises(ValueError, match="ephemeral"):
            safe_port(port)
    assert safe_port(0) == 0
    for path in (repo, data / "demo", link / "demo", tmp_path):
        with pytest.raises(ValueError, match="dedicated"):
            validate_workdir(path, repo=repo)
    assert validate_workdir(tmp_path / "benchmark", repo=repo) == tmp_path / "benchmark"


def test_git_upstream_and_isolated_template_copy(tmp_path: Path) -> None:
    source = tmp_path / "source"
    git("init", "--initial-branch=main", "--template=", str(source))
    identities = {
        "GIT_AUTHOR_NAME": "Test",
        "GIT_AUTHOR_EMAIL": "test@example.invalid",
        "GIT_COMMITTER_NAME": "Test",
        "GIT_COMMITTER_EMAIL": "test@example.invalid",
    }
    shas = []
    for text in ("first", "second"):
        (source / "file.py").write_text(text, encoding="utf-8")
        git("add", "file.py", repo=source)
        git("commit", "-m", text, repo=source, extra_env=identities)
        shas.append(git("rev-parse", "HEAD", repo=source))
    first, second = shas
    upstreams = make_upstreams(
        tmp_path / "upstreams",
        History(source / ".git", "tiny", "", 1, first, (second,)),
        2,
    )
    one, two = upstreams.values()
    assert git("rev-parse", "HEAD", repo=one) == first
    advance_upstream(one, second, first)
    assert git("rev-parse", "HEAD", repo=one) == second
    assert git("rev-parse", "HEAD", repo=two) == first
    with pytest.raises(RuntimeError, match="update-ref"):
        advance_upstream(one, first, first)

    template = tmp_path / "template"
    clone = template / "repos" / "bench1__tiny"
    clone.parent.mkdir(parents=True)
    git("clone", "--no-checkout", two.as_uri(), str(clone))
    output = template / "bench1__tiny"
    (output / "snapshots").mkdir(parents=True)
    snapshot = f"snapshots/{first}.json"
    (output / snapshot).write_text("{}", encoding="utf-8")
    (output / "commits.json").write_text(
        json.dumps(
            {
                "repo_path": str(clone),
                "repo": "bench1__tiny",
                "commits": [{"sha": first}],
            }
        ),
        encoding="utf-8",
    )
    (output / "source.json").write_text(
        json.dumps({"url": "https://github.com/bench1/tiny", "max_commits": 1}),
        encoding="utf-8",
    )

    data = tmp_path / "run"
    copy_template(template, data, upstreams)
    target = data / "bench2__tiny"
    target_clone = data / "repos" / target.name
    index = json.loads((target / "commits.json").read_text(encoding="utf-8"))
    assert index["repo_path"] == str(target_clone)
    assert index["commits"] == [{"sha": first}]
    assert (
        json.loads((target / "source.json").read_text())["url"]
        == "https://github.com/bench2/tiny"
    )
    assert git("remote", "get-url", "origin", repo=target_clone) == two.as_uri()
    assert git("remote", "get-url", "origin", repo=clone) == two.as_uri()
    (target / snapshot).unlink()
    assert (output / snapshot).exists()

    trace = tmp_path / "git-trace.jsonl"
    env = {"GIT_TRACE2_EVENT": str(trace)}
    git("ls-remote", "--symref", two.as_uri(), "HEAD", extra_env=env)
    git("fetch", "origin", repo=target_clone, extra_env=env)
    fetches, starts = trace_git(trace, upstreams)
    assert fetches == 1
    assert len(starts["bench2__tiny"]) == 1


def test_result_schema_keeps_raw_samples() -> None:
    raw = {
        "variant": "manual_button",
        "size": "small",
        "repo_count": 1,
        "page_load_samples": [{"ms": 42.5}],
    }
    report = json.loads(
        json.dumps(make_result({"code_flow_sha": "abc"}, {"interval_s": 30}, {}, [raw]))
    )
    assert report["schema"] == SCHEMA
    assert report["finished_at_utc"].endswith("+00:00")
    assert report["runs"] == [raw]
    assert report["formulas"] == FORMULAS


def test_manual_page_sampling_starts_after_refresh_acceptance() -> None:
    sample = Event()

    def request(path: str, method: str) -> dict:
        assert path == "repos/bench1__tiny/refresh"
        assert method == "POST"
        assert not sample.is_set()
        return {"status": "queued"}

    assert (
        _manual_request(SimpleNamespace(request=request), "bench1__tiny", sample)[
            "status"
        ]
        == "queued"
    )
    assert sample.is_set()


def test_run_key_is_stable_and_covers_measurement_inputs() -> None:
    settings = {
        "code_flow_sha": "code",
        "interval": 2,
        "intervals": 3,
        "visits_per_hour": 12,
        "seed": 7,
        "flagsmith_sha": "upstream",
        "quick": True,
    }
    key = run_key(**settings)
    assert key == run_key(**{**settings, "interval": 2.0, "visits_per_hour": 12.0})
    for field, changed in {
        "code_flow_sha": "new code",
        "interval": 30,
        "intervals": 8,
        "visits_per_hour": 2,
        "seed": 8,
        "flagsmith_sha": None,
        "quick": False,
    }.items():
        assert key != run_key(**{**settings, field: changed})


def saved_case(case: Case, *, elapsed: float = 9) -> SavedCase:
    variant, size, count = case
    stats = {"n": 1, "p50": 1, "p95": 1}
    return SavedCase(
        {
            "variant": variant,
            "size": size,
            "repo_count": count,
            "suspended": False,
            "max_sample_gap_s": 1.2,
            "api_latency_ms": dict.fromkeys(("repos", "commits", "diff"), stats),
            "page_load_samples": [{"ms": 1, "during_sync": True}],
            "page_load_ms": stats,
            "freshness_s": stats,
            "elapsed_s": 6,
            "cpu_seconds": 0.05,
            "peak_rss_bytes": 3_000_000,
            "api_peak_rss_bytes": 1_000_000,
            "worker_peak_rss_bytes": 2_000_000,
            "counts": {
                "fetches": 2,
                "auto_runs": 3,
                "manual_runs": 2,
                "analysed_commits": 3,
            },
            "disk_growth_bytes": 1000,
            "per_hour": {"default_300s": {"cpu_ms": 500}},
            "default_300s_freshness_s": stats,
            "process_samples": [
                [0.0, 0.0, 3_000_000, 1_000_000, 2_000_000],
                [1.2, 0.05, 3_000_000, 1_000_000, 2_000_000],
            ],
        },
        {
            "os": "macOS",
            "cpu": "arm",
            "python": "3.12",
            "server_python": "3.11",
            "node": "22",
            "git": "git",
            "chrome": "Chrome",
            "browser_mode": "fresh contexts",
            "code_flow_sha": "code",
            "dirty": True,
        },
        {
            "commits": 8,
            "import_s": 1,
            "disk_bytes": 1000,
            "peak_rss_bytes": 3000,
            "api_peak_rss_bytes": 1000,
            "worker_peak_rss_bytes": 2000,
        },
        elapsed,
        "2026-11-27T05:00:00+00:00",
    )


def test_checkpoint_round_trip_and_atomic_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = CaseStore(tmp_path, "run-key")
    case = ("manual_button", "small", 1)
    original = saved_case(case)
    assert store.load(case) is None
    store.save(case, original)
    assert store.path(case) == tmp_path / "results/run-key/manual_button-small-1.json"
    assert store.load(case) == original
    assert json.loads(store.path(case).read_text())["suspended"] is False

    def interrupted(staged: Path, target: Path) -> None:
        assert staged.parent == target.parent
        assert store.load(case) == original
        raise InterruptedError

    monkeypatch.setattr(Path, "replace", interrupted)
    with pytest.raises(InterruptedError):
        store.save(case, replace(original, elapsed_s=99))
    assert store.load(case) == original
    assert list(store.directory.iterdir()) == [store.path(case)]


def test_new_sampling_version_separates_runs_and_templates(monkeypatch) -> None:
    settings = {
        "code_flow_sha": "same-head",
        "interval": 2,
        "intervals": 3,
        "visits_per_hour": 12,
        "seed": 7,
        "flagsmith_sha": None,
        "quick": True,
    }
    run = run_key(**settings)
    template = template_key("small", "start", 8, "same-head")
    monkeypatch.setattr(checkpoints, "PROCESS_SAMPLE_VERSION", 1)
    assert run_key(**settings) != run
    assert template_key("small", "start", 8, "same-head") != template


def test_skip_valid_checkpoints_and_remeasure_with_fresh(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    store = CaseStore(tmp_path, "run-key")
    good = ("manual_button", "small", 1)
    truncated = ("per_repo_toggle", "small", 1)
    mismatched = ("global_toggle", "small", 1)
    suspended = ("global_toggle", "small", 5)
    cases = [good, truncated, mismatched, suspended]
    store.save(good, saved_case(good))
    store.path(truncated).write_text('{"variant":', encoding="utf-8")
    store.save(mismatched, saved_case(good))
    record = saved_case(suspended)
    store.save(suspended, replace(record, result={**record.result, "suspended": True}))

    assert sync_benchmark.pending_cases(store, cases, fresh=False) == cases[1:]
    assert capsys.readouterr().out == "Reusing manual_button, small, 1 repo(s).\n"
    assert sync_benchmark.pending_cases(store, cases, fresh=True) == cases
    assert capsys.readouterr().out == ""
    assert CaseStore(tmp_path, "different-key").load(good) is None


def test_report_from_checkpoints_matches_in_memory_runs(tmp_path: Path) -> None:
    store = CaseStore(tmp_path, "run-key")
    cases = [("manual_button", "small", 1), ("per_repo_toggle", "medium", 5)]
    records = [saved_case(case) for case in cases]
    settings = {
        "sizes": ["small", "medium"],
        "quick": False,
        "interval_s": 30,
        "intervals": 8,
        "visits_per_repo_hour": 12,
        "seed": 7,
    }
    expected = make_result(
        records[0].environment,
        {**settings, "elapsed_s": 18},
        {case[1]: record.template for case, record in zip(cases, records)},
        [record.result for record in records],
        finished_at_utc=records[-1].finished_at_utc,
    )
    for case, record in reversed(list(zip(cases, records))):
        store.save(case, record)
    loaded = [store.load(case) for case in cases]
    assert all(record is not None for record in loaded)
    actual = report_from_cases(settings, loaded)
    assert actual == expected
    assert markdown(actual) == markdown(expected)

    name = "sync_mode-worker"
    raw, summary = write_report(actual, tmp_path, name)
    assert raw == tmp_path / f"{name}.json"
    assert summary == tmp_path / f"{name}.md"
    assert json.loads(raw.read_text())["runs"] == actual["runs"]
    assert "Worker tree peak RSS MiB | Combined peak RSS MiB" in summary.read_text()
    assert summary.read_text() == markdown(actual)


def test_suspension_detection_uses_both_clocks_and_sample_gaps() -> None:
    clocks = SimpleNamespace(wall=1000.0, steady=20.0)
    check = SuspensionCheck(lambda: clocks.wall, lambda: clocks.steady)
    clocks.wall += 3
    clocks.steady += 3
    assert check.check([1000, 1001, 1002, 1003], [1000, 1001.5, 1003]) == 1.5
    clocks.wall += 7200
    with pytest.raises(Suspended, match="clocks diverged by 7200"):
        check.check()
    clocks.steady += 7200
    with pytest.raises(Suspended, match="sampling paused for 12"):
        check.check([1000, 1001, 1013], [1000, 1001])
    clocks.wall -= 4
    with pytest.raises(Suspended, match="clocks diverged by 4"):
        check.check()


@pytest.mark.parametrize("suspensions", [1, 2])
def test_suspended_case_retries_once_without_saving_invalid_results(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, suspensions: int
) -> None:
    case = ("manual_button", "small", 1)
    store = CaseStore(tmp_path, "run-key")
    record = saved_case(case)
    args = sync_benchmark.parse_args(["--quick", "--workdir", str(tmp_path)])
    attempts = []
    monkeypatch.setattr(sync_benchmark, "development_key", lambda: "fixture")
    monkeypatch.setattr(sync_benchmark, "web_server", lambda *_: nullcontext("web"))
    monkeypatch.setattr(sync_benchmark, "chrome", lambda *_: nullcontext(object()))
    monkeypatch.setattr(sync_benchmark, "_environment", lambda *_: record.environment)
    monkeypatch.setattr(
        sync_benchmark,
        "_prepare_template",
        lambda *_: (None, tmp_path, {"python": "3.11"}),
    )

    def measure(*_):
        assert store.load(case) is None
        attempts.append(case)
        if len(attempts) <= suspensions:
            raise Suspended("process sampling paused")
        return record.result

    monkeypatch.setattr(sync_benchmark, "_measure_case", measure)
    if suspensions == 2:
        with pytest.raises(RuntimeError, match="invalid twice"):
            sync_benchmark._measure_pending(args, store, [case], None, "code")
        assert store.load(case) is None
    else:
        sync_benchmark._measure_pending(args, store, [case], None, "code")
        assert store.load(case).result == record.result
    assert attempts == [case, case]


def test_template_reuse_requires_matching_key(tmp_path: Path) -> None:
    history = History(tmp_path, "tiny", "", 8, "base", ("next",))
    imports = []

    def build(data: Path) -> dict:
        imports.append(data)
        (data / "repos/bench1__tiny/.git").mkdir(parents=True)
        output = data / "bench1__tiny"
        (output / "snapshots").mkdir(parents=True)
        for name in ("source.json", "commits.json", "snapshots/base.json"):
            (output / name).write_text("{}", encoding="utf-8")
        return {"start_sha": "base", "commits": 8}

    first = cached_template(tmp_path, "small", history, "code", build)
    assert first == cached_template(tmp_path, "small", history, "code", build)
    assert (
        first[0]
        == tmp_path / "templates" / template_key("small", "base", 8, "code") / "data"
    )
    assert len(imports) == 1
    assert first != cached_template(tmp_path, "small", history, "new code", build)
    assert len(imports) == 2
    assert (
        len(
            {
                template_key("small", "base", 8, "code"),
                template_key("medium", "base", 8, "code"),
                template_key("small", "different base", 8, "code"),
                template_key("small", "base", 50, "code"),
            }
        )
        == 4
    )


def test_sample_tree_aggregates_live_descendants_and_simultaneous_peak() -> None:
    children = {1: [2, 4, 2], 2: [3]}
    usage = {
        1: ProcessUsage(0.25, 100),
        2: ProcessUsage(1.5, 175),
        3: ProcessUsage(0.5, 25),
        5: ProcessUsage(7, 400),  # Unrelated to this API.
    }
    first = sample_tree(1, lambda pid: children.get(pid, []), usage.get)
    assert first.cpu_seconds == 2.25
    assert (first.api_rss_bytes, first.worker_rss_bytes, first.combined_rss_bytes) == (
        100,
        200,
        300,
    )

    second = first._replace(
        at=first.at + 1,
        cpu_seconds=2.75,
        api_rss_bytes=250,
        worker_rss_bytes=40,
    )
    assert peak_rss([first, second]) == {
        "api_peak_rss_bytes": 250,
        "worker_peak_rss_bytes": 200,
        "peak_rss_bytes": 300,
    }
    assert window_samples([first, second], first.at, second.at) == (0.5, 1.0)


def test_host_sampler_reads_live_child_and_retains_reaped_cpu() -> None:
    _, sample = tree_sampler(os.getpid())
    before = sample()
    program = """
from sys import stdin
from time import process_time
until = process_time() + 0.08
while process_time() < until:
    pass
print("ready", flush=True)
stdin.read()
"""
    with subprocess.Popen(
        [sys.executable, "-c", program],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    ) as child:
        assert child.stdout.readline().strip() == "ready"
        live = sample()
        child.stdin.close()
        assert child.wait(timeout=5) == 0

    reaped = sample()
    assert live.worker_rss_bytes > before.worker_rss_bytes
    assert reaped.worker_rss_bytes == before.worker_rss_bytes
    assert live.cpu_seconds - before.cpu_seconds >= 0.07
    assert reaped.cpu_seconds - before.cpu_seconds >= 0.07


def test_report_name_defaults_to_utc_and_protects_existing_reports(tmp_path: Path) -> None:
    base_args = ["--quick", "--workdir", str(tmp_path)]
    utc_before = datetime.now(UTC).date()
    default_name = sync_benchmark.parse_args(base_args).report_name
    assert default_name in {f"sync_mode-{date}" for date in (utc_before, datetime.now(UTC).date())}
    assert (
        sync_benchmark.parse_args([*base_args, "--report-name", "worker-2"]).report_name
        == "worker-2"
    )

    with pytest.raises(ValueError, match="filename stem"):
        report_paths(tmp_path, "../escape")
    raw = tmp_path / "sync_mode-2026-11-27.json"
    raw.write_text("baseline", encoding="utf-8")
    with pytest.raises(ValueError, match="already exists"):
        write_report({}, tmp_path, "sync_mode-2026-11-27")
    assert raw.read_text(encoding="utf-8") == "baseline"
