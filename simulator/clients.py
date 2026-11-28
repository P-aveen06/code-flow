"""Configure the Flagsmith SDK or record equivalent events in memory."""

import hashlib
from collections.abc import Mapping
from typing import Protocol
from urllib.parse import urlsplit

from flagsmith import Flagsmith
from flagsmith.analytics import EventProcessorConfig
from flagsmith.models import DefaultFlag, ExperimentMetadata, Flag
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
        event_processor_config=EventProcessorConfig(events_api_url=api_url.removesuffix("v1")),
    )
