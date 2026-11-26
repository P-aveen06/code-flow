"""Check behaviour configuration and adjustments for diff size and persona."""

from dataclasses import replace
from pathlib import Path
from random import Random

import pytest

from model import VARIANTS, VariantBehaviour, load_models
from personas import Persona
from simulate import SIMULATOR_DIR


def test_load_models() -> None:
    models = load_models(SIMULATOR_DIR / "behaviour.yaml")
    hypothesis = models["hypothesis"]
    assert tuple(hypothesis.variants) == VARIANTS
    assert list(hypothesis.variants.values()) == [
        VariantBehaviour(0.55, 48000, 0.5),
        VariantBehaviour(0.66, 36000, 0.5),
        VariantBehaviour(0.72, 30000, 0.5),
    ]
    assert hypothesis.understood_penalty == 0.04
    assert hypothesis.time_increase == 0.06
    assert len(set(models["null"].variants.values())) == 1


@pytest.mark.parametrize(
    ("original", "invalid", "message"),
    [
        ("\n  overlay_summary:\n", "\n  missing_variant:\n", "hypothesis must contain"),
        ("understood_probability: 0.55", "understood_probability: 1.1", "between 0 and 1"),
        ("median_ms: 48000", "median_ms: 0", "positive median_ms"),
        ("sigma: 0.5", "sigma: -0.5", "nonnegative sigma"),
        ("time_increase: 0.06", "time_increase: .inf", "must be a finite number"),
        ("understood_penalty: 0.04", "understood_penalty: -0.04", "must be nonnegative"),
        ("experience_years: [0, 3]", "experience_years: [3, 0]", "ordered range"),
        ("{none: 25, some: 55, high: 20}", "{none: 0, some: 0, high: 0}", "positive, finite total"),
        ("time_multiplier: 1.04", "time_multiplier: 0", "positive multiplier"),
    ],
)
def test_reject_invalid_models(tmp_path: Path, original: str, invalid: str, message: str) -> None:
    behaviour = (SIMULATOR_DIR / "behaviour.yaml").read_text()
    path = tmp_path / "behaviour.yaml"
    path.write_text(behaviour.replace(original, invalid, 1))
    with pytest.raises(ValueError, match=message):
        load_models(path)


def test_larger_diffs_reduce_understanding_and_increase_decision_time() -> None:
    model = load_models(SIMULATOR_DIR / "behaviour.yaml")["null"]
    model = replace(model, variants={"overlay": VariantBehaviour(0.66, 36000, 0)})
    persona = Persona("junior_dev", 0, "some", "textual")
    small = model.sample("overlay", 0, Random(5), persona=persona)
    large = model.sample("overlay", 10, Random(5), persona=persona)
    assert small.understood
    assert not large.understood
    persona_median = 36000 * 1.04 * 1.01
    assert small.elapsed_ms == round(persona_median)
    assert large.elapsed_ms == round(persona_median * 1.06**10)


def test_sampled_personas_have_all_traits_in_range() -> None:
    model = load_models(SIMULATOR_DIR / "behaviour.yaml")["hypothesis"].personas
    random = Random(7)
    personas = [model.sample(random) for _ in range(100)]
    assert {persona.role for persona in personas} == set(model.roles)
    assert {persona.codebase_familiarity for persona in personas} == set(model.familiarity)
    assert {persona.reading_style for persona in personas} == set(model.reading_styles)
    for persona in personas:
        low, high = model.roles[persona.role].experience_years
        assert low <= persona.experience_years <= high
        assert persona.traits() == {
            "role": persona.role,
            "experience_years": persona.experience_years,
            "codebase_familiarity": persona.codebase_familiarity,
            "reading_style": persona.reading_style,
        }


def test_persona_effects_add_probability_and_multiply_time() -> None:
    model = load_models(SIMULATOR_DIR / "behaviour.yaml")["hypothesis"].personas
    visual = Persona("senior_dev", 10, "high", "visual")
    effect = model.effect(visual, "overlay")
    assert effect.probability_delta == pytest.approx(0.015 + 0.012 + 0.035 + 0.005 + 0.012)
    assert effect.time_multiplier == pytest.approx(0.97 * 0.98 * 0.93 * 0.99 * 0.98)

    textual = replace(visual, reading_style="textual")
    overlay = model.effect(textual, "overlay")
    summary = model.effect(textual, "overlay_summary")
    assert summary.probability_delta == pytest.approx(overlay.probability_delta + 0.016)
    assert summary.time_multiplier == pytest.approx(overlay.time_multiplier * 0.97)


@pytest.mark.parametrize("style", ["visual", "textual"])
def test_null_decisions_are_identical_for_a_persona_across_variants(style: str) -> None:
    model = load_models(SIMULATOR_DIR / "behaviour.yaml")["null"]
    persona = Persona("new_joiner", 5.5, "none", style)
    for seed in range(100):
        decisions = {
            model.sample(variant, 6, Random(seed), persona=persona) for variant in VARIANTS
        }
        assert len(decisions) == 1
