"""Check behaviour configuration and size adjustments."""

from pathlib import Path
from random import Random

import pytest

from model import VARIANTS, BehaviourModel, VariantBehaviour, load_models
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
        ("overlay_summary:", "missing_variant:", "hypothesis must contain"),
        ("understood_probability: 0.55", "understood_probability: 1.1", "between 0 and 1"),
        ("median_ms: 48000", "median_ms: 0", "positive median_ms"),
        ("sigma: 0.5", "sigma: -0.5", "nonnegative sigma"),
        ("time_increase: 0.06", "time_increase: .inf", "must be a finite number"),
        ("understood_penalty: 0.04", "understood_penalty: -0.04", "must be nonnegative"),
    ],
)
def test_reject_invalid_models(tmp_path: Path, original: str, invalid: str, message: str) -> None:
    behaviour = (SIMULATOR_DIR / "behaviour.yaml").read_text()
    path = tmp_path / "behaviour.yaml"
    path.write_text(behaviour.replace(original, invalid, 1))
    with pytest.raises(ValueError, match=message):
        load_models(path)


def test_larger_diffs_reduce_understanding_and_increase_decision_time() -> None:
    model = BehaviourModel({"overlay": VariantBehaviour(0.66, 36000, 0)}, 0.04, 0.06)
    small = model.sample("overlay", 0, Random(5))
    large = model.sample("overlay", 10, Random(5))
    assert small.understood
    assert not large.understood
    assert small.elapsed_ms == 36000
    assert large.elapsed_ms == round(36000 * 1.06**10)
