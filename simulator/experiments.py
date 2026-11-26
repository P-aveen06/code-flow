"""Load an experiment's flag, outcomes, and behaviour assumptions."""

from dataclasses import dataclass
from pathlib import Path

from config import name_value, number, read_yaml, section
from model import BehaviourModel, PersonaInteractions, VariantBehaviour
from personas import PersonaModel, read_effect


@dataclass(frozen=True)
class Experiment:
    flag: str
    control: str
    allocations: dict[str, int]
    success_event: str
    failure_event: str
    models: dict[str, BehaviourModel]
    long_flows_only: bool = False
    record_failure_time: bool = True


def _behaviour(fields: dict[str, object], name: str) -> VariantBehaviour:
    probability = number(fields, "success_probability", name)
    median_ms = number(fields, "median_ms", name)
    sigma = number(fields, "sigma", name)
    if not 0 <= probability <= 1:
        raise ValueError(f"{name}.success_probability must be between 0 and 1.")
    if median_ms <= 0 or sigma < 0:
        raise ValueError(f"{name} requires positive median_ms and nonnegative sigma.")
    if "per_extra_layer" in fields:
        return VariantBehaviour(
            probability,
            median_ms,
            sigma,
            read_effect(fields["per_extra_layer"], f"{name}.per_extra_layer"),
        )
    return VariantBehaviour(probability, median_ms, sigma)


def _interactions(
    value: object, variants: dict[str, VariantBehaviour], personas: PersonaModel
) -> PersonaInteractions:
    interactions: PersonaInteractions = {}
    traits = {
        "role": personas.roles,
        "codebase_familiarity": personas.familiarity,
        "reading_style": personas.reading_styles,
    }
    for variant, raw_traits in section(
        value, "persona_interactions", optional=tuple(variants)
    ).items():
        name = f"persona_interactions.{variant}"
        interactions[variant] = {}
        for trait, raw_effects in section(raw_traits, name, optional=tuple(traits)).items():
            trait_name = f"{name}.{trait}"
            effects = section(raw_effects, trait_name, optional=tuple(traits[trait]))
            interactions[variant][trait] = {
                value: read_effect(effect, f"{trait_name}.{value}")
                for value, effect in effects.items()
            }
    return interactions


def load_experiment(path: Path, personas: PersonaModel) -> Experiment:
    config = section(
        read_yaml(path),
        path.name,
        "flag",
        "success_event",
        "failure_event",
        "variants",
        "size_effects",
        "null",
        optional=("persona_interactions", "long_flows_only", "record_failure_time"),
    )
    flag = name_value(config["flag"], "flag")
    success = name_value(config["success_event"], "success_event")
    failure = name_value(config["failure_event"], "failure_event")
    if success == failure:
        raise ValueError("success_event and failure_event must be different.")
    long_flows_only = config.get("long_flows_only", False)
    record_failure_time = config.get("record_failure_time", True)
    if type(long_flows_only) is not bool or type(record_failure_time) is not bool:
        raise ValueError("long_flows_only and record_failure_time must be true or false.")

    assumptions = ("success_probability", "median_ms", "sigma")
    raw_variants = config["variants"]
    if not isinstance(raw_variants, dict) or len(raw_variants) < 2:
        raise ValueError("variants must contain at least two variant values.")
    variants = {}
    allocations = {}
    controls = []
    for key, value in raw_variants.items():
        variant = name_value(key, "Variant value")
        name = f"variants.{variant}"
        fields = section(
            value, name, "allocation", *assumptions, optional=("control", "per_extra_layer")
        )
        allocation = fields["allocation"]
        if type(allocation) is not int or not 0 <= allocation <= 100:
            raise ValueError(f"{name}.allocation must be a whole percentage from 0 to 100.")
        allocations[variant] = allocation
        control = fields.get("control", False)
        if control is True:
            controls.append(variant)
        elif control is not False:
            raise ValueError(f"{name}.control must be true or false.")
        variants[variant] = _behaviour(fields, name)
    if len(controls) != 1:
        raise ValueError("Mark exactly one variant as the control.")
    if sum(allocations.values()) != 100:
        raise ValueError("Dry-run variant allocations must add up to 100.")

    effects = section(config["size_effects"], "size_effects", "success_penalty", "time_increase")
    penalty = number(effects, "success_penalty", "size_effects")
    increase = number(effects, "time_increase", "size_effects")
    if penalty < 0 or increase < 0:
        raise ValueError("Size effects must be nonnegative.")
    interactions = _interactions(config.get("persona_interactions", {}), variants, personas)
    null = _behaviour(section(config["null"], "null", *assumptions), "null")
    return Experiment(
        flag=flag,
        control=controls[0],
        allocations=allocations,
        success_event=success,
        failure_event=failure,
        models={
            "hypothesis": BehaviourModel(variants, penalty, increase, personas, interactions),
            "null": BehaviourModel(dict.fromkeys(variants, null), penalty, increase, personas),
        },
        long_flows_only=long_flows_only,
        record_failure_time=record_failure_time,
    )
