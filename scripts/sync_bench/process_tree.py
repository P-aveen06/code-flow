"""Read cumulative CPU and live RSS for a process and all of its descendants."""

import ctypes
import os
import sys
from collections.abc import Callable
from pathlib import Path
from time import time
from typing import NamedTuple


class ProcessUsage(NamedTuple):
    cpu_seconds: float
    rss_bytes: int


class ProcessSample(NamedTuple):
    at: float
    cpu_seconds: float
    api_rss_bytes: int
    worker_rss_bytes: int

    @property
    def combined_rss_bytes(self) -> int:
        return self.api_rss_bytes + self.worker_rss_bytes


def sample_tree(
    api_pid: int,
    children: Callable[[int], list[int]],
    usage: Callable[[int], ProcessUsage | None],
) -> ProcessSample:
    api = usage(api_pid)
    if api is None:
        raise ProcessLookupError(f"Benchmark API process {api_pid} disappeared.")
    cpu = api.cpu_seconds
    worker_rss = 0
    pending = children(api_pid)
    seen = {api_pid}
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        child = usage(pid)
        if child is not None:
            cpu += child.cpu_seconds
            worker_rss += child.rss_bytes
            pending.extend(children(pid))
    return ProcessSample(time(), cpu, api.rss_bytes, worker_rss)


def _linux_children(pid: int) -> list[int]:
    # Git and the analysis worker can be launched by threads other than the leader.
    children = []
    for path in Path(f"/proc/{pid}/task").glob("*/children"):
        try:
            children.extend(map(int, path.read_text().split()))
        except (FileNotFoundError, ProcessLookupError):
            continue
    return children


def _linux_usage(pid: int, ticks: int, page_size: int) -> ProcessUsage | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(errors="replace")
    except (FileNotFoundError, ProcessLookupError):
        return None
    # The command name can contain spaces and parentheses. The remaining fields start at field 3.
    fields = stat.rsplit(")", 1)[1].split()
    # Include CPU from waited-for children so short Git commands and retired workers count.
    cpu = sum(map(int, fields[11:15])) / ticks
    return ProcessUsage(cpu, int(fields[21]) * page_size)


class _RusageInfoV1(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64)
        for name in (
            "user_time",
            "system_time",
            "pkg_idle_wkups",
            "interrupt_wkups",
            "pageins",
            "wired_size",
            "resident_size",
            "phys_footprint",
            "proc_start_abstime",
            "proc_exit_abstime",
            "child_user_time",
            "child_system_time",
            "child_pkg_idle_wkups",
            "child_interrupt_wkups",
            "child_pageins",
            "child_elapsed_abstime",
        )
    ]


class _MachTimebaseInfo(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


class _MacProcesses:
    def __init__(self) -> None:
        self.libproc = ctypes.CDLL("libproc.dylib")
        timebase = _MachTimebaseInfo()
        if ctypes.CDLL(None).mach_timebase_info(ctypes.byref(timebase)) != 0:
            raise RuntimeError("Could not read the macOS CPU timebase.")
        self.seconds_per_tick = timebase.numer / timebase.denom / 1e9

    def children(self, pid: int) -> list[int]:
        size = 16
        while True:
            buffer = (ctypes.c_int * size)()
            count = self.libproc.proc_listchildpids(pid, buffer, ctypes.sizeof(buffer))
            if count < size:
                return buffer[: max(0, count)]
            size *= 2

    def usage(self, pid: int) -> ProcessUsage | None:
        info = _RusageInfoV1()
        if self.libproc.proc_pid_rusage(pid, 1, ctypes.byref(info)) != 0:  # RUSAGE_INFO_V1
            return None
        cpu = info.user_time + info.system_time + info.child_user_time + info.child_system_time
        return ProcessUsage(cpu * self.seconds_per_tick, info.resident_size)


def tree_sampler(pid: int) -> tuple[str, Callable[[], ProcessSample]]:
    if sys.platform == "darwin":
        mac = _MacProcesses()
        return "macOS libproc process tree", lambda: sample_tree(pid, mac.children, mac.usage)
    if sys.platform == "linux":
        ticks = os.sysconf("SC_CLK_TCK")
        pages = os.sysconf("SC_PAGE_SIZE")
        return "Linux procfs process tree", lambda: sample_tree(
            pid, _linux_children, lambda child: _linux_usage(child, ticks, pages)
        )
    raise RuntimeError("Process tree sampling requires macOS or Linux.")


def peak_rss(samples: list[ProcessSample]) -> dict[str, int]:
    return {
        "api_peak_rss_bytes": max(row.api_rss_bytes for row in samples),
        "worker_peak_rss_bytes": max(row.worker_rss_bytes for row in samples),
        "peak_rss_bytes": max(row.combined_rss_bytes for row in samples),
    }
