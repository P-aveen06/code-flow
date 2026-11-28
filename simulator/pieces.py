"""Simulate app_flow visitors: read each piece's flags, then walk the journey to a second branch.

A pieces experiment takes exposure from the app_flow flag and each piece's version from its
ui_* flag, with the rules of web/src/appFlow/flags.ts. An exposed visitor walks the journey from
the landing page to a second branch of the same repo. Each step has a probability, a lognormal
time, fewest clicks and dead clicks, and the versions a visitor sees change them. Every visitor
draws the same random numbers whatever their pieces, so two runs that differ in one switch
compare the same visitors.
"""

import math
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from random import Random
from statistics import mean, median
from time import monotonic, sleep
from typing import NamedTuple

from flagsmith.exceptions import FlagsmithFeatureDoesNotExistError
from flagsmith.models import DefaultFlag, Flag, Flags
from flagsmith.types import TraitMapping

from clients import DryFlag, PieceClient
from config import name_value, number, read_yaml, section
from model import MODELS
from panels import Panel
from personas import Persona, PersonaModel
from runner import persona_counts

APP_FLOW = "app_flow"
FLOWS = ("a", "b", "c")
TODAY = "today"
VERSIONS = (TODAY, *FLOWS)
SWITCHES = (
    "font_family",
    "font_weight",
    "line_spacing",
    "buttons",
    "colours",
    "landing_layout",
    "signin_layout",
    "repos_layout",
    "repo_details_layout",
    "flow_view_layout",
    "branch_switch",
)
# The one step each layout switch changes. Style switches change the review and every step.
LAYOUT_STEPS = {
    "landing_layout": "sign_in_start",
    "signin_layout": "sign_in",
    "repos_layout": "repo_pick",
    "repo_details_layout": "analysis",
    "flow_view_layout": "review",
    "branch_switch": "branch_switch",
}
STEPS = (
    "sign_in_start",
    "sign_in",
    "repo_pick",
    "analysis",
    "first_flow",
    "review",
    "branch_switch",
)
ALL_STEPS = "all"
# A visitor who leaves here, after their import started and before it finished, is an abandon.
ABANDON_STEPS = ("repo_pick", "analysis")
# Every event the journey can send, in the order a visitor reaches them. The summary table uses it.
JOURNEY_EVENTS = (
    "import_started",
    "signin_started",
    "signin_completed",
    "app_installed",
    "repo_selected",
    "import_completed",
    "first_flow_viewed",
    "diff_understood",
    "diff_confusing",
    "diagram_moves",
    "branch_switched",
    "journey_completed",
    "journey_clicks",
    "dead_clicks",
    "import_abandoned",
)
# Values a dry-run switch can take with --pieces. "split" puts the switch in a stacking round.
SETTINGS = ("flow", "off", "split", *FLOWS)
# 33/33/33 in whole percentages: one variant gets the extra point, as app_flow's 34/33/33 does.
STACKING_SPLIT = {"a": 34, "b": 33, "c": 33}
MULTIPLIERS = ("probability", "duration", "dead_click_rate", "diagram_moves")
EFFECT_FIELDS = (*MULTIPLIERS, "extra_clicks", "fewest_clicks")


@dataclass(frozen=True)
class StepBase:
    """A step of today's journey: its odds, its lognormal time, its fewest clicks and dead clicks."""

    probability: float
    median_ms: float
    sigma: float
    clicks: int
    dead_clicks: float
    diagram_moves: float = 0.0


@dataclass(frozen=True)
class Effect:
    """What one switch version does to one step, or to every step when keyed "all"."""

    probability: float = 1.0
    duration: float = 1.0
    dead_click_rate: float = 1.0
    diagram_moves: float = 1.0
    extra_clicks: float = 0.0
    fewest_clicks: int | None = None


@dataclass(frozen=True)
class PiecesExperiment:
    flag: str
    control: str
    allocations: dict[str, int]
    journey: dict[str, StepBase]
    # switch -> version -> step name (or "all") -> effect
    effects: dict[str, dict[str, dict[str, Effect]]]
    personas: PersonaModel


@dataclass(frozen=True)
class VisitorFlags:
    exposed: bool
    flow: str | None
    pieces: dict[str, str]


@dataclass(frozen=True)
class Visit:
    persona: Persona
    events: tuple[tuple[str, float | None], ...]
    completed: bool


