"""Drive isolated benchmark cases and summarize their observations."""

from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from threading import Event
from time import monotonic, sleep, time

from sync_bench.metrics import COUNTERS, distribution, scale_hourly
from sync_bench.observations import Probes, Publications, freshness, page_samples
from sync_bench.runtime import Api, RunningApi
from sync_bench.sampling import Chrome, process_samples, trace_git, window_samples
from sync_bench.suspension import SuspensionCheck
from sync_bench.workload import Workload, check_running, followed_repos, run_schedule
from sync_bench.workspace import History, disk_bytes, fake_url, snapshot_names

ACTIVE = {"queued", "cloning", "analyzing"}


def import_template(
    server: RunningApi, data: Path, repo: str, history: History
) -> dict:
    started = monotonic()
    server.api.request(
        "repos",
        "POST",
        {"url": fake_url(repo), "subdir": history.subdir, "max_commits": history.limit},
    )
    with process_samples(server) as measure:
        while monotonic() - started < 900:
            status = server.api.request(f"repos/{repo}/status")
            if status["status"] == "error":
                raise RuntimeError(
                    f"Template import failed for {repo}: {status['error']}"
                )
            if status["status"] == "ready":
                duration = monotonic() - started
                break
            sleep(0.25)
        else:
            raise RuntimeError(f"Template import timed out for {repo}.")
        sleep(1)
        method, samples = measure.collect()
    return {
        "repo": repo,
        "python": server.python_file.read_text(encoding="utf-8"),
        "subdir": history.subdir,
        "start_sha": history.start,
        "commits": status["total"],
        "import_s": round(duration, 3),
        "peak_rss_bytes": max(row[2] for row in samples),
        "disk_bytes": disk_bytes(data),
        "process_sample_method": method,
        "process_samples": _round_process(samples),
    }


def _round_process(samples: list[list[float]]) -> list[list[float]]:
    return [[round(at, 3), round(cpu, 6), rss] for at, cpu, rss in samples]


def _browser_samples(
    chrome: Chrome,
    origin: str,
    workload: Workload,
    stop: Event,
    rows: list[dict],
    spacing: float,
    page_now: Event,
) -> None:
    while not stop.is_set():
        started = monotonic()
        timing = chrome.measure(origin, workload.variant, workload.repo_count)
        rows.append(timing)
        page_now.wait(max(0, spacing - (monotonic() - started)))
        page_now.clear()


def _drain(api: Api, check_suspension: Callable[[], float]) -> dict:
    deadline = monotonic() + 90
    while monotonic() < deadline:
        check_suspension()
        repos = api.request("repos")
        if any(repo["status"] == "error" for repo in repos):
            raise RuntimeError("A benchmark repository refresh failed.")
        if not any(repo["status"] in ACTIVE for repo in repos):
            status = api.request("auto-sync")["status"]
            if any(repo["last_result"] == "error" for repo in status.values()):
                raise RuntimeError("The auto-sync API reported a refresh error.")
            return status
        sleep(0.1)
    raise RuntimeError("The final refresh jobs did not drain in time.")


@contextmanager
def _case_workers() -> Iterator[ThreadPoolExecutor]:
    pool = ThreadPoolExecutor(max_workers=4)
    try:
        yield pool
    except BaseException:
        # Let the API and Chrome contexts close before waiting on blocked requests.
        pool.shutdown(wait=False, cancel_futures=True)
        raise
    else:
        pool.shutdown()


