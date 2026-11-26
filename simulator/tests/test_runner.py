"""Verify offline allocation, event records, sampling, and pacing."""

import pytest
from flagsmith.models import DefaultFlag
from flagsmith.types import TraitMapping

from clients import DryRunClient
from experiments import Experiment
from panels import generate_panel, load_panel
from runner import SimulationError, VariantSummary, run_simulation
from simulate import PANELS_DIR


def _simulate(
    experiment: Experiment, model: str, n: int = 3000, seed: int = 7
) -> tuple[dict[str, VariantSummary], DryRunClient]:
    client = DryRunClient(experiment.allocations)
    personas = experiment.models[model].personas
    summary = run_simulation(
        client,
        experiment,
        [1, 2, 3, 7, 14],
        reviewers=generate_panel(personas, n=n, prefix="sim-reviewer", seed=seed),
        model_name=model,
        rate=None,
        seed=seed,
    )
    return summary, client


def test_deterministic_with_seed_and_assignment_is_sticky(flow_view: Experiment) -> None:
    summary, client = _simulate(flow_view, "hypothesis", n=100)
    repeat_summary, repeat_client = _simulate(flow_view, "hypothesis", n=100)
    _, different_seed = _simulate(flow_view, "hypothesis", n=100, seed=8)
    _, null_client = _simulate(flow_view, "null", n=100)

    assert repeat_summary == summary
    assert repeat_client.events == client.events
    assert repeat_client.identity_traits == null_client.identity_traits == client.identity_traits
    assert different_seed.identity_traits != client.identity_traits
    assert len({tuple(traits.values()) for traits in client.identity_traits.values()}) == 100
    assert different_seed.events[::2] == client.events[::2]
    assert different_seed.events[1::2] != client.events[1::2]


def test_hypothesis_split_and_success_rate(flow_view: Experiment) -> None:
    summary, client = _simulate(flow_view, "hypothesis")
    for variant, expected in zip(flow_view.allocations, (0.34, 0.33, 0.33), strict=True):
        assert summary[variant].reviewers / 3000 == pytest.approx(expected, abs=0.03)
    control, overlay, with_summary = (summary[name] for name in flow_view.allocations)
    assert control.success_rate < overlay.success_rate < with_summary.success_rate
    assert control.median_ms > overlay.median_ms > with_summary.median_ms
    assert client.closed


def test_null_rates_and_median_times_are_close(flow_view: Experiment) -> None:
    summary, _ = _simulate(flow_view, "null")
    rates = []
    medians = []
    for variant in summary.values():
        assert variant.success_rate is not None and variant.median_ms is not None
        rates.append(variant.success_rate)
        medians.append(variant.median_ms)
    assert max(rates) - min(rates) < 0.05
    assert max(medians) / min(medians) < 1.10


def test_each_reviewer_has_one_exposure_and_one_outcome(flow_view: Experiment) -> None:
    _, client = _simulate(flow_view, "hypothesis", n=100)
    exposures = client.events[::2]
    outcomes = client.events[1::2]
    assert len(exposures) == len(outcomes) == 100
    assert {event for event, _, _ in outcomes} == {"diff_understood", "diff_confusing"}
    for index, (exposure, outcome) in enumerate(zip(exposures, outcomes, strict=True), start=1):
        identity = f"sim-reviewer-{index:04d}"
        assert exposure[0:2] == ("$flag_exposure", identity)
        assert exposure[2] in flow_view.allocations
        assert outcome[1] == identity
        assert isinstance(outcome[2], int) and outcome[2] > 0


def test_persona_counts_follow_variant_assignments(flow_view: Experiment) -> None:
    summary, client = _simulate(flow_view, "hypothesis", n=100)
    for variant, stats in summary.items():
        traits = [
            client.identity_traits[identity]
            for _, identity, assignment in client.events[::2]
            if assignment == variant
        ]
        for name, counts in stats.persona_counts.items():
            assert sum(counts.values()) == stats.reviewers
            for value, count in counts.items():
                assert count == sum(persona[name] == value for persona in traits)


def test_throttle_accounts_for_request_time_and_only_sleeps_between_reviewers(
    flow_view: Experiment,
) -> None:
    waits: list[float] = []
    # The first reviewer takes 0.02 seconds and the second exceeds the 0.05 budget.
    clock_times = iter([0.00, 0.02, 0.05, 0.12, 0.12, 0.13, 0.17, 0.17])
    client = DryRunClient(flow_view.allocations)
    personas = flow_view.models["null"].personas
    run_simulation(
        client,
        flow_view,
        [1],
        reviewers=generate_panel(personas, n=4, prefix="test", seed=7),
        model_name="null",
        rate=20,
        seed=7,
        sleep_for=waits.append,
        clock=lambda: next(clock_times),
    )
    assert waits == pytest.approx([0.03, 0.04])


def test_close_after_an_ineligible_assignment(flow_view: Experiment) -> None:
    class IneligibleClient(DryRunClient):
        def get_experiment_flag(
            self, feature_name: str, *, identifier: str, traits: TraitMapping
        ) -> DefaultFlag:
            return DefaultFlag(enabled=False, value="side_by_side")

    client = IneligibleClient(flow_view.allocations)
    personas = flow_view.models["hypothesis"].personas
    with pytest.raises(SimulationError, match="active experiment"):
        run_simulation(
            client,
            flow_view,
            [1],
            reviewers=generate_panel(personas, n=1, prefix="test", seed=7),
            model_name="hypothesis",
            rate=None,
            seed=7,
        )
    assert client.closed
    assert client.events == []


def test_default_panel_dry_run_keeps_flow_view_ordering(flow_view: Experiment) -> None:
    client = DryRunClient(flow_view.allocations)
    panel = load_panel("default", flow_view.models["hypothesis"].personas, PANELS_DIR)
    summary = run_simulation(
        client,
        flow_view,
        [1, 2, 3, 7, 14],
        reviewers=panel,
        model_name="hypothesis",
        rate=None,
        seed=7,
    )
    assert list(client.identity_traits.items()) == [
        (identity, persona.traits()) for identity, persona in panel.items()
    ]
    assert sum(stats.reviewers for stats in summary.values()) == 1300
    control, overlay, overlay_summary = summary.values()
    assert control.success_rate < overlay.success_rate < overlay_summary.success_rate
    assert overlay_summary.median_ms < overlay.median_ms < control.median_ms
