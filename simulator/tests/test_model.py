"""Check experiment assumptions and adjustments for diff size and persona."""

from dataclasses import replace
from pathlib import Path
from random import Random

import pytest

from experiments import Experiment, load_experiment
from model import VariantBehaviour
from personas import Persona, PersonaModel, load_personas
from simulate import EXPERIMENTS_DIR, SIMULATOR_DIR


def test_load_flow_view(flow_view: Experiment) -> None:
    assert flow_view.flag == "flow_view"
    assert flow_view.control == "side_by_side"
    assert flow_view.allocations == {"side_by_side": 34, "overlay": 33, "overlay_summary": 33}
    assert flow_view.success_event == "diff_understood"
    assert flow_view.failure_event == "diff_confusing"
    hypothesis = flow_view.models["hypothesis"]
    assert list(hypothesis.variants.values()) == [
        VariantBehaviour(0.55, 48000, 0.5),
        VariantBehaviour(0.66, 36000, 0.5),
        VariantBehaviour(0.72, 30000, 0.5),
    ]
    assert hypothesis.success_penalty == 0.04
    assert hypothesis.time_increase == 0.06
    assert set(flow_view.models["null"].variants.values()) == {VariantBehaviour(0.66, 36000, 0.5)}


def test_flow_direction_config_and_depth_effect(personas: PersonaModel) -> None:
    experiment = load_experiment(EXPERIMENTS_DIR / "flow_direction.yaml", personas)
    assert experiment.flag == "flow_direction"
    assert experiment.control == "horizontal"
    assert experiment.allocations == {"horizontal": 50, "vertical": 50}
    assert experiment.success_event == "layout_understood"
    assert experiment.failure_event == "layout_confusing"
    assert experiment.long_flows_only
    assert not experiment.record_failure_time
    model = experiment.models["hypothesis"]
    horizontal, vertical = model.variants.values()
    assert vertical.success_probability - horizontal.success_probability == pytest.approx(0.05)
    assert vertical.median_ms == pytest.approx(0.9 * horizontal.median_ms)

    persona = Persona("senior_dev", 10, "high", "visual")
    horizontal_decision = model.sample("horizontal", 2, Random(7), persona=persona, depth=4)
    assert horizontal_decision == model.sample("horizontal", 2, Random(7), persona=persona, depth=7)
    vertical_decision = model.sample("vertical", 2, Random(7), persona=persona, depth=4)
    deeper_decision = model.sample("vertical", 2, Random(7), persona=persona, depth=7)
    assert deeper_decision.elapsed_ms == pytest.approx(
        vertical_decision.elapsed_ms * 0.985**3, abs=1
    )

    null = experiment.models["null"]
    for seed in range(10):
        assert null.sample("horizontal", 2, Random(seed), persona=persona, depth=4) == null.sample(
            "vertical", 2, Random(seed), persona=persona, depth=7
        )


def test_template_parses(personas: PersonaModel) -> None:
    template = load_experiment(EXPERIMENTS_DIR / "_template.yaml", personas)
    assert template.flag == "example_feature"
    assert template.control == "baseline"
    assert template.allocations == {"baseline": 50, "treatment": 50}
    assert template.models["hypothesis"].persona_interactions == {}


@pytest.mark.parametrize(
    ("original", "invalid", "message"),
    [
        ("allocation: 34", "allocation: 24", "add up to 100"),
        ("    control: true\n", "", "exactly one variant"),
        ("success_probability: 0.55", "success_probability: 1.1", "between 0 and 1"),
        ("median_ms: 48000", "median_ms: 0", "positive median_ms"),
        ("sigma: 0.5", "sigma: -0.5", "nonnegative sigma"),
        ("time_increase: 0.06", "time_increase: .inf", "must be a finite number"),
        ("success_penalty: 0.04", "success_penalty: -0.04", "must be nonnegative"),
        (
            "persona_interactions:\n  overlay:",
            "persona_interactions:\n  unknown:",
            "persona_interactions",
        ),
        ("    reading_style:", "    unknown_trait:", "persona_interactions.overlay"),
        ("      visual:", "      unknown_style:", "persona_interactions.overlay.reading_style"),
    ],
)
def test_reject_invalid_experiment(
    tmp_path: Path, personas: PersonaModel, original: str, invalid: str, message: str
) -> None:
    config = (EXPERIMENTS_DIR / "flow_view.yaml").read_text()
    path = tmp_path / "experiment.yaml"
    path.write_text(config.replace(original, invalid, 1))
    with pytest.raises(ValueError, match=message):
        load_experiment(path, personas)


