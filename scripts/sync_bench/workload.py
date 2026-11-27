"""Generate the benchmark's seeded upstream and reviewer schedules."""

import math
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from random import Random
from threading import Event
from time import monotonic, sleep, time

from sync_bench.metrics import DEFAULT_INTERVAL
from sync_bench.runtime import Api
from sync_bench.workspace import History, advance_upstream


@dataclass(frozen=True)
class Workload:
    variant: str
    size: str
    repo_count: int
    interval: float
    intervals: int
    visits_per_hour: float
    seed: int


@dataclass(frozen=True)
class Advance:
    repo: str
    sha: str
    at: float


def followed_repos(variant: str, repos: list[str]) -> list[str]:
    if variant == "global_toggle":
        return repos
    if variant == "per_repo_toggle":
        return repos[:2]
    return []


def _manual_request(api: Api, repo: str, page_now: Event) -> dict:
    start = time()
    response = api.request(f"repos/{repo}/refresh", "POST")
    page_now.set()
    return {"repo": repo, "at": start, "status": response["status"]}


def run_schedule(
    api: Api,
    upstreams: dict[str, Path],
    history: History,
    workload: Workload,
    manual: list[str],
    all_visible: Event,
    worker: ThreadPoolExecutor,
    background: tuple[Future, ...],
    page_now: Event,
) -> tuple[list[Advance], list[dict]]:
    rng = Random(workload.seed)
    duration = workload.interval * workload.intervals
    visits_period = (
        workload.interval * (3600 / workload.visits_per_hour) / DEFAULT_INTERVAL
    )
    events = [
        (workload.interval * (index + rng.random()), "", sha)
        for index, sha in enumerate(history.advances)
    ]
    for repo in manual:
        phase = Random(f"{workload.seed}:{repo}:visit").uniform(0, visits_period)
        for index in range(math.ceil(duration / visits_period) + 1):
            events.append((phase + index * visits_period, repo, ""))
    events.sort()
    starts = monotonic()
    previous = history.start
    advances = []
    visits = []
    for offset, repo, sha in events:
        if offset < duration:
            _wait_until(starts + offset, background)
        else:
            while not all_visible.is_set() and monotonic() < starts + offset:
                check_running(background)
                all_visible.wait(min(0.2, max(0, starts + offset - monotonic())))
            if all_visible.is_set():
                break
        if repo:
            visits.append(worker.submit(_manual_request, api, repo, page_now))
        else:
            for repo_id, upstream in upstreams.items():
                advance_upstream(upstream, sha, previous)
                advances.append(Advance(repo_id, sha, time()))
            previous = sha
    deadline = starts + duration + max(workload.interval, visits_period) + 90
    while monotonic() < starts + duration or not all_visible.is_set():
        check_running(background)
        if monotonic() >= deadline:
            raise RuntimeError(
                "Some upstream advances never became visible through /commits."
            )
        sleep(0.1)
    return advances, [visit.result() for visit in visits]


def check_running(futures: tuple[Future, ...]) -> None:
    for future in futures:
        if future.done():
            future.result()


def _wait_until(deadline: float, background: tuple[Future, ...]) -> None:
    while monotonic() < deadline:
        check_running(background)
        sleep(min(0.2, max(0, deadline - monotonic())))
