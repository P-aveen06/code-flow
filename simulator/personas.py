"""Sample reviewer personas and combine their effects on decisions."""

import math
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from random import Random

from config import number, read_yaml, section


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

    def effect(
        self, persona: Persona, extra_effects: Iterable[PersonaEffect] = ()
    ) -> PersonaEffect:
        decades = persona.experience_years / 10
        effects = [
            self.roles[persona.role].effect,
            PersonaEffect(
                self.experience.probability_delta * decades,
                self.experience.time_multiplier**decades,
            ),
            self.familiarity[persona.codebase_familiarity],
            self.reading_styles[persona.reading_style].effect,
            *extra_effects,
        ]
        return PersonaEffect(
            sum(effect.probability_delta for effect in effects),
            math.prod(effect.time_multiplier for effect in effects),
        )


def _weighted_choice(random: Random, weights: dict[str, float]) -> str:
    return random.choices(list(weights), weights=list(weights.values()))[0]


def read_effect(value: object, name: str) -> PersonaEffect:
    fields = section(value, name, "probability_delta", "time_multiplier")
    delta = number(fields, "probability_delta", name)
    multiplier = number(fields, "time_multiplier", name)
    if not -1 <= delta <= 1 or multiplier <= 0:
        raise ValueError(f"{name} requires a probability delta in [-1, 1] and positive multiplier.")
    return PersonaEffect(delta, multiplier)


def _validate_weights(weights: list[float], name: str) -> None:
    total = sum(weights)
    if any(weight < 0 for weight in weights) or not 0 < total < math.inf:
        raise ValueError(f"{name} weights must be nonnegative with a positive, finite total.")


def _role(value: object, name: str, familiarity: dict[str, PersonaEffect]) -> RoleProfile:
    fields = section(value, name, "weight", "experience_years", "familiarity_weights", "effect")
    years = fields["experience_years"]
    if (
        not isinstance(years, list)
        or len(years) != 2
        or any(type(year) is not int for year in years)
        or not 0 <= years[0] <= years[1]
    ):
        raise ValueError(
            f"{name}.experience_years must be an ordered range of nonnegative integers."
        )
    weights_name = f"{name}.familiarity_weights"
    weights = section(fields["familiarity_weights"], weights_name, *familiarity)
    familiarity_weights = {key: number(weights, key, weights_name) for key in weights}
    _validate_weights(list(familiarity_weights.values()), weights_name)
    return RoleProfile(
        weight=number(fields, "weight", name),
        experience_years=(years[0], years[1]),
        familiarity_weights=familiarity_weights,
        effect=read_effect(fields["effect"], f"{name}.effect"),
    )


def _reading_style(value: object, name: str) -> ReadingStyleProfile:
    fields = section(value, name, "weight", "effect")
    return ReadingStyleProfile(
        weight=number(fields, "weight", name),
        effect=read_effect(fields["effect"], f"{name}.effect"),
    )


def load_personas(path: Path) -> PersonaModel:
    config = section(
        read_yaml(path),
        "personas",
        "role",
        "experience_years",
        "codebase_familiarity",
        "reading_style",
    )
    familiarity_name = "personas.codebase_familiarity"
    familiarity = {
        key: read_effect(effect, f"{familiarity_name}.{key}")
        for key, effect in section(
            config["codebase_familiarity"], familiarity_name, "none", "some", "high"
        ).items()
    }
    roles = {
        key: _role(role, f"personas.role.{key}", familiarity)
        for key, role in section(
            config["role"],
            "personas.role",
            "junior_dev",
            "senior_dev",
            "pr_reviewer",
            "solution_architect",
            "new_joiner",
        ).items()
    }
    styles = {
        key: _reading_style(style, f"personas.reading_style.{key}")
        for key, style in section(
            config["reading_style"], "personas.reading_style", "visual", "textual"
        ).items()
    }
    _validate_weights([role.weight for role in roles.values()], "personas.role")
    _validate_weights([style.weight for style in styles.values()], "personas.reading_style")
    return PersonaModel(
        roles=roles,
        experience=read_effect(config["experience_years"], "personas.experience_years"),
        familiarity=familiarity,
        reading_styles=styles,
    )