@pytest.mark.parametrize(
    ("original", "invalid", "message"),
    [
        ("experience_years: [0, 3]", "experience_years: [3, 0]", "ordered range"),
        ("{none: 25, some: 55, high: 20}", "{none: 0, some: 0, high: 0}", "positive, finite total"),
        ("time_multiplier: 1.04", "time_multiplier: 0", "positive multiplier"),
    ],
)
def test_reject_invalid_persona_definitions(
    tmp_path: Path, original: str, invalid: str, message: str
) -> None:
    config = (SIMULATOR_DIR / "personas.yaml").read_text()
    path = tmp_path / "personas.yaml"
    path.write_text(config.replace(original, invalid, 1))
    with pytest.raises(ValueError, match=message):
        load_personas(path)


def test_larger_diffs_reduce_success_and_increase_decision_time(flow_view: Experiment) -> None:
    model = replace(
        flow_view.models["null"], variants={"overlay": VariantBehaviour(0.66, 36000, 0)}
    )
    persona = Persona("junior_dev", 0, "some", "textual")
    small = model.sample("overlay", 0, Random(5), persona=persona)
    large = model.sample("overlay", 10, Random(5), persona=persona)
    assert small.succeeded
    assert not large.succeeded
    persona_median = 36000 * 1.04 * 1.01
    assert small.elapsed_ms == round(persona_median)
    assert large.elapsed_ms == round(persona_median * 1.06**10)


def test_sampled_personas_have_all_traits_in_range(personas: PersonaModel) -> None:
    random = Random(7)
    sampled = [personas.sample(random) for _ in range(100)]
    assert {persona.role for persona in sampled} == set(personas.roles)
    assert {persona.codebase_familiarity for persona in sampled} == set(personas.familiarity)
    assert {persona.reading_style for persona in sampled} == set(personas.reading_styles)
    for persona in sampled:
        low, high = personas.roles[persona.role].experience_years
        assert low <= persona.experience_years <= high
        assert persona.traits() == {
            "role": persona.role,
            "experience_years": persona.experience_years,
            "codebase_familiarity": persona.codebase_familiarity,
            "reading_style": persona.reading_style,
        }


def test_persona_effects_add_probability_and_multiply_time(flow_view: Experiment) -> None:
    model = flow_view.models["hypothesis"]
    visual = Persona("senior_dev", 10, "high", "visual")
    effect = model.persona_effect(visual, "overlay")
    assert effect.probability_delta == pytest.approx(0.015 + 0.012 + 0.035 + 0.005 + 0.012)
    assert effect.time_multiplier == pytest.approx(0.97 * 0.98 * 0.93 * 0.99 * 0.98)

    textual = replace(visual, reading_style="textual")
    overlay = model.persona_effect(textual, "overlay")
    summary = model.persona_effect(textual, "overlay_summary")
    assert summary.probability_delta == pytest.approx(overlay.probability_delta + 0.016)
    assert summary.time_multiplier == pytest.approx(overlay.time_multiplier * 0.97)


@pytest.mark.parametrize("style", ["visual", "textual"])
def test_null_decisions_are_identical_for_a_persona_across_variants(
    flow_view: Experiment, style: str
) -> None:
    model = flow_view.models["null"]
    persona = Persona("new_joiner", 5.5, "none", style)
    for seed in range(100):
        decisions = {
            model.sample(variant, 6, Random(seed), persona=persona) for variant in model.variants
        }
        assert len(decisions) == 1
