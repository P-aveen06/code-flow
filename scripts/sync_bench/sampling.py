"""Collect process, Chrome and Git trace measurements outside the application."""

import json
import os
import signal
import subprocess
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from datetime import datetime
from pathlib import Path
from threading import Event, Thread
from time import time

from sync_bench.process_tree import ProcessSample, tree_sampler
from sync_bench.runtime import RunningApi, stop_process_group
from sync_bench.suspension import SuspensionCheck
from sync_bench.workspace import ROOT


class ProcessSamples:
    def __init__(self, server: RunningApi) -> None:
        self.method, self.sample = tree_sampler(server.pid)
        self.stop = Event()
        self.started = time()
        self.raw: list[ProcessSample] = []
        self.error: OSError | None = None

    def run(self) -> None:
        while not self.stop.is_set():
            try:
                self.raw.append(self.sample())
            except OSError as exc:
                self.error = exc
                return
            self.stop.wait(1)

    def check_suspension(
        self, check: SuspensionCheck, raw: list[ProcessSample] | None = None
    ) -> float:
        samples = self.raw.copy() if raw is None else raw
        return check.check([self.started, *(row.at for row in samples), time()])

    def collect(self) -> tuple[str, list[ProcessSample]]:
        if self.error is not None:
            raise RuntimeError("Could not sample the benchmark API process tree.") from self.error
        return self.method, self.raw.copy()


@contextmanager
def process_samples(
    server: RunningApi, suspension: SuspensionCheck | None = None
) -> Iterator[ProcessSamples]:
    samples = ProcessSamples(server)
    thread = Thread(target=samples.run)
    try:
        thread.start()
        yield samples
    except Exception:
        if suspension is not None:
            samples.check_suspension(suspension)
        raise
    finally:
        samples.stop.set()
        if thread.ident is not None:
            thread.join()


def read_json_lines(path: Path) -> list:
    if not path.exists():
        return []
    # A writer can still be appending. Only consume complete lines.
    lines = path.read_bytes().splitlines(keepends=True)
    return [json.loads(line) for line in lines if line.endswith(b"\n")]


def window_samples(samples: list[ProcessSample], start: float, end: float) -> tuple[float, float]:
    before = [sample for sample in samples if sample.at <= start]
    after = [sample for sample in samples if sample.at >= end]
    first = before[-1] if before else samples[0]
    last = after[0] if after else samples[-1]
    if last.at <= first.at:
        raise RuntimeError("The measurement was too short to sample server CPU.")
    return last.cpu_seconds - first.cpu_seconds, last.at - first.at


class Chrome:
    def __init__(self, process: subprocess.Popen) -> None:
        self.process = process
        details = self._receive()
        self.version = details["browser"]
        self.mode = details["mode"]
        self.pid = details["pid"]

    def _receive(self) -> dict:
        assert self.process.stdout is not None
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("The Chrome benchmark worker exited without a measurement.")
        response = json.loads(line)
        if "error" in response:
            raise RuntimeError(response["error"])
        return response

    def measure(self, origin: str, variant: str, repos: int) -> dict:
        assert self.process.stdin is not None
        self.process.stdin.write(
            json.dumps({"url": f"{origin}/?sync={variant}", "variant": variant, "repos": repos})
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
        raise ValueError("Set CODEFLOW_CHROME_PATH to the system Chrome or Chromium executable.")
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
        browser = None
        try:
            browser = Chrome(process)
            yield browser
            if process.stdin:
                process.stdin.close()
            with suppress(subprocess.TimeoutExpired):
                process.wait(timeout=5)
        finally:
            try:
                # The worker handles SIGINT and reaps its detached browser.
                stop_process_group(process, signal.SIGINT)
            finally:
                if browser is not None:
                    with suppress(ProcessLookupError, PermissionError):
                        os.killpg(browser.pid, signal.SIGKILL)


def trace_git(path: Path, upstreams: dict[str, Path]) -> tuple[int, dict[str, list[float]]]:
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
