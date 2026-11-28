"""Fetch and cache remote Flagsmith environment flags without an identity."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from math import isfinite
from threading import Lock
from time import monotonic
from typing import Protocol

from flagsmith import Flagsmith
from flagsmith.exceptions import FlagsmithClientError
from flagsmith.models import Flags
from urllib3 import Retry

FlagValue = str | int | float | bool | None
FlagStates = dict[str, tuple[bool, FlagValue]]
CACHE_SECONDS = 10


class EnvironmentFlagsClient(Protocol):
    def get_environment_flags(self) -> Flags: ...


@dataclass(frozen=True)
class EnvironmentState:
    flags: FlagStates | None = None
    fetched_at: str | None = None
    error: str | None = None


class FlagsmithClient:
    """Share one environment lookup per cache window across API requests."""

    def __init__(
        self,
        server_key: str | None,
        api_url: str,
        *,
        sdk: EnvironmentFlagsClient | None = None,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        if sdk is None and server_key:
            sdk = Flagsmith(
                environment_key=server_key,
                api_url=api_url,
                enable_local_evaluation=False,
                request_timeout_seconds=4,
                retries=Retry(total=0),
            )
        self._sdk = sdk
        self._clock = clock
        self._lock = Lock()
        self._cached: EnvironmentState | None = None
        self._expires_at = 0.0

    def get_state(self) -> EnvironmentState:
        with self._lock:
            if self._cached is None or self._clock() >= self._expires_at:
                self._cached = self._fetch()
                self._expires_at = self._clock() + CACHE_SECONDS
            return self._cached

    def _fetch(self) -> EnvironmentState:
        if self._sdk is None:
            return EnvironmentState(error="CODEFLOW_FLAGSMITH_SERVER_KEY is missing")
        try:
            flags: FlagStates = {}
            for flag in self._sdk.get_environment_flags().all_flags():
                name, enabled, value = flag.feature_name, flag.enabled, flag.value
                if not isinstance(name, str) or not isinstance(enabled, bool):
                    raise TypeError
                if value is not None and not isinstance(value, (str, int, float, bool)):
                    raise TypeError
                if isinstance(value, float) and not isfinite(value):
                    raise ValueError
                flags[name] = (enabled, value)
        except FlagsmithClientError:
            return EnvironmentState(error="Could not fetch flags from Flagsmith")
        except (AttributeError, KeyError, TypeError, ValueError):
            return EnvironmentState(error="Flagsmith returned invalid flag data")
        fetched_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        return EnvironmentState(flags=flags, fetched_at=fetched_at)
