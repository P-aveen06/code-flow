"""Sample reviewer decisions from behaviour assumptions."""

import math
from dataclasses import dataclass, field
from random import Random

from personas import Persona, PersonaEffect, PersonaModel

MODELS = ("hypothesis", "null")
PersonaInteractions = dict[str, dict[str, dict[str, PersonaEffect]]]


@dataclass(frozen=True)
class VariantBehaviour:
    success_probability: float
    median_ms: float
    sigma: float


@dataclass(frozen=True)
class Decision:
    succeeded: bool
    elapsed_ms: int


@dataclass(frozen=True)
class BehaviourModel:
    variants: dict[str, VariantBehaviour]
    success_penalty: float
    time_increase: float
    personas: PersonaModel
    persona_interactions: PersonaInteractions = field(default_factory=dict)

    def persona_effect(self, persona: Persona, variant: str) -> PersonaEffect:
        traits = persona.traits()
        extra_effects = []
        for attribute, effects in self.persona_interactions.get(variant, {}).items():
            value = traits[attribute]
            if value in effects:
                extra_effects.append(effects[value])
        return self.personas.effect(persona, extra_effects)

    def sample(self, variant: str, size: int, random: Random, *, persona: Persona) -> Decision:
        behaviour = self.variants[variant]
        effect = self.persona_effect(persona, variant)
        probability = (
            behaviour.success_probability
            - self.success_penalty * math.log1p(size)
            + effect.probability_delta
        )
        succeeded = random.random() < min(1.0, max(0.0, probability))
        log_median = math.log(behaviour.median_ms * effect.time_multiplier) + size * math.log1p(
            self.time_increase
        )
        elapsed_ms = max(1, round(random.lognormvariate(log_median, behaviour.sigma)))
        return Decision(succeeded, elapsed_ms)
