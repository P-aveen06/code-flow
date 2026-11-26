"""Load reviewer behaviour assumptions and sample decisions."""

import math
from dataclasses import dataclass
from pathlib import Path
from random import Random

import yaml

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

    def sample(self, variant: str, size: int, random: Random) -> Decision:
        behaviour = self.variants[variant]
        probability = max(
            0.0, behaviour.understood_probability - self.understood_penalty * math.log1p(size)
        )
        understood = random.random() < probability
        log_median = math.log(behaviour.median_ms) + size * math.log1p(self.time_increase)
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


def load_models(path: Path) -> dict[str, BehaviourModel]:
    """Validate both models in the behaviour file."""
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise ValueError(f"Invalid YAML in {path.name}.") from exc

    config = _section(raw, path.name, "size_effects", *MODELS)
    effects = _section(
        config["size_effects"], "size_effects", "understood_penalty", "time_increase"
    )
    penalty = _number(effects, "understood_penalty", "size_effects")
    increase = _number(effects, "time_increase", "size_effects")
    if penalty < 0 or increase < 0:
        raise ValueError("Size effects must be nonnegative.")

    hypothesis = _section(config["hypothesis"], "hypothesis", *VARIANTS)
    null = _behaviour(config["null"], "null")
    return {
        "hypothesis": BehaviourModel(
            {name: _behaviour(hypothesis[name], f"hypothesis.{name}") for name in VARIANTS},
            penalty,
            increase,
        ),
        "null": BehaviourModel(dict.fromkeys(VARIANTS, null), penalty, increase),
    }
