"""Configure the Flagsmith SDK or record equivalent events in memory."""

import hashlib
from typing import Protocol
from urllib.parse import urlsplit

from flagsmith import Flagsmith
from flagsmith.analytics import EventProcessorConfig
from flagsmith.models import DefaultFlag, ExperimentMetadata, Flag
from flagsmith.types import TraitMapping

FLOW_FLAG = "flow_view"
DEFAULT_API_URL = "http://localhost:8000/api/v1/"


class ExperimentClient(Protocol):
    def get_experiment_flag(
        self, feature_name: str, *, identifier: str, traits: TraitMapping
    ) -> Flag | DefaultFlag: ...

    def track_event(
        self, event: str, *, identifier: str, value: int, traits: TraitMapping
    ) -> None: ...

    def close(self) -> None: ...


class DryRunClient:
    """Assign each reviewer to a fixed bucket and keep a log of all events."""

    def __init__(self) -> None:
        self.events: list[tuple[str, str, str | int]] = []
        self.identity_traits: dict[str, TraitMapping] = {}
        self.closed = False

    def get_experiment_flag(
        self, feature_name: str, *, identifier: str, traits: TraitMapping
    ) -> Flag | DefaultFlag:
        digest = hashlib.sha256(identifier.encode("utf-8")).digest()
        bucket = int.from_bytes(digest, "big") % 100
        if bucket < 34:
            variant = "side_by_side"
        elif bucket < 67:
            variant = "overlay"
        else:
            variant = "overlay_summary"

        self.identity_traits[identifier] = dict(traits)
        self.events.append(("$flag_exposure", identifier, variant))
        return Flag(
            enabled=True,
            value=variant,
            feature_id=1,
            feature_name=feature_name,
            variant=variant,
            experiment=ExperimentMetadata(id=1, name=FLOW_FLAG, in_experiment=True),
        )

    def track_event(self, event: str, *, identifier: str, value: int, traits: TraitMapping) -> None:
        self.events.append((event, identifier, value))

    def close(self) -> None:
        self.closed = True


def flagsmith_client(api_url: str, environment_key: str) -> Flagsmith:
    """Enable experiment events on the same self-hosted API as flag evaluation."""
    if not environment_key:
        raise ValueError("Set CODEFLOW_FLAGSMITH_ENV_KEY to the client-side environment key.")

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
