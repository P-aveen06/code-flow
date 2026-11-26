"""Verify offline allocation, event records, sampling, and pacing."""

import pytest
from flagsmith.models import DefaultFlag

from clients import DryRunClient
from model import VARIANTS, load_models
from runner import SimulationError, VariantSummary, run_simulation
from simulate import SIMULATOR_DIR


def _simulate(
    model: str, n: int = 3000, seed: int = 7
) -> tuple[dict[str, VariantSummary], DryRunClient]:
    client = DryRunClient()
    summary = run_simulation(
        client,
        load_models(SIMULATOR_DIR / "behaviour.yaml")[model],
        [1, 2, 3, 7, 14],
        n=n,
        rate=20,
        seed=seed,
        prefix="sim-reviewer",
        sleep_for=lambda seconds: None,
    )
    return summary, client


def test_deterministic_with_seed_and_assignment_is_sticky() -> None:
    summary, client = _simulate("hypothesis", n=100)
    repeat_summary, repeat_client = _simulate("hypothesis", n=100)
    _, different_seed = _simulate("hypothesis", n=100, seed=8)

    assert repeat_summary == summary
    assert repeat_client.events == client.events
    assert different_seed.events[::2] == client.events[::2]
    assert different_seed.events[1::2] != client.events[1::2]


def test_hypothesis_split_and_understood_rate() -> None:
    summary, client = _simulate("hypothesis")
    for variant, expected in zip(VARIANTS, (0.34, 0.33, 0.33), strict=True):
        assert summary[variant].reviewers / 3000 == pytest.approx(expected, abs=0.03)
    control, overlay, with_summary = (summary[name] for name in VARIANTS)
    assert control.understood_rate < overlay.understood_rate < with_summary.understood_rate
    assert control.median_ms > overlay.median_ms > with_summary.median_ms
    assert client.closed


def test_null_rates_and_median_times_are_close() -> None:
    summary, _ = _simulate("null")
    rates = []
    medians = []
    for variant in summary.values():
        assert variant.understood_rate is not None and variant.median_ms is not None
        rates.append(variant.understood_rate)
        medians.append(variant.median_ms)
    assert max(rates) - min(rates) < 0.05
    assert max(medians) / min(medians) < 1.10


def test_each_reviewer_has_one_exposure_and_one_outcome() -> None:
    _, client = _simulate("hypothesis", n=100)
    exposures = client.events[::2]
    outcomes = client.events[1::2]
    assert len(exposures) == len(outcomes) == 100
    assert {event for event, _, _ in outcomes} == {"diff_understood", "diff_confusing"}
    for index, (exposure, outcome) in enumerate(zip(exposures, outcomes, strict=True), start=1):
        identity = f"sim-reviewer-{index:04d}"
        assert exposure[0:2] == ("$flag_exposure", identity)
        assert exposure[2] in VARIANTS
        assert outcome[1] == identity
        assert isinstance(outcome[2], int) and outcome[2] > 0


def test_throttle_accounts_for_request_time_and_only_sleeps_between_reviewers() -> None:
    waits: list[float] = []
    # The first reviewer takes 0.02 seconds and the second exceeds the 0.05 budget.
    clock_times = iter([0.00, 0.02, 0.05, 0.12, 0.12, 0.13, 0.17, 0.17])
    client = DryRunClient()
    run_simulation(
        client,
        load_models(SIMULATOR_DIR / "behaviour.yaml")["null"],
        [1],
        n=4,
        rate=20,
        seed=7,
        prefix="test",
        sleep_for=waits.append,
        clock=lambda: next(clock_times),
    )
    assert waits == pytest.approx([0.03, 0.04])


def test_close_after_an_ineligible_assignment() -> None:
    class IneligibleClient(DryRunClient):
        def get_experiment_flag(self, feature_name: str, *, identifier: str) -> DefaultFlag:
            return DefaultFlag(enabled=False, value="side_by_side")

    client = IneligibleClient()
    with pytest.raises(SimulationError, match="active experiment"):
        run_simulation(
            client,
            load_models(SIMULATOR_DIR / "behaviour.yaml")["hypothesis"],
            [1],
            n=1,
            rate=20,
            seed=7,
            prefix="test",
        )
    assert client.closed
    assert client.events == []
