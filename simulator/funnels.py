"""Simulate a multi-step journey, such as signing in with GitHub to import a repo.

A funnel experiment differs from a review experiment: each visitor walks a route of
steps, any of which can lose them, and the outcome is whether they reach the end.
"""

import math
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from random import Random
from statistics import median
from time import monotonic, sleep

from clients import ExperimentClient
from config import name_value, number, read_yaml, section
from panels import Panel
from personas import Persona, PersonaModel
from runner import assigned_variant, persona_counts

# Visitors who want to import a private repository cannot use a public URL.
AUDIENCES = ("public", "private")


@dataclass(frozen=True)
class Duration:
    median_ms: float
    sigma: float

    def sample(self, random: Random) -> float:
        return random.lognormvariate(math.log(self.median_ms), self.sigma)


@dataclass(frozen=True)
class Step:
    """One stage of a route. Its events go to Flagsmith when the visitor gets through it."""

    events: tuple[str, ...]
    probability: float
    duration: Duration


@dataclass(frozen=True)
class Route:
    share: float
    steps: tuple[Step, ...]


# audience -> the routes visitors in that audience take. Leftover share leaves without trying.
Journeys = dict[str, tuple[Route, ...]]


@dataclass(frozen=True)
class FunnelExperiment:
    flag: str
    control: str
    allocations: dict[str, int]
    start_event: str
    success_event: str
    time_event: str
    abandon_event: str
    private_share: dict[str, float]
    first_flow: Duration
    # model -> variant -> journeys. The null model gives every variant the control's routes.
    models: dict[str, dict[str, Journeys]]
    long_flows_only: bool = False


@dataclass(frozen=True)
class FunnelSummary:
    reviewers: int
    completed: int
    completion_rate: float | None
    median_ms: float | None
    event_counts: Counter[str]
    persona_counts: dict[str, Counter[str]]


def is_funnel(path: Path) -> bool:
    data = read_yaml(path)
    return isinstance(data, dict) and data.get("mode") == "funnel"


def _probability(fields: dict[str, object], key: str, name: str) -> float:
    value = number(fields, key, name)
    if not 0 <= value <= 1:
        raise ValueError(f"{name}.{key} must be between 0 and 1.")
    return value


def _duration(value: object, name: str) -> Duration:
    fields = section(value, name, "median_ms", optional=("sigma",))
    median_ms = number(fields, "median_ms", name)
    sigma = number(fields, "sigma", name) if "sigma" in fields else 0.5
    if median_ms <= 0 or sigma < 0:
        raise ValueError(f"{name} requires positive median_ms and nonnegative sigma.")
    return Duration(median_ms, sigma)


def _step(value: object, name: str, reserved: set[str]) -> Step:
    fields = section(value, name, "median_ms", optional=("events", "probability", "sigma"))
    events = fields.get("events", [])
    if not isinstance(events, list) or ("events" in fields and not events):
        raise ValueError(f"{name}.events must be a nonempty list of event names.")
    names = tuple(name_value(event, f"{name}.events") for event in events)
    if clash := reserved.intersection(names):
        raise ValueError(f"{name}.events cannot send {', '.join(sorted(clash))}; it is automatic.")
    probability = _probability(fields, "probability", name) if "probability" in fields else 1.0
    timing = {key: fields[key] for key in ("median_ms", "sigma") if key in fields}
    return Step(names, probability, _duration(timing, name))


def _routes(value: object, name: str, start_event: str, reserved: set[str]) -> tuple[Route, ...]:
    if not isinstance(value, list) or not value:
        raise ValueError(f"{name} must be a nonempty list of routes.")
    routes = []
    for index, raw in enumerate(value):
        route_name = f"{name}[{index}]"
        fields = section(raw, route_name, "share", "steps")
        raw_steps = fields["steps"]
        if not isinstance(raw_steps, list) or not raw_steps:
            raise ValueError(f"{route_name}.steps must be a nonempty list.")
        steps = tuple(
            _step(step, f"{route_name}.steps[{position}]", reserved)
            for position, step in enumerate(raw_steps)
        )
        if not any(start_event in step.events for step in steps):
            raise ValueError(f"{route_name} must send {start_event}.")
        routes.append(Route(_probability(fields, "share", route_name), steps))
    if sum(route.share for route in routes) > 1 + 1e-9:
        raise ValueError(f"{name} shares must add up to at most 1.")
    return tuple(routes)


