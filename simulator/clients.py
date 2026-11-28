"""Configure the Flagsmith SDK or record equivalent events in memory."""

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlsplit

from flagsmith import Flagsmith
from flagsmith.analytics import EventProcessorConfig
from flagsmith.models import DefaultFlag, ExperimentMetadata, Flag, Flags
from flagsmith.types import TraitMapping

DEFAULT_API_URL = "http://localhost:8000/api/v1/"


class ExperimentClient(Protocol):
    def get_experiment_flag(
        self, feature_name: str, *, identifier: str, traits: TraitMapping
    ) -> Flag | DefaultFlag: ...

    def track_event(
        self, event: str, *, identifier: str, value: float | None, traits: TraitMapping
    ) -> None: ...

    def close(self) -> None: ...


class PieceClient(ExperimentClient, Protocol):
    """A pieces run also reads every flag for one visitor at once, as the landing page does."""

    def get_identity_flags(self, *, identifier: str, traits: TraitMapping) -> Flags: ...


class DryRunClient:
    """Assign each reviewer to a fixed bucket and keep a log of all events."""

    def __init__(self, allocations: Mapping[str, int]) -> None:
        self.allocations = allocations
        self.events: list[tuple[str, str, str | int | float | None]] = []
        self.identity_traits: dict[str, TraitMapping] = {}
        self.closed = False

    def get_experiment_flag(
        self, feature_name: str, *, identifier: str, traits: TraitMapping
    ) -> Flag | DefaultFlag:
        digest = hashlib.sha256(identifier.encode()).digest()
        bucket = int.from_bytes(digest, "big") % 100
        for variant, allocation in self.allocations.items():
            if bucket < allocation:
                break
            bucket -= allocation
        else:
            raise ValueError("Dry-run variant allocations must add up to 100.")

        self.identity_traits[identifier] = dict(traits)
        self.events.append(("$flag_exposure", identifier, variant))
        return Flag(
            enabled=True,
            value=variant,
            feature_id=1,
            feature_name=feature_name,
            variant=variant,
            experiment=ExperimentMetadata(id=1, name=feature_name, in_experiment=True),
        )

    def track_event(
        self, event: str, *, identifier: str, value: float | None, traits: TraitMapping
    ) -> None:
        self.events.append((event, identifier, value))

    def close(self) -> None:
        self.closed = True


@dataclass(frozen=True)
class DryFlag:
    """One offline flag: a fixed value, switched off, or split between variants by allocations."""

    enabled: bool = True
    value: str = "flow"
    allocations: Mapping[str, int] | None = None


def _assigned_variant(feature: str, identifier: str, allocations: Mapping[str, int]) -> str:
    """Hash the flag and the identity together, so each flag splits the same visitors on its own."""
    digest = hashlib.sha256(f"{feature}:{identifier}".encode()).digest()
    bucket = int.from_bytes(digest, "big") % 100
    for variant, allocation in allocations.items():
        if bucket < allocation:
            return variant
        bucket -= allocation
    raise ValueError("Dry-run variant allocations must add up to 100.")


class DryRunPiecesClient:
    """Serve the offline flags for a pieces run and keep a log of exposures and events."""

    def __init__(self, flags: Mapping[str, DryFlag]) -> None:
        self.flags = flags
        self.events: list[tuple[str, str, str | int | float | None]] = []
        self.closed = False

    def _flag(self, name: str, identifier: str) -> Flag:
        setting = self.flags[name]
        if setting.allocations is None:
            return Flag(
                enabled=setting.enabled, value=setting.value, feature_id=1, feature_name=name
            )
        variant = _assigned_variant(name, identifier, setting.allocations)
        return Flag(
            enabled=setting.enabled,
            value=variant,
            feature_id=1,
            feature_name=name,
            variant=variant,
            experiment=ExperimentMetadata(id=1, name=name, in_experiment=True),
        )

    def get_identity_flags(self, *, identifier: str, traits: TraitMapping) -> Flags:
        return Flags(flags={name: self._flag(name, identifier) for name in self.flags})

    def get_experiment_flag(
        self, feature_name: str, *, identifier: str, traits: TraitMapping
    ) -> Flag:
        flag = self._flag(feature_name, identifier)
        if flag.enabled and flag.experiment is not None:
            self.events.append(("$flag_exposure", identifier, flag.variant))
        return flag

    def track_event(
        self, event: str, *, identifier: str, value: float | None, traits: TraitMapping
    ) -> None:
        self.events.append((event, identifier, value))

    def close(self) -> None:
        self.closed = True


def flagsmith_client(api_url: str, environment_key: str) -> Flagsmith:
    """Enable experiment events on the same self-hosted API as flag evaluation."""
    api_url = api_url.rstrip("/")
    error = "FLAGSMITH_API_URL must be an HTTP(S) API base URL ending in /v1/."
    try:
        url = urlsplit(api_url)
    except ValueError:
        raise ValueError(error) from None
    if (
        url.scheme not in ("http", "https")
        or not url.hostname
        or not url.path.endswith("/v1")
        or url.query
        or url.fragment
        or url.username is not None
    ):
        raise ValueError(error)

    # The SDK appends v1/events to this base. Flagsmith accepts with or without a trailing slash.
    return Flagsmith(
        environment_key=environment_key,
        api_url=api_url + "/",
        enable_events=True,
        # A run tracks about 15 events per visitor. With the SDK's 1,000-event buffer, events
        # kept for a retry plus new ones overflowed and the oldest were dropped (27 of round 1's).
        event_processor_config=EventProcessorConfig(
            events_api_url=api_url.removesuffix("v1"), max_buffer_items=100_000
        ),
    )
