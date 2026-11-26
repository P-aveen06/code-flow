"""Load reviewer behaviour assumptions and sample decisions."""

import math
from dataclasses import dataclass
from pathlib import Path
from random import Random

import yaml

from personas import Persona, PersonaEffect, PersonaModel, ReadingStyleProfile, RoleProfile

VARIANTS = ("side_by_side", "overlay", "overlay_summary")
MODELS = ("hypothesis", "null")


@dataclass(frozen=True)
class VariantBehaviour:
    understood_probability: float
    median_ms: float
    sigma: float


@dataclass(frozen=True)
class Decision:
    understood: bool
    elapsed_ms: int


@dataclass(frozen=True)
class BehaviourModel:
    variants: dict[str, VariantBehaviour]
    understood_penalty: float
    time_increase: float
    personas: PersonaModel
    use_variant_effects: bool

    def sample(self, variant: str, size: int, random: Random, *, persona: Persona) -> Decision:
        behaviour = self.variants[variant]
        effect = self.personas.effect(persona, variant if self.use_variant_effects else None)
        probability = (
            behaviour.understood_probability
            - self.understood_penalty * math.log1p(size)
            + effect.probability_delta
        )
        understood = random.random() < min(1.0, max(0.0, probability))
        log_median = math.log(behaviour.median_ms * effect.time_multiplier) + size * math.log1p(
            self.time_increase
        )
        elapsed_ms = max(1, round(random.lognormvariate(log_median, behaviour.sigma)))
        return Decision(understood, elapsed_ms)


def _section(value: object, name: str, *keys: str) -> dict[str, object]:
    if not isinstance(value, dict) or value.keys() != set(keys):
        raise ValueError(f"{name} must contain these fields: {', '.join(keys)}.")
    return value


def _number(section: dict[str, object], key: str, name: str) -> float:
    value = section[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name}.{key} must be a finite number.")
    return float(value)


def _behaviour(value: object, name: str) -> VariantBehaviour:
    section = _section(value, name, "understood_probability", "median_ms", "sigma")
    probability = _number(section, "understood_probability", name)
    median_ms = _number(section, "median_ms", name)
    sigma = _number(section, "sigma", name)
    if not 0 <= probability <= 1:
        raise ValueError(f"{name}.understood_probability must be between 0 and 1.")
    if median_ms <= 0 or sigma < 0:
        raise ValueError(f"{name} requires positive median_ms and nonnegative sigma.")
    return VariantBehaviour(probability, median_ms, sigma)


def _effect(value: object, name: str) -> PersonaEffect:
    section = _section(value, name, "probability_delta", "time_multiplier")
    delta = _number(section, "probability_delta", name)
    multiplier = _number(section, "time_multiplier", name)
    if not -1 <= delta <= 1 or multiplier <= 0:
        raise ValueError(f"{name} requires a probability delta in [-1, 1] and positive multiplier.")
    return PersonaEffect(delta, multiplier)


def _validate_weights(weights: list[float], name: str) -> None:
    total = sum(weights)
    if any(weight < 0 for weight in weights) or not 0 < total < math.inf:
        raise ValueError(f"{name} weights must be nonnegative with a positive, finite total.")


def _role(value: object, name: str, familiarity: dict[str, PersonaEffect]) -> RoleProfile:
    section = _section(value, name, "weight", "experience_years", "familiarity_weights", "effect")
    years = section["experience_years"]
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
    weights = _section(section["familiarity_weights"], weights_name, *familiarity)
    familiarity_weights = {key: _number(weights, key, weights_name) for key in weights}
    _validate_weights(list(familiarity_weights.values()), weights_name)
    return RoleProfile(
        weight=_number(section, "weight", name),
        experience_years=(years[0], years[1]),
        familiarity_weights=familiarity_weights,
        effect=_effect(section["effect"], f"{name}.effect"),
    )


def _reading_style(value: object, name: str) -> ReadingStyleProfile:
    section = _section(value, name, "weight", "effect", "variant_effects")
    variant_effects = section["variant_effects"]
    if not isinstance(variant_effects, dict) or not variant_effects.keys() <= set(VARIANTS):
        raise ValueError(f"{name}.variant_effects must use known variants.")
    return ReadingStyleProfile(
        weight=_number(section, "weight", name),
        effect=_effect(section["effect"], f"{name}.effect"),
        variant_effects={
            variant: _effect(effect, f"{name}.variant_effects.{variant}")
            for variant, effect in variant_effects.items()
        },
    )


def _persona_model(value: object) -> PersonaModel:
    config = _section(
        value, "personas", "role", "experience_years", "codebase_familiarity", "reading_style"
    )
    familiarity_name = "personas.codebase_familiarity"
    familiarity = {
        key: _effect(effect, f"{familiarity_name}.{key}")
        for key, effect in _section(
            config["codebase_familiarity"], familiarity_name, "none", "some", "high"
        ).items()
    }
    roles = {
        key: _role(role, f"personas.role.{key}", familiarity)
        for key, role in _section(
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
        for key, style in _section(
            config["reading_style"], "personas.reading_style", "visual", "textual"
        ).items()
    }
    _validate_weights([role.weight for role in roles.values()], "personas.role")
    _validate_weights([style.weight for style in styles.values()], "personas.reading_style")
    return PersonaModel(
        roles=roles,
        experience=_effect(config["experience_years"], "personas.experience_years"),
        familiarity=familiarity,
        reading_styles=styles,
    )


def load_models(path: Path) -> dict[str, BehaviourModel]:
    """Validate both models in the behaviour file."""
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise ValueError(f"Invalid YAML in {path.name}.") from exc

    config = _section(raw, path.name, "size_effects", "personas", *MODELS)
    effects = _section(
        config["size_effects"], "size_effects", "understood_penalty", "time_increase"
    )
    penalty = _number(effects, "understood_penalty", "size_effects")
    increase = _number(effects, "time_increase", "size_effects")
    if penalty < 0 or increase < 0:
        raise ValueError("Size effects must be nonnegative.")

    hypothesis = _section(config["hypothesis"], "hypothesis", *VARIANTS)
    null = _behaviour(config["null"], "null")
    personas = _persona_model(config["personas"])
    return {
        "hypothesis": BehaviourModel(
            {name: _behaviour(hypothesis[name], f"hypothesis.{name}") for name in VARIANTS},
            penalty,
            increase,
            personas,
            use_variant_effects=True,
        ),
        "null": BehaviourModel(
            dict.fromkeys(VARIANTS, null), penalty, increase, personas, use_variant_effects=False
        ),
    }