def load_funnel(path: Path, personas: PersonaModel) -> FunnelExperiment:
    config = section(
        read_yaml(path),
        path.name,
        "mode",
        "flag",
        "start_event",
        "success_event",
        "time_event",
        "abandon_event",
        "private_share",
        "first_flow",
        "variants",
    )
    if config["mode"] != "funnel":
        raise ValueError(f"{path.name} must set mode: funnel.")
    flag = name_value(config["flag"], "flag")
    events = {
        key: name_value(config[key], key)
        for key in ("start_event", "success_event", "time_event", "abandon_event")
    }
    if len(set(events.values())) != len(events):
        raise ValueError("start_event, success_event, time_event and abandon_event must differ.")
    reserved = {events["success_event"], events["time_event"], events["abandon_event"]}

    shares = section(config["private_share"], "private_share", *personas.roles)
    private_share = {role: _probability(shares, role, "private_share") for role in shares}

    raw_variants = config["variants"]
    if not isinstance(raw_variants, dict) or len(raw_variants) < 2:
        raise ValueError("variants must contain at least two variant values.")
    journeys: dict[str, Journeys] = {}
    allocations = {}
    controls = []
    for key, value in raw_variants.items():
        variant = name_value(key, "Variant value")
        name = f"variants.{variant}"
        fields = section(value, name, "allocation", *AUDIENCES, optional=("control",))
        allocation = fields["allocation"]
        if type(allocation) is not int or not 0 <= allocation <= 100:
            raise ValueError(f"{name}.allocation must be a whole percentage from 0 to 100.")
        allocations[variant] = allocation
        control = fields.get("control", False)
        if control is True:
            controls.append(variant)
        elif control is not False:
            raise ValueError(f"{name}.control must be true or false.")
        journeys[variant] = {
            audience: _routes(
                fields[audience], f"{name}.{audience}", events["start_event"], reserved
            )
            for audience in AUDIENCES
        }
    if len(controls) != 1:
        raise ValueError("Mark exactly one variant as the control.")
    if sum(allocations.values()) != 100:
        raise ValueError("Dry-run variant allocations must add up to 100.")

    control = controls[0]
    return FunnelExperiment(
        flag=flag,
        control=control,
        allocations=allocations,
        private_share=private_share,
        first_flow=_duration(config["first_flow"], "first_flow"),
        models={"hypothesis": journeys, "null": dict.fromkeys(journeys, journeys[control])},
        **events,
    )


def _pick_route(routes: tuple[Route, ...], random: Random) -> Route | None:
    draw = random.random()
    for route in routes:
        if draw < route.share:
            return route
        draw -= route.share
    return None


def _walk(
    experiment: FunnelExperiment, route: Route, random: Random
) -> tuple[list[tuple[str, float | None]], float | None]:
    """Return the events a visitor sends on a route, and their time to first flow if any."""
    sent: list[tuple[str, float | None]] = []
    elapsed = 0.0
    for step in route.steps:
        elapsed += step.duration.sample(random)
        if random.random() >= step.probability:
            if any(event == experiment.start_event for event, _ in sent):
                sent.append((experiment.abandon_event, None))
            return sent, None
        sent.extend((event, None) for event in step.events)
    first_flow = elapsed + experiment.first_flow.sample(random)
    sent.append((experiment.success_event, round(elapsed)))
    sent.append((experiment.time_event, round(first_flow)))
    return sent, first_flow


def run_funnel(
    client: ExperimentClient,
    experiment: FunnelExperiment,
    *,
    reviewers: Panel,
    model_name: str,
    rate: float | None,
    seed: int,
    sleep_for: Callable[[float], None] = sleep,
    clock: Callable[[], float] = monotonic,
) -> dict[str, FunnelSummary]:
    """Walk each visitor through their variant's journey once, then flush the client."""
    random = Random(seed)
    journeys = experiment.models[model_name]
    visits: dict[str, list[tuple[Persona, list[str], float | None]]] = {
        variant: [] for variant in journeys
    }
    interval = 0 if rate is None else 1 / rate
    try:
        for index, (identifier, persona) in enumerate(reviewers.items(), start=1):
            started_at = clock()
            traits = persona.traits()
            variant = assigned_variant(client, experiment.flag, journeys, identifier, traits)
            audience = (
                "private" if random.random() < experiment.private_share[persona.role] else "public"
            )
            route = _pick_route(journeys[variant][audience], random)
            sent, first_flow = _walk(experiment, route, random) if route else ([], None)
            for event, value in sent:
                client.track_event(event, identifier=identifier, value=value, traits=traits)
            visits[variant].append((persona, [event for event, _ in sent], first_flow))

            remaining = interval - (clock() - started_at)
            if index < len(reviewers) and remaining > 0:
                sleep_for(remaining)
    finally:
        client.close()
    return {variant: _summarize(results) for variant, results in visits.items()}


def _summarize(visits: list[tuple[Persona, list[str], float | None]]) -> FunnelSummary:
    count = len(visits)
    times = [first_flow for _, _, first_flow in visits if first_flow is not None]
    return FunnelSummary(
        reviewers=count,
        completed=len(times),
        completion_rate=len(times) / count if count else None,
        median_ms=median(times) if times else None,
        event_counts=Counter(event for _, events, _ in visits for event in events),
        persona_counts=persona_counts([persona for persona, _, _ in visits]),
    )


def funnel_events(experiment: FunnelExperiment) -> list[str]:
    """Every event the hypothesis model can send, in journey order, for the summary table."""
    ordered = [experiment.start_event]
    for journeys in experiment.models["hypothesis"].values():
        for routes in journeys.values():
            for route in routes:
                for step in route.steps:
                    ordered.extend(event for event in step.events if event not in ordered)
    return [*ordered, experiment.success_event, experiment.time_event, experiment.abandon_event]
