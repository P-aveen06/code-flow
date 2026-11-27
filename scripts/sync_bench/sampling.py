"""Collect process, Chrome and Git trace measurements outside the application."""

import json
import os
import subprocess
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from threading import Event, Thread
from time import time

from sync_bench.runtime import RunningApi
from sync_bench.workspace import ROOT


def cpu_time(value: str) -> float:
    """Parse both macOS M:SS.hh and Linux [DD-]HH:MM:SS output."""
    days, separator, clock = value.partition("-")
    if not separator:
        clock, days = days, "0"
    seconds = float(days) * 86400
    for place, part in enumerate(reversed(clock.split(":"))):
        seconds += float(part) * 60**place
    return seconds


class ProcessSamples:
    def __init__(self, server: RunningApi) -> None:
        self.server = server
        self.stop = Event()
        self.raw: list[list[float]] = []

    def _sample_ps(self) -> None:
        while not self.stop.is_set():
            try:
                result = subprocess.run(
                    ["ps", "-o", "time=,rss=", "-p", str(self.server.pid)],
                    capture_output=True,
                    text=True,
                    timeout=2,
                    check=True,
                )
                cpu, rss = result.stdout.split()
            except (OSError, ValueError, subprocess.SubprocessError):
                return
            self.raw.append([time(), cpu_time(cpu), int(rss) * 1024])
            self.stop.wait(1)

    def collect(self) -> tuple[str, list[list[float]]]:
        fallback = read_json_lines(self.server.resources)
        # Use rusage if the host denies ps, or if ps is too coarse to resolve short runs.
        if len(self.raw) >= 2 and sys.platform != "linux":
            return "ps time and RSS", self.raw.copy()
        if len(self.raw) >= 2 and any(sample[1] % 1 for sample in self.raw):
            return "ps time and RSS", self.raw.copy()
        return "getrusage(RUSAGE_SELF) CPU and RSS high-water mark", fallback


@contextmanager
def process_samples(server: RunningApi) -> Iterator[ProcessSamples]:
    samples = ProcessSamples(server)
    thread = Thread(target=samples._sample_ps)
    thread.start()
    try:
        yield samples
    finally:
        samples.stop.set()
        thread.join()


def read_json_lines(path: Path) -> list:
    if not path.exists():
        return []
    # A writer can still be appending. Only consume complete lines.
    lines = path.read_bytes().splitlines(keepends=True)
    return [json.loads(line) for line in lines if line.endswith(b"\n")]


def window_samples(
    samples: list[list[float]], start: float, end: float
) -> tuple[float, float]:
    before = [sample for sample in samples if sample[0] <= start]
    after = [sample for sample in samples if sample[0] >= end]
    first = before[-1] if before else samples[0]
    last = after[0] if after else samples[-1]
    if last[0] <= first[0]:
        raise RuntimeError("The measurement was too short to sample server CPU.")
    return last[1] - first[1], last[0] - first[0]


class Chrome:
    def __init__(self, process: subprocess.Popen) -> None:
        self.process = process
        details = self._receive()
        self.version = details["browser"]
        self.mode = details["mode"]

    def _receive(self) -> dict:
        assert self.process.stdout is not None
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(
                "The Chrome benchmark worker exited without a measurement."
            )
        response = json.loads(line)
        if "error" in response:
            raise RuntimeError(response["error"])
        return response

    def measure(self, origin: str, variant: str, repos: int) -> dict:
        assert self.process.stdin is not None
        self.process.stdin.write(
            json.dumps(
                {"url": f"{origin}/?sync={variant}", "variant": variant, "repos": repos}
            )
            + "\n"
        )
        self.process.stdin.flush()
        row = self._receive()
        return {"ms": row["ms"], "navigation": row["navigation"] / 1000}


@contextmanager
def chrome(directory: Path) -> Iterator[Chrome]:
    path = os.environ.get(
        "CODEFLOW_CHROME_PATH",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    )
    if not Path(path).is_file():
        raise ValueError(
            "Set CODEFLOW_CHROME_PATH to the system Chrome or Chromium executable."
        )
    with subprocess.Popen(
        [
            "node",
            str(ROOT / "web/sync-benchmark-browser.mjs"),
            str(directory / "chrome"),
        ],
        cwd=directory,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        start_new_session=True,
    ) as process:
        try:
            yield Chrome(process)
        finally:
            if process.stdin:
                process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, 9)
                process.wait()


def trace_git(
    path: Path, upstreams: dict[str, Path]
) -> tuple[int, dict[str, list[float]]]:
    ids = {upstream.as_uri(): repo for repo, upstream in upstreams.items()}
    starts: dict[str, list[float]] = {repo: [] for repo in upstreams}
    fetches = 0
    for event in read_json_lines(path):
        if event["event"] == "cmd_name" and event["hierarchy"] == "fetch":
            fetches += 1
        if event["event"] == "start" and "ls-remote" in event["argv"]:
            index = event["argv"].index("ls-remote")
            url = event["argv"][index + 2]  # ls-remote --symref URL HEAD
            if url in ids:
                started = datetime.fromisoformat(event["time"]).timestamp()
                starts[ids[url]].append(started)
    return fetches, starts
