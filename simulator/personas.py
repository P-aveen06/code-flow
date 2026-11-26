"""Sample reviewer personas and combine their effects on decisions."""

import math
from dataclasses import dataclass
from random import Random


@dataclass(frozen=True)
class Persona:
    role: str
    experience_years: float
    codebase_familiarity: str
    reading_style: str

    def traits(self) -> dict[str, str | float]:
        return {
            "role": self.role,
            "experience_years": self.experience_years,
            "codebase_familiarity": self.codebase_familiarity,
            "reading_style": self.reading_style,
        }


@dataclass(frozen=True)
class PersonaEffect:
    probability_delta: float
    time_multiplier: float


@dataclass(frozen=True)
class RoleProfile:
    weight: float
    experience_years: tuple[int, int]
    familiarity_weights: dict[str, float]
    effect: PersonaEffect


@dataclass(frozen=True)
class ReadingStyleProfile:
    weight: float
    effect: PersonaEffect
    variant_effects: dict[str, PersonaEffect]


@dataclass(frozen=True)
class PersonaModel:
    roles: dict[str, RoleProfile]
    experience: PersonaEffect
    familiarity: dict[str, PersonaEffect]
    reading_styles: dict[str, ReadingStyleProfile]

    def sample(self, random: Random) -> Persona:
        role = _weighted_choice(
            random, {name: profile.weight for name, profile in self.roles.items()}
        )
        profile = self.roles[role]
        years = round(random.uniform(*profile.experience_years), 3)
        familiarity = _weighted_choice(random, profile.familiarity_weights)
        style = _weighted_choice(
            random, {name: profile.weight for name, profile in self.reading_styles.items()}
        )
        return Persona(role, years, familiarity, style)

    def effect(self, persona: Persona, variant: str | None) -> PersonaEffect:
        decades = persona.experience_years / 10
        style = self.reading_styles[persona.reading_style]
        effects = [
            self.roles[persona.role].effect,
            PersonaEffect(
                self.experience.probability_delta * decades,
                self.experience.time_multiplier**decades,
            ),
            self.familiarity[persona.codebase_familiarity],
            style.effect,
        ]
        if variant is not None and variant in style.variant_effects:
            effects.append(style.variant_effects[variant])
        return PersonaEffect(
            sum(effect.probability_delta for effect in effects),
            math.prod(effect.time_multiplier for effect in effects),
        )


def _weighted_choice(random: Random, weights: dict[str, float]) -> str:
    return random.choices(list(weights), weights=list(weights.values()))[0]
