"""Run the reviewer simulation and calculate local experiment summaries."""

from collections import Counter
from collections.abc import Callable, Collection, Sequence
from dataclasses import dataclass
from random import Random
from statistics import median
from time import monotonic, sleep
from typing import TYPE_CHECKING

from flagsmith.models import Flag
from flagsmith.types import TraitMapping

from clients import ExperimentClient
from diffs import DiffSample
from model import Decision
from panels import Panel
from personas import Persona

if TYPE_CHECKING:
    from experiments import Experiment


class SimulationError(Exception):
    """The client did not return a usable experiment assignment."""


@dataclass(frozen=True)
class VariantSummary:
    reviewers: int
    success_rate: float | None
    median_ms: float | None
    persona_counts: dict[str, Counter[str]]


def run_simulation(
    client: ExperimentClient,
    experiment: "Experiment",
    diffs: Sequence[DiffSample],
    *,
    reviewers: Panel,
    model_name: str,
    rate: float | None,
    seed: int,
    sleep_for: Callable[[float], None] = sleep,
    clock: Callable[[], float] = monotonic,
) -> dict[str, VariantSummary]:
    """Simulate one exposure and decision per identity, then flush the client."""
    random = Random(seed)
    try:
        model = experiment.models[model_name]
        reviews: dict[str, list[tuple[Persona, Decision]]] = {
            variant: [] for variant in model.variants
        }
        interval = 0 if rate is None else 1 / rate
        for index, (identifier, persona) in enumerate(reviewers.items(), start=1):
            started_at = clock()
            diff = random.choice(diffs)
            traits = persona.traits()
            variant = assigned_variant(client, experiment.flag, model.variants, identifier, traits)
            decision = model.sample(variant, diff.size, random, persona=persona, depth=diff.depth)
            event = experiment.success_event if decision.succeeded else experiment.failure_event
            value = (
                decision.elapsed_ms
                if decision.succeeded or experiment.record_failure_time
                else None
            )
            client.track_event(event, identifier=identifier, value=value, traits=traits)
            reviews[variant].append((persona, decision))

            remaining = interval - (clock() - started_at)
            if index < len(reviewers) and remaining > 0:
                sleep_for(remaining)
    finally:
        client.close()

    return {variant: _summarize(results) for variant, results in reviews.items()}


def _summarize(reviews: list[tuple[Persona, Decision]]) -> VariantSummary:
    count = len(reviews)
    return VariantSummary(
        reviewers=count,
        success_rate=sum(decision.succeeded for _, decision in reviews) / count if count else None,
        median_ms=median(decision.elapsed_ms for _, decision in reviews) if count else None,
        persona_counts=persona_counts([persona for persona, _ in reviews]),
    )


def persona_counts(personas: Sequence[Persona]) -> dict[str, Counter[str]]:
    return {
        "role": Counter(persona.role for persona in personas),
        "codebase_familiarity": Counter(persona.codebase_familiarity for persona in personas),
        "reading_style": Counter(persona.reading_style for persona in personas),
    }


def assigned_variant(
    client: ExperimentClient,
    feature: str,
    variants: Collection[str],
    identifier: str,
    traits: TraitMapping,
) -> str:
    flag = client.get_experiment_flag(feature, identifier=identifier, traits=traits)
    if not (
        isinstance(flag, Flag)
        and flag.enabled
        and flag.experiment
        and flag.experiment.in_experiment
        and flag.variant
    ):
        raise SimulationError(
            f"The {feature} flag must have an active experiment with variant keys."
        )
    if not isinstance(flag.value, str) or flag.value not in variants:
        raise SimulationError(f"The {feature} flag returned an unknown variant value.")
    return flag.value
