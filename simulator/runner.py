"""Run the reviewer simulation and calculate local experiment summaries."""

from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from random import Random
from statistics import median
from time import monotonic, sleep

from flagsmith.models import Flag

from clients import FLOW_FLAG, ExperimentClient
from model import VARIANTS, BehaviourModel, Decision
from personas import Persona


class SimulationError(Exception):
    """The client did not return a usable experiment assignment."""


@dataclass(frozen=True)
class VariantSummary:
    reviewers: int
    understood_rate: float | None
    median_ms: float | None
    persona_counts: dict[str, Counter[str]]


def run_simulation(
    client: ExperimentClient,
    model: BehaviourModel,
    diff_sizes: Sequence[int],
    *,
    n: int,
    rate: float,
    seed: int,
    prefix: str,
    sleep_for: Callable[[float], None] = sleep,
    clock: Callable[[], float] = monotonic,
) -> dict[str, VariantSummary]:
    """Simulate one exposure and decision per identity, then flush the client."""
    random = Random(seed)
    reviews: dict[str, list[tuple[Persona, Decision]]] = {variant: [] for variant in VARIANTS}
    try:
        interval = 1 / rate
        for index in range(1, n + 1):
            started_at = clock()
            identifier = f"{prefix}-{index:04d}"
            persona = model.personas.sample(Random(f"{seed}:{identifier}"))
            traits = persona.traits()
            flag = client.get_experiment_flag(FLOW_FLAG, identifier=identifier, traits=traits)
            if not (
                isinstance(flag, Flag)
                and flag.enabled
                and flag.experiment
                and flag.experiment.in_experiment
                and flag.variant
            ):
                raise SimulationError(
                    "The flow_view flag must have an active experiment with variant keys."
                )
            variant = flag.value
            if not isinstance(variant, str) or variant not in model.variants:
                raise SimulationError("The flow_view flag returned an unknown view.")
            decision = model.sample(variant, random.choice(diff_sizes), random, persona=persona)
            event = "diff_understood" if decision.understood else "diff_confusing"
            client.track_event(
                event, identifier=identifier, value=decision.elapsed_ms, traits=traits
            )
            reviews[variant].append((persona, decision))

            remaining = interval - (clock() - started_at)
            if index < n and remaining > 0:
                sleep_for(remaining)
    finally:
        client.close()

    return {variant: _summarize(results) for variant, results in reviews.items()}


def _summarize(reviews: list[tuple[Persona, Decision]]) -> VariantSummary:
    count = len(reviews)
    return VariantSummary(
        reviewers=count,
        understood_rate=sum(decision.understood for _, decision in reviews) / count
        if count
        else None,
        median_ms=median(decision.elapsed_ms for _, decision in reviews) if count else None,
        persona_counts={
            "role": Counter(persona.role for persona, _ in reviews),
            "codebase_familiarity": Counter(persona.codebase_familiarity for persona, _ in reviews),
            "reading_style": Counter(persona.reading_style for persona, _ in reviews),
        },
    )
