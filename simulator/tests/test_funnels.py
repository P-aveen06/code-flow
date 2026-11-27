"""Check the funnel mode used by the github_signin experiment."""

from collections import defaultdict
from pathlib import Path

import pytest
import yaml

import simulate
from clients import DryRunClient
from funnels import FunnelExperiment, FunnelSummary, is_funnel, load_funnel, run_funnel
from panels import generate_panel, load_panel
from personas import PersonaModel, load_personas
from simulate import EXPERIMENTS_DIR, PANELS_DIR, SIMULATOR_DIR

SIGNIN_EVENTS = {"signin_started", "signin_completed", "app_installed", "repo_selected"}


@pytest.fixture
def signin(personas: PersonaModel) -> FunnelExperiment:
    return load_funnel(EXPERIMENTS_DIR / "github_signin.yaml", personas)


def _run(
    experiment: FunnelExperiment, model: str, n: int = 3000, seed: int = 7
) -> tuple[dict[str, FunnelSummary], DryRunClient]:
    client = DryRunClient(experiment.allocations)
    personas = load_personas(SIMULATOR_DIR / "personas.yaml")
    summary = run_funnel(
        client,
        experiment,
        reviewers=generate_panel(personas, n=n, prefix="sim-visitor", seed=seed),
        model_name=model,
        rate=None,
        seed=seed,
    )
    return summary, client


def _journeys(client: DryRunClient) -> dict[str, list[tuple[str, object]]]:
    journeys: dict[str, list[tuple[str, object]]] = defaultdict(list)
    for event, identity, value in client.events:
        journeys[identity].append((event, value))
    return journeys


def test_loads_the_signin_experiment(signin: FunnelExperiment) -> None:
    assert is_funnel(EXPERIMENTS_DIR / "github_signin.yaml")
    assert not is_funnel(EXPERIMENTS_DIR / "flow_view.yaml")
    assert signin.flag == "github_signin"
    assert signin.control == "url_import"
    assert signin.allocations == {"url_import": 50, "github_signin": 50}
    null = signin.models["null"]
    assert null["github_signin"] == null["url_import"] == signin.models["hypothesis"]["url_import"]


def test_each_journey_follows_the_web_app_rules(signin: FunnelExperiment) -> None:
    summary, client = _run(signin, "hypothesis", n=500)
    journeys = _journeys(client)
    assert len(journeys) == 500
    for events in journeys.values():
        (exposure, variant), *rest = events
        assert exposure == "$flag_exposure" and variant in signin.allocations
        names = [name for name, _ in rest]
        assert len(names) == len(set(names)), "each event counts once per journey"
        if variant == "url_import":
            assert not SIGNIN_EVENTS.intersection(names)
        if not names:
            continue
        assert names[0] == "import_started"
        assert ("import_completed" in names) != ("import_abandoned" in names)
        values = dict(rest)
        if "import_completed" in names:
            assert names[-2:] == ["import_completed", "first_flow_viewed"]
            assert 0 < values["import_completed"] < values["first_flow_viewed"]
        else:
            assert names[-1] == "import_abandoned" and values["import_abandoned"] is None
        if "repo_selected" in names:
            assert names.index("signin_started") < names.index("signin_completed")
            assert names.index("app_installed") < names.index("repo_selected")
    for stats in summary.values():
        assert stats.event_counts["first_flow_viewed"] == stats.completed
    assert client.closed


def test_deterministic_with_seed(signin: FunnelExperiment) -> None:
    summary, client = _run(signin, "hypothesis", n=200)
    repeat, repeat_client = _run(signin, "hypothesis", n=200)
    _, other_seed = _run(signin, "hypothesis", n=200, seed=8)
    assert repeat == summary
    assert repeat_client.events == client.events
    assert other_seed.events != client.events


def test_hypothesis_trades_time_for_more_completed_imports(signin: FunnelExperiment) -> None:
    summary, _ = _run(signin, "hypothesis")
    control, variant = summary["url_import"], summary["github_signin"]
    assert variant.completion_rate > control.completion_rate + 0.08
    assert variant.median_ms > control.median_ms * 1.5


def test_null_model_shows_no_real_difference(signin: FunnelExperiment) -> None:
    summary, client = _run(signin, "null")
    control, variant = summary["url_import"], summary["github_signin"]
    assert abs(variant.completion_rate - control.completion_rate) < 0.05
    assert (
        max(control.median_ms, variant.median_ms) / min(control.median_ms, variant.median_ms) < 1.1
    )
    assert not SIGNIN_EVENTS.intersection(event for event, _, _ in client.events)


def test_default_panel_split(signin: FunnelExperiment, personas: PersonaModel) -> None:
    client = DryRunClient(signin.allocations)
    panel = load_panel("default", personas, PANELS_DIR)
    summary = run_funnel(
        client, signin, reviewers=panel, model_name="hypothesis", rate=None, seed=7
    )
    assert sum(stats.reviewers for stats in summary.values()) == 1300
    for stats in summary.values():
        assert sum(stats.persona_counts["role"].values()) == stats.reviewers


def test_cli_dry_run_needs_no_analyzed_commits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(simulate, "REPO_ROOT", tmp_path)
    monkeypatch.delenv("CODEFLOW_SIM_ENVIRONMENT", raising=False)
    argv = ["--experiment", "github_signin", "--dry-run", "--limit", "40", "--persona-summary"]
    assert simulate.main(argv) == 0
    out = capsys.readouterr().out
    assert "Simulated visitors (hypothesis model, dry run)" in out
    assert "Experiment flag github_signin (control url_import)." in out
    assert "Visitors reaching each event" in out
    for event in ("import_started", "signin_completed", "first_flow_viewed", "import_abandoned"):
        assert event in out
    assert "Simulated persona counts" in out


def _write(directory: Path, change) -> Path:
    config = yaml.safe_load((EXPERIMENTS_DIR / "github_signin.yaml").read_text())
    change(config)
    path = directory / "funnel.yaml"
    path.write_text(yaml.safe_dump(config))
    return path


def _routes(config: dict, variant: str = "github_signin", audience: str = "public") -> list:
    return config["variants"][variant][audience]


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda c: c.update(mode="review"), "must set mode: funnel"),
        (lambda c: c["private_share"].pop("new_joiner"), "private_share must contain"),
        (lambda c: c["private_share"].update(new_joiner=1.5), "between 0 and 1"),
        (lambda c: c.update(time_event="import_completed"), "must differ"),
        (
            lambda c: _routes(c)[0]["steps"][1].update(events=["import_completed"]),
            "cannot send import_completed",
        ),
        (lambda c: _routes(c)[0]["steps"][1].update(events=[]), "nonempty list of event names"),
        (lambda c: _routes(c)[1]["steps"].pop(0), "must send import_started"),
        (lambda c: _routes(c)[0].update(share=0.9), "shares must add up to at most 1"),
        (lambda c: _routes(c)[0]["steps"][0].update(median_ms=0), "positive median_ms"),
        (lambda c: c["variants"]["github_signin"].update(allocation=60), "add up to 100"),
        (lambda c: c["variants"]["github_signin"].update(control=True), "exactly one variant"),
        (lambda c: c["variants"]["github_signin"].pop("private"), "must contain these fields"),
    ],
)
def test_invalid_funnels_are_rejected(
    tmp_path: Path, personas: PersonaModel, change, message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        load_funnel(_write(tmp_path, change), personas)