@dataclass(frozen=True)
class PiecesSummary:
    visitors: int
    completed: int
    completion_rate: float | None
    median_ms: float | None
    median_clicks: float | None
    reached: Counter[str]
    dead_clicks: float | None
    diagram_moves: float | None
    finisher_dead_clicks: float | None
    finisher_moves: float | None
    persona_counts: dict[str, Counter[str]]


class _Draws(NamedTuple):
    passes: tuple[float, ...]
    normals: tuple[float, ...]
    dead: tuple[float, ...]
    extra: tuple[float, ...]
    moves: float


class _Adjusted(NamedTuple):
    probability: float
    duration: float
    clicks: int
    dead_clicks: float
    extra_clicks: float
    diagram_moves: float


def switch_flag(switch: str) -> str:
    return f"ui_{switch}"


def is_pieces(path: Path) -> bool:
    data = read_yaml(path)
    return isinstance(data, dict) and data.get("mode") == "pieces"


def flow_from_flag(flag: Flag | DefaultFlag) -> str | None:
    """The flow app_flow picks, or None when app_flow is off (resolveFlow in flags.ts)."""
    if not flag.enabled:
        return None
    return flag.value if flag.value in FLOWS else None


def resolve_piece(flow: str | None, flag: Flag | DefaultFlag | None) -> str:
    """One switch's version (resolvePiece in flags.ts). A missing flag follows the flow."""
    if flow is None:
        return TODAY
    if flag is None:
        return flow
    if not flag.enabled:
        return TODAY
    return flag.value if flag.value in FLOWS else flow


def _present(flags: Flags, name: str) -> Flag | None:
    """The flag, or None when Flagsmith has no flag of that name (the SDK raises for those)."""
    try:
        flag = flags.get_flag(name)
    except FlagsmithFeatureDoesNotExistError:
        return None
    return flag if isinstance(flag, Flag) else None


def _in_experiment(flag: Flag | DefaultFlag) -> bool:
    return (
        isinstance(flag, Flag)
        and flag.enabled
        and flag.experiment is not None
        and flag.experiment.in_experiment
    )


def read_visitor(client: PieceClient, identifier: str, traits: TraitMapping) -> VisitorFlags:
    """Read exposure and every piece for one visitor, as the landing page does."""
    app_flag = client.get_experiment_flag(APP_FLOW, identifier=identifier, traits=traits)
    flow = flow_from_flag(app_flag)
    flags = client.get_identity_flags(identifier=identifier, traits=traits)
    exposed = _in_experiment(app_flag)
    pieces = {}
    for switch in SWITCHES:
        name = switch_flag(switch)
        flag: Flag | DefaultFlag | None = _present(flags, name)
        if flow is not None and flag is not None and flag.experiment is not None:
            # A stacking round: the ui flag is its own experiment, so record its exposure. It runs
            # after the app_flow round is completed, so it exposes the visitor on its own.
            flag = client.get_experiment_flag(name, identifier=identifier, traits=traits)
            exposed = exposed or _in_experiment(flag)
        pieces[switch] = resolve_piece(flow, flag)
    return VisitorFlags(exposed, flow, pieces)


def parse_piece_overrides(text: str) -> dict[str, str]:
    """Parse --pieces, such as "ui_buttons=off,ui_branch_switch=a", into flag name -> setting."""
    overrides = {}
    for entry in (part.strip() for part in text.split(",")):
        if not entry:
            continue
        name, separator, setting = entry.partition("=")
        name, setting = name.strip(), setting.strip()
        if not separator or not name or not setting:
            raise ValueError(f"--pieces entries look like ui_buttons=a, got {entry!r}.")
        if name not in {switch_flag(switch) for switch in SWITCHES}:
            raise ValueError(f"Unknown switch {name!r}. Use ui_ names such as ui_buttons.")
        if setting not in SETTINGS:
            raise ValueError(f"{name} takes one of {', '.join(SETTINGS)}; got {setting!r}.")
        overrides[name] = setting
    return overrides


def dry_run_flags(experiment: PiecesExperiment, overrides: Mapping[str, str]) -> dict[str, DryFlag]:
    """The offline flag states: app_flow split as in the experiment, every ui flag at "flow"."""
    flags = {APP_FLOW: DryFlag(allocations=experiment.allocations)}
    for switch in SWITCHES:
        setting = overrides.get(switch_flag(switch), "flow")
        if setting == "off":
            flags[switch_flag(switch)] = DryFlag(enabled=False)
        elif setting == "split":
            flags[switch_flag(switch)] = DryFlag(allocations=STACKING_SPLIT)
        else:
            flags[switch_flag(switch)] = DryFlag(value=setting)
    return flags