def run_case(
    server: RunningApi,
    chrome: Chrome,
    origin: str,
    data: Path,
    upstreams: dict[str, Path],
    history: History,
    workload: Workload,
    suspension: SuspensionCheck,
) -> dict:
    repos = list(upstreams)
    auto = followed_repos(workload.variant, repos)
    manual = [repo for repo in repos if repo not in auto]
    before_bytes = disk_bytes(data)
    initial_snapshots = snapshot_names(data, repos)
    with process_samples(server, suspension) as samples, _case_workers() as pool:

        def check_suspension() -> float:
            return samples.check_suspension(suspension)

        baseline = Probes(Api(server.api.port), repos, ())
        baseline_stop = Event()
        baseline_page_now = Event()
        baseline_rows: list[dict] = []
        try:
            probe = pool.submit(baseline.poll, baseline_stop)
            # Let the real commits endpoint populate its lazy caches before measuring idle.
            while not baseline.ready.wait(0.2):
                check_suspension()
                check_running((probe,))
            baseline_begin = time()
            browser = pool.submit(
                _browser_samples,
                chrome,
                origin,
                workload,
                baseline_stop,
                baseline_rows,
                workload.interval / 2,
                baseline_page_now,
            )
            sleep(max(4, workload.interval / 2))
        finally:
            baseline_stop.set()
            baseline_page_now.set()
        probe.result()
        browser.result()
        baseline_end = time()
        check_suspension()
        sleep(1)

        stop = Event()
        probes = Probes(baseline.api, repos, history.advances)
        browser_rows: list[dict] = []
        publications = Publications(data, repos, history.advances)
        page_now = Event()
        try:
            watcher = pool.submit(publications.poll, stop)
            epoch = time()
            background = (
                watcher,
                pool.submit(probes.poll, stop),
                pool.submit(
                    _browser_samples,
                    chrome,
                    origin,
                    workload,
                    stop,
                    browser_rows,
                    workload.interval / 2,
                    page_now,
                ),
            )

            def check_background() -> None:
                check_suspension()
                check_running(background)

            server.api.request(
                "auto-sync",
                "PUT",
                {
                    "all": workload.variant == "global_toggle",
                    "repos": dict.fromkeys(auto, True)
                    if workload.variant == "per_repo_toggle"
                    else {},
                },
            )
            advances, visits = run_schedule(
                Api(server.api.port),
                upstreams,
                history,
                workload,
                manual,
                probes.ready,
                pool,
                check_background,
                page_now,
            )
            server.api.request(
                "auto-sync", "PUT", {"all": False, "repos": dict.fromkeys(auto, False)}
            )
            stats = _drain(server.api, check_suspension)
        finally:
            stop.set()
            page_now.set()
        for future in background:
            future.result()
        end = time()
        sleep(1.1)
        method, raw_process = samples.collect()
        max_sample_gap = samples.check_suspension(suspension, raw_process)

    cpu, cpu_elapsed = window_samples(raw_process, epoch, end)
    idle_cpu, idle_elapsed = window_samples(raw_process, baseline_begin, baseline_end)
    fetches, starts = trace_git(server.trace, upstreams)
    auto_runs = sum(row["runs"] for row in stats.values())
    auto_fetches = sum(row["fetches"] for row in stats.values())
    auto_analysed = sum(row["analysed_commits"] for row in stats.values())
    manual_runs = sum(row["manual_runs"] for row in stats.values())
    analysed = len(snapshot_names(data, repos) - initial_snapshots)
    counters = dict(
        zip(COUNTERS, (fetches, auto_runs, manual_runs, analysed, len(advances)))
    )
    if not browser_rows:
        raise RuntimeError("Chrome captured no landing page samples.")
    pages = page_samples(browser_rows, starts, publications.stamps, epoch)
    fresh = freshness(
        advances, probes.visible, publications, starts, visits, auto, workload, epoch
    )
    rates = scale_hourly(
        counters=counters,
        elapsed=end - epoch,
        cpu_seconds=cpu,
        cpu_elapsed=cpu_elapsed,
        idle_cpu_per_hour=idle_cpu * 3600 / idle_elapsed,
        auto_repos=len(auto),
        manual_repos=len(manual),
        visits_per_hour=workload.visits_per_hour,
    )
    return {
        "variant": workload.variant,
        "size": workload.size,
        "repo_count": len(repos),
        "suspended": False,
        "max_sample_gap_s": round(max_sample_gap, 3),
        "auto_repos": auto,
        "manual_repos": manual,
        "epoch_utc_s": round(epoch, 3),
        "elapsed_s": round(end - epoch, 3),
        "cpu_elapsed_s": round(cpu_elapsed, 3),
        "cpu_seconds": round(cpu, 6),
        "peak_rss_bytes": max(
            row[2] for row in raw_process if epoch - 1 <= row[0] <= end + 1
        ),
        "disk_start_bytes": before_bytes,
        "disk_growth_bytes": disk_bytes(data) - before_bytes,
        "baseline": {
            "at_s": round(baseline_begin - epoch, 3),
            "end_s": round(baseline_end - epoch, 3),
            "cpu_seconds": round(idle_cpu, 6),
            "cpu_elapsed_s": round(idle_elapsed, 3),
            "page_load_samples": page_samples(baseline_rows, {}, {}, epoch),
            "api_samples": baseline.samples(epoch),
        },
        "counts": {
            **counters,
            "auto_fetches": auto_fetches,
            "auto_analysed_commits": auto_analysed,
            "manual_fetches": fetches - auto_fetches,
            "manual_analysed_commits": analysed - auto_analysed,
            "manual_requests": len(visits),
        },
        "auto_sync_status": stats,
        "per_hour": rates,
        "page_load_samples": pages,
        "page_load_ms": distribution([row["ms"] for row in pages]),
        "freshness_samples": fresh,
        "freshness_s": distribution([row["elapsed_s"] for row in fresh]),
        "default_300s_freshness_s": distribution(
            [row["default_300s_freshness_s"] for row in fresh]
        ),
        "api_latency_ms": {
            endpoint: distribution([row[2] for row in rows])
            for endpoint, rows in probes.latencies.items()
        },
        "api_samples": probes.samples(epoch),
        "git_refresh_starts_s": {
            repo: [round(at - epoch, 3) for at in rows] for repo, rows in starts.items()
        },
        "index_publications_s": {
            repo: [round(at - epoch, 3) for at in sorted(rows) if at >= epoch]
            for repo, rows in publications.stamps.items()
        },
        "manual_visits": [
            {**visit, "at": round(visit["at"] - epoch, 3)} for visit in visits
        ],
        "process_sample_method": method,
        "process_samples": _round_process(raw_process),
    }
