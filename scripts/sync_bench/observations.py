"""Observe the API, commit index publications and freshness."""

import json
from pathlib import Path
from random import Random
from threading import Event
from time import monotonic, time

from sync_bench.metrics import wait_window_seconds
from sync_bench.runtime import Api
from sync_bench.workload import Advance, Workload


class Publications:
    """Observe atomic index swaps independently of possibly slow API requests."""

    def __init__(self, data: Path, repos: list[str], advances: tuple[str, ...]) -> None:
        self.indexes = {repo: data / repo / "commits.json" for repo in repos}
        self.expected = set(advances)
        self.first_visible: dict[tuple[str, str], float] = {}
        self.stamps: dict[str, set[float]] = {repo: set() for repo in repos}

    def poll(self, stop: Event) -> None:
        while not stop.is_set():
            for repo, index in self.indexes.items():
                try:
                    stamp = index.stat().st_mtime
                    if stamp in self.stamps[repo]:
                        continue
                    data = json.loads(index.read_bytes())
                    if stamp != index.stat().st_mtime:
                        continue
                except FileNotFoundError:
                    # The importer briefly moves the previous directory aside.
                    continue
                self.stamps[repo].add(stamp)
                for commit in data["commits"]:
                    sha = commit["sha"]
                    if sha in self.expected:
                        self.first_visible.setdefault((repo, sha), stamp)
            stop.wait(0.025)


class Probes:
    def __init__(self, api: Api, repos: list[str], advances: tuple[str, ...]) -> None:
        self.api = api
        self.repos = repos
        self.expected: set[tuple[str, str]] = {
            (repo, sha) for repo in repos for sha in advances
        }
        self.visible: dict[tuple[str, str], float] = {}
        self.latencies: dict[str, list[list]] = {"repos": [], "commits": [], "diff": []}
        self.ready = Event()

    def _read(
        self, kind: str, path: str, repo: str | None = None
    ) -> tuple[object, float]:
        started = monotonic()
        payload = self.api.request(path)
        received = time()
        self.latencies[kind].append([received, repo, (monotonic() - started) * 1000])
        return payload, received

    def samples(self, epoch: float) -> dict[str, list[list]]:
        return {
            endpoint: [
                [round(at - epoch, 3), repo, round(ms, 3)] for at, repo, ms in rows
            ]
            for endpoint, rows in self.latencies.items()
        }

    def poll(self, stop: Event) -> None:
        """Poll every repo's freshness, with one newest diff request per cycle."""
        turn = 0
        while not stop.is_set():
            started = monotonic()
            repos, _ = self._read("repos", "repos")
            if any(repo["status"] == "error" for repo in repos):
                raise RuntimeError("A benchmark repository refresh failed.")
            for repo in self.repos:
                result, received = self._read("commits", f"repos/{repo}/commits", repo)
                commits = result["commits"]
                for commit in commits:
                    key = repo, commit["sha"]
                    if key in self.expected and key not in self.visible:
                        self.visible[key] = received
                if repo == self.repos[turn % len(self.repos)]:
                    head = commits[-1]["sha"]
                    self._read("diff", f"repos/{repo}/diff?head={head}", repo)
            if self.expected == self.visible.keys():
                self.ready.set()
            turn += 1
            stop.wait(max(0, 0.5 - (monotonic() - started)))


def freshness(
    advances: list[Advance],
    visible: dict[tuple[str, str], float],
    publications: Publications,
    starts: dict[str, list[float]],
    visits: list[dict],
    auto: list[str],
    workload: Workload,
    epoch: float,
) -> list[dict]:
    rng = Random(workload.seed)
    output = []
    for advance in advances:
        key = (advance.repo, advance.sha)
        seen = visible[key]
        published = min(seen, publications.first_visible.get(key, seen))
        candidates = [
            started for started in starts[advance.repo] if started <= published
        ]
        if not candidates:
            raise RuntimeError(
                "A newly visible commit could not be matched to a Git refresh."
            )
        started = max(candidates)
        automatic = advance.repo in auto
        if not automatic:
            started = max(
                visit["at"]
                for visit in visits
                if visit["repo"] == advance.repo
                and visit["status"] == "queued"
                and visit["at"] <= started
            )
        detection = min(seen, max(started, advance.at))
        wait = detection - advance.at
        measured = seen - detection
        scaled_wait = rng.uniform(
            0, wait_window_seconds(automatic, workload.visits_per_hour)
        )
        output.append(
            {
                "repo": advance.repo,
                "sha": advance.sha,
                "mode": "auto" if automatic else "manual",
                "advanced_at_s": round(advance.at - epoch, 3),
                "refresh_at_s": round(started - epoch, 3),
                "visible_at_s": round(seen - epoch, 3),
                "elapsed_s": round(seen - advance.at, 3),
                "wait_s": round(wait, 3),
                "detection_to_visible_s": round(measured, 3),
                "simulated_default_wait_s": round(scaled_wait, 3),
                "default_300s_freshness_s": round(measured + scaled_wait, 3),
            }
        )
    return output


def page_samples(
    rows: list[dict],
    starts: dict[str, list[float]],
    publications: dict[str, set[float]],
    epoch: float,
) -> list[dict]:
    windows = []
    for repo, attempts in starts.items():
        for index, started in enumerate(attempts):
            end = min(
                (stamp for stamp in publications[repo] if stamp >= started), default=0
            )
            if end and (index + 1 == len(attempts) or end <= attempts[index + 1]):
                windows.append((started, end))
    return [
        {
            "at_s": round(row["navigation"] - epoch, 3),
            "ms": round(row["ms"], 3),
            "during_sync": any(
                start <= row["navigation"] + row["ms"] / 1000
                and end >= row["navigation"]
                for start, end in windows
            ),
        }
        for row in rows
    ]