def _whole(value: object, name: str) -> int:
    if type(value) is not int or value < 0:
        raise ValueError(f"{name} must be a whole number of clicks, zero or more.")
    return value


def _allocations(value: object) -> dict[str, int]:
    fields = section(value, "allocations", *FLOWS)
    allocations = {}
    for flow in FLOWS:
        share = fields[flow]
        if type(share) is not int or not 0 <= share <= 100:
            raise ValueError(f"allocations.{flow} must be a whole percentage from 0 to 100.")
        allocations[flow] = share
    if sum(allocations.values()) != 100:
        raise ValueError("allocations must add up to 100.")
    return allocations


def _journey(value: object) -> dict[str, StepBase]:
    fields = section(value, "journey", *STEPS)
    journey = {}
    for step in STEPS:
        name = f"journey.{step}"
        data = section(
            fields[step],
            name,
            "probability",
            "median_ms",
            "sigma",
            "clicks",
            "dead_clicks",
            optional=("diagram_moves",),
        )
        probability = number(data, "probability", name)
        if not 0 <= probability <= 1:
            raise ValueError(f"{name}.probability must be between 0 and 1.")
        median_ms = number(data, "median_ms", name)
        sigma = number(data, "sigma", name)
        if median_ms <= 0 or sigma < 0:
            raise ValueError(f"{name} requires positive median_ms and nonnegative sigma.")
        dead_clicks = number(data, "dead_clicks", name)
        if dead_clicks < 0:
            raise ValueError(f"{name}.dead_clicks must be zero or more.")
        if (step == "review") != ("diagram_moves" in data):
            raise ValueError("journey.review must set diagram_moves; no other step may.")
        moves = number(data, "diagram_moves", name) if "diagram_moves" in data else 0.0
        clicks = _whole(data["clicks"], f"{name}.clicks")
        journey[step] = StepBase(probability, median_ms, sigma, clicks, dead_clicks, moves)
    return journey


def _effect(value: object, name: str, switch: str, key: str) -> Effect:
    fields = section(value, name, optional=EFFECT_FIELDS)
    if key == ALL_STEPS and ("fewest_clicks" in fields or "diagram_moves" in fields):
        raise ValueError(
            f"{name} applies to every step, so it cannot set fewest_clicks or diagram_moves."
        )
    if switch in LAYOUT_STEPS and key != LAYOUT_STEPS[switch]:
        raise ValueError(f"{name}: {switch} can change only {LAYOUT_STEPS[switch]}.")
    if switch not in LAYOUT_STEPS and key not in ("review", ALL_STEPS):
        raise ValueError(f"{name}: {switch} can change only the review step or all steps.")
    if "fewest_clicks" in fields and switch not in LAYOUT_STEPS:
        raise ValueError(f"{name}: only layout switches set fewest_clicks.")
    if "diagram_moves" in fields and key != "review":
        raise ValueError(f"{name}.diagram_moves applies only to review.")
    multipliers = {}
    for field in MULTIPLIERS:
        multiplier = number(fields, field, name) if field in fields else 1.0
        if multiplier <= 0:
            raise ValueError(f"{name}.{field} must be positive.")
        multipliers[field] = multiplier
    extra = number(fields, "extra_clicks", name) if "extra_clicks" in fields else 0.0
    if extra < 0:
        raise ValueError(f"{name}.extra_clicks must be zero or more.")
    fewest = (
        _whole(fields["fewest_clicks"], f"{name}.fewest_clicks")
        if "fewest_clicks" in fields
        else None
    )
    return Effect(extra_clicks=extra, fewest_clicks=fewest, **multipliers)


def _check_layout(
    switch: str, version: str, entries: Mapping[str, Effect], journey: dict[str, StepBase]
) -> None:
    if switch not in LAYOUT_STEPS:
        return
    step = LAYOUT_STEPS[switch]
    name = f"pieces.{switch}.{version}"
    effect = entries.get(step)
    if effect is None or effect.fewest_clicks is None:
        raise ValueError(f"{name} must set fewest_clicks for {step}.")
    if version == TODAY and effect.fewest_clicks != journey[step].clicks:
        raise ValueError(
            f"{name} fewest_clicks must match the base journey ({journey[step].clicks})."
        )


