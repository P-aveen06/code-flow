"""Check the benchmark's pure calculations, private paths and local Git fixtures."""

import json
import sys
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sync_bench.metrics import (
    FORMULAS,
    SCHEMA,
    percentile,
    scale_hourly,
    wait_window_seconds,
)
from sync_bench.report import make_result
from sync_bench.sampling import cpu_time, trace_git
from sync_bench.workload import _manual_request
from sync_bench.workspace import (
    History,
    advance_upstream,
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
    assert cpu_time("2:03.57") == pytest.approx(123.57)
    assert cpu_time("1-01:02:03") == 90123


def test_private_ports_and_workdir(tmp_path: Path) -> None:
    repo = tmp_path / "app"
    data = repo / "data"
    data.mkdir(parents=True)
    link = tmp_path / "shortcut"
    link.symlink_to(data)
    for port in (5173, 8787, -1):
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
