"""Detect clock drift and missing process samples that can invalidate a case."""

from collections.abc import Callable
from itertools import pairwise
from time import monotonic, time

CLOCK_DRIFT_LIMIT_S = 3
SAMPLE_GAP_LIMIT_S = 10


class Suspended(RuntimeError):
    """A case encountered a sleep, suspension or clock jump."""


class SuspensionCheck:
    def __init__(
        self,
        wall: Callable[[], float] = time,
        steady: Callable[[], float] = monotonic,
    ) -> None:
        self.wall = wall
        self.steady = steady
        self.wall_start = wall()
        self.steady_start = steady()

    def check(self, *sample_streams: list[float]) -> float:
        drift = (self.wall() - self.wall_start) - (self.steady() - self.steady_start)
        if abs(drift) > CLOCK_DRIFT_LIMIT_S:
            raise Suspended(f"wall and monotonic clocks diverged by {abs(drift):.1f} s")
        gap = max(
            (
                second - first
                for stamps in sample_streams
                for first, second in pairwise(stamps)
            ),
            default=0.0,
        )
        if gap > SAMPLE_GAP_LIMIT_S:
            raise Suspended(f"process sampling paused for {gap:.1f} s")
        return max(0.0, gap)