def _effects(
    value: object, journey: dict[str, StepBase]
) -> dict[str, dict[str, dict[str, Effect]]]:
    switches = section(value, "pieces", *SWITCHES)
    effects: dict[str, dict[str, dict[str, Effect]]] = {}
    for switch in SWITCHES:
        versions = section(switches[switch], f"pieces.{switch}", *VERSIONS)
        effects[switch] = {}
        for version in VERSIONS:
            name = f"pieces.{switch}.{version}"
            entries = section(versions[version], name, optional=(*STEPS, ALL_STEPS))
            table = {
                key: _effect(entry, f"{name}.{key}", switch, key) for key, entry in entries.items()
            }
            _check_layout(switch, version, table, journey)
            effects[switch][version] = table
    return effects


def load_pieces(path: Path, personas: PersonaModel) -> PiecesExperiment:
    config = section(
        read_yaml(path), path.name, "mode", "flag", "control", "allocations", "journey", "pieces"
    )
    if config["mode"] != "pieces":
        raise ValueError(f"{path.name} must set mode: pieces.")
    flag = name_value(config["flag"], "flag")
    if flag != APP_FLOW:
        raise ValueError(f"A pieces experiment must use the {APP_FLOW} flag.")
    allocations = _allocations(config["allocations"])
    control = name_value(config["control"], "control")
    if control not in allocations:
        raise ValueError("control must be one of the flows: a, b or c.")
    journey = _journey(config["journey"])
    effects = _effects(config["pieces"], journey)
    return PiecesExperiment(flag, control, allocations, journey, effects, personas)


def _adjusted(
    experiment: PiecesExperiment, pieces: Mapping[str, str], step: str, *, neutral: bool
) -> _Adjusted:
    """One step's numbers after every switch on the visitor's versions has had its say."""
    base = experiment.journey[step]
    probability, duration, extra, dead, moves = base.probability, 1.0, 0.0, 1.0, 1.0
    clicks = base.clicks
    if not neutral:
        for switch in SWITCHES:
            table = experiment.effects[switch][pieces[switch]]
            for key in (step, ALL_STEPS):
                effect = table.get(key)
                if effect is None:
                    continue
                probability *= effect.probability
                duration *= effect.duration
                dead *= effect.dead_click_rate
                extra += effect.extra_clicks
                moves *= effect.diagram_moves
                if effect.fewest_clicks is not None:
                    clicks = effect.fewest_clicks
    return _Adjusted(
        probability=probability,
        duration=duration,
        clicks=clicks,
        dead_clicks=base.dead_clicks * dead,
        extra_clicks=extra,
        diagram_moves=base.diagram_moves * moves,
    )


def _ms(value: float) -> int:
    return round(value)


def _count(expected: float, draw: float) -> int:
    """A whole count with the expected value: the draw rounds the fraction up or down."""
    whole = math.floor(expected)
    return whole + (1 if draw < expected - whole else 0)


def _draw(random: Random) -> _Draws:
    """Every random number one visitor needs, drawn in a fixed order whatever their pieces."""
    passes = tuple(random.random() for _ in STEPS)
    normals = tuple(random.gauss(0, 1) for _ in STEPS)
    dead = tuple(random.random() for _ in STEPS)
    extra = tuple(random.random() for _ in STEPS)
    return _Draws(passes, normals, dead, extra, random.random())


def _walk(
    experiment: PiecesExperiment,
    pieces: Mapping[str, str],
    persona: Persona,
    draws: _Draws,
    *,
    neutral: bool,
) -> Visit:
    """Walk one exposed visitor through the journey and return the events the app sends them."""
    persona_effect = experiment.personas.effect(persona)
    events: list[tuple[str, float | None]] = []
    elapsed = 0.0
    clicks = 0
    dead_total = 0
    for index, step in enumerate(STEPS):
        base = experiment.journey[step]
        adjusted = _adjusted(experiment, pieces, step, neutral=neutral)
        probability = adjusted.probability
        median_ms = base.median_ms * adjusted.duration
        if step == "review":
            probability += persona_effect.probability_delta
            median_ms *= persona_effect.time_multiplier
        probability = min(1.0, max(0.0, probability))
        duration = median_ms * math.exp(base.sigma * draws.normals[index])
        elapsed += duration
        dead = _count(adjusted.dead_clicks, draws.dead[index])
        dead_total += dead
        # journey.ts counts every click, dead clicks included.
        clicks += adjusted.clicks + _count(adjusted.extra_clicks, draws.extra[index]) + dead
        passed = draws.passes[index] < probability
        if step == "review":
            # Answering counts, whichever answer it is. Only "understood" carries on.
            outcome = "diff_understood" if passed else "diff_confusing"
            events.append((outcome, _ms(duration)))
            events.append(("diagram_moves", _count(adjusted.diagram_moves, draws.moves)))
            if not passed:
                break
            continue
        if not passed:
            if step == "sign_in":
                # The visitor is on GitHub's page, and the app sends nothing from there.
                return Visit(persona, tuple(events), completed=False)
            if step in ABANDON_STEPS:
                events.append(("import_abandoned", None))
            break
        if step == "sign_in_start":
            events.extend([("import_started", None), ("signin_started", None)])
        elif step == "sign_in":
            events.extend([("signin_completed", None), ("app_installed", None)])
        elif step == "repo_pick":
            events.append(("repo_selected", None))
        elif step == "analysis":
            events.append(("import_completed", _ms(elapsed)))
        elif step == "first_flow":
            events.append(("first_flow_viewed", _ms(elapsed)))
        else:
            events.append(("branch_switched", _ms(duration)))
            events.append(("journey_completed", _ms(elapsed)))
            events.append(("journey_clicks", clicks))
            events.append(("dead_clicks", dead_total))
            return Visit(persona, tuple(events), completed=True)
    # The page sends dead_clicks once when the visitor leaves.
    events.append(("dead_clicks", dead_total))
    return Visit(persona, tuple(events), completed=False)


def fewest_clicks(experiment: PiecesExperiment, version: str) -> int:
    """Clicks to finish the journey with every switch on one version, and no dead clicks."""
    pieces = dict.fromkeys(SWITCHES, version)
    return sum(_adjusted(experiment, pieces, step, neutral=False).clicks for step in STEPS)


def _values(visits: Sequence[Visit], name: str) -> list[float]:
    """The values one event name carried, across the visitors who sent it."""
    return [
        value
        for visit in visits
        for event, value in visit.events
        if event == name and value is not None
    ]


def _recorded(visit: Visit, name: str) -> float:
    """One visitor's total for a count event, such as dead clicks. Zero when they sent none."""
    return sum(value or 0 for event, value in visit.events if event == name)


def _median(values: Sequence[float]) -> float | None:
    return median(values) if values else None


def _mean(values: Sequence[float]) -> float | None:
    return mean(values) if values else None


def _summarize(visits: list[Visit]) -> PiecesSummary:
    count = len(visits)
    finished = [visit for visit in visits if visit.completed]
    return PiecesSummary(
        visitors=count,
        completed=len(finished),
        completion_rate=len(finished) / count if count else None,
        median_ms=_median(_values(finished, "journey_completed")),
        median_clicks=_median(_values(finished, "journey_clicks")),
        reached=Counter(event for visit in visits for event, _ in visit.events),
        dead_clicks=_mean([_recorded(visit, "dead_clicks") for visit in visits]),
        diagram_moves=_mean([_recorded(visit, "diagram_moves") for visit in visits]),
        finisher_dead_clicks=_mean([_recorded(visit, "dead_clicks") for visit in finished]),
        finisher_moves=_mean([_recorded(visit, "diagram_moves") for visit in finished]),
        persona_counts=persona_counts([visit.persona for visit in visits]),
    )


def run_pieces(
    client: PieceClient,
    experiment: PiecesExperiment,
    *,
    reviewers: Panel,
    model_name: str,
    rate: float | None,
    seed: int,
    sleep_for: Callable[[float], None] = sleep,
    clock: Callable[[], float] = monotonic,
) -> dict[str, PiecesSummary]:
    """Read each visitor's pieces, walk the exposed ones, send their events, then flush."""
    if model_name not in MODELS:
        raise ValueError(f"Unknown model {model_name!r}.")
    random = Random(seed)
    neutral = model_name == "null"
    interval = 0 if rate is None else 1 / rate
    visits: dict[str, list[Visit]] = {flow: [] for flow in experiment.allocations}
    try:
        for index, (identifier, persona) in enumerate(reviewers.items(), start=1):
            started_at = clock()
            traits = persona.traits()
            draws = _draw(random)
            visitor = read_visitor(client, identifier, traits)
            if visitor.exposed:
                visit = _walk(experiment, visitor.pieces, persona, draws, neutral=neutral)
                for event, value in visit.events:
                    client.track_event(event, identifier=identifier, value=value, traits=traits)
                visits.setdefault(visitor.flow or TODAY, []).append(visit)

            remaining = interval - (clock() - started_at)
            if index < len(reviewers) and remaining > 0:
                sleep_for(remaining)
    finally:
        client.close()
    return {flow: _summarize(items) for flow, items in visits.items()}
