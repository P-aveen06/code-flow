"""Check the app_flow pieces journey: resolver, exposure, events, abandon, overrides and dry runs."""

from collections import Counter
from pathlib import Path

import pytest
import yaml
from flagsmith.models import DefaultFlag, Flag

import simulate
from clients import DryFlag, DryRunPiecesClient
from panels import generate_panel
from personas import Persona, PersonaModel
from pieces import (
    APP_FLOW,
    FLOWS,
    STACKING_SPLIT,
    STEPS,
    SWITCHES,
    TODAY,
    VERSIONS,
    PiecesExperiment,
    PiecesSummary,
    _Draws,
    _walk,
    dry_run_flags,
    fewest_clicks,
    flow_from_flag,
    is_pieces,
    load_pieces,
    parse_piece_overrides,
    read_visitor,
    resolve_piece,
    run_pieces,
)
from simulate import EXPERIMENTS_DIR

PERSONA = Persona("junior_dev", 3.0, "some", "visual")
FINISHER_EVENTS = [
    "import_started",
    "signin_started",
    "signin_completed",
    "app_installed",
    "repo_selected",
    "import_completed",
    "first_flow_viewed",
    "diff_understood",
    "diagram_moves",
    "branch_switched",
    "journey_completed",
    "journey_clicks",
    "dead_clicks",
]
TODAY_PIECES = dict.fromkeys(SWITCHES, TODAY)


@pytest.fixture
def app_flow(personas: PersonaModel) -> PiecesExperiment:
    return load_pieces(EXPERIMENTS_DIR / "app_flow.yaml", personas)


@pytest.fixture
def offline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(simulate, "REPO_ROOT", tmp_path)
    for name in (
        "FLAGSMITH_API_URL",
        "CODEFLOW_FLAGSMITH_ENV_KEY",
        "CODEFLOW_SIM_FLAGSMITH_ENV_KEY",
        "CODEFLOW_SIM_ENVIRONMENT",
    ):
        monkeypatch.delenv(name, raising=False)
    return tmp_path


def _flag(value: str, enabled: bool = True) -> Flag:
    return Flag(enabled=enabled, value=value, feature_id=1, feature_name="ui_buttons")


def _draws(passes: tuple[float, ...]) -> _Draws:
    """Fixed draws. A step passes when its pass draw is below its chance, so 0.0 passes always."""
    zeros = (0.0,) * len(STEPS)
    return _Draws(passes=passes, normals=zeros, dead=zeros, extra=zeros, moves=0.0)


def _failing_at(step: str) -> _Draws:
    index = STEPS.index(step)
    return _draws((0.0,) * index + (0.999,) * (len(STEPS) - index))


def _names(visit) -> list[str]:
    return [event for event, _ in visit.events]


def _index(identifier: str) -> int:
    return int(identifier.rsplit("-", 1)[1])


def _run(
    experiment: PiecesExperiment,
    panel,
    overrides: dict[str, str],
    seed: int = 7,
) -> dict[str, PiecesSummary]:
    client = DryRunPiecesClient(dry_run_flags(experiment, overrides))
    return run_pieces(
        client,
        experiment,
        reviewers=panel,
        model_name="hypothesis",
        rate=None,
        seed=seed,
    )


def _dead_total(summary: dict[str, PiecesSummary]) -> float:
    return sum(stats.dead_clicks * stats.visitors for stats in summary.values())


class HalfExposed(DryRunPiecesClient):
    """Leaves every odd visitor outside app_flow, as a visitor outside the experiment is."""

    def get_experiment_flag(self, feature_name, *, identifier, traits):
        if feature_name == APP_FLOW and _index(identifier) % 2:
            return DefaultFlag(enabled=False, value=None)
        return super().get_experiment_flag(feature_name, identifier=identifier, traits=traits)


@pytest.mark.parametrize(
    ("flow", "flag", "expected"),
    [
        (None, None, TODAY),
        (None, _flag("a"), TODAY),
        ("b", None, "b"),
        ("b", _flag("a", enabled=False), TODAY),
        ("b", DefaultFlag(enabled=False, value=None), TODAY),
        ("b", _flag("a"), "a"),
        ("b", _flag("c"), "c"),
        ("b", _flag("flow"), "b"),
        ("b", DefaultFlag(enabled=True, value=None), "b"),
    ],
)
def test_resolve_piece_follows_the_web_rules(flow, flag, expected) -> None:
    assert resolve_piece(flow, flag) == expected


@pytest.mark.parametrize(
    ("flag", "expected"),
    [
        (_flag("a"), "a"),
        (_flag("c"), "c"),
        (_flag("a", enabled=False), None),
        (_flag("today"), None),
        (DefaultFlag(enabled=False, value=None), None),
    ],
)
def test_app_flow_picks_a_flow_only_when_on(flag, expected) -> None:
    assert flow_from_flag(flag) == expected


def test_a_finisher_sends_each_event_once_in_journey_order(app_flow: PiecesExperiment) -> None:
    visit = _walk(app_flow, TODAY_PIECES, PERSONA, _draws((0.0,) * 7), neutral=False)
    assert visit.completed
    assert _names(visit) == FINISHER_EVENTS
    assert max(Counter(_names(visit)).values()) == 1


def test_journey_clicks_include_the_dead_clicks(app_flow: PiecesExperiment) -> None:
    visit = _walk(app_flow, TODAY_PIECES, PERSONA, _draws((0.0,) * 7), neutral=False)
    values = dict(visit.events)
    assert values["journey_clicks"] == fewest_clicks(app_flow, TODAY) + values["dead_clicks"]


def test_leaving_during_the_import_is_an_abandon(app_flow: PiecesExperiment) -> None:
    visit = _walk(app_flow, TODAY_PIECES, PERSONA, _failing_at("analysis"), neutral=False)
    assert not visit.completed
    assert _names(visit) == [
        "import_started",
        "signin_started",
        "signin_completed",
        "app_installed",
        "repo_selected",
        "import_abandoned",
        "dead_clicks",
    ]


def test_leaving_on_github_sends_nothing_more(app_flow: PiecesExperiment) -> None:
    visit = _walk(app_flow, TODAY_PIECES, PERSONA, _failing_at("sign_in"), neutral=False)
    assert _names(visit) == ["import_started", "signin_started"]


def test_leaving_before_signing_in_sends_only_dead_clicks(app_flow: PiecesExperiment) -> None:
    visit = _walk(app_flow, TODAY_PIECES, PERSONA, _failing_at("sign_in_start"), neutral=False)
    assert _names(visit) == ["dead_clicks"]


def test_leaving_after_the_import_is_not_an_abandon(app_flow: PiecesExperiment) -> None:
    visit = _walk(app_flow, TODAY_PIECES, PERSONA, _failing_at("first_flow"), neutral=False)
    assert "import_abandoned" not in _names(visit)
    assert _names(visit)[-1] == "dead_clicks"


def test_visitors_outside_app_flow_send_nothing(
    app_flow: PiecesExperiment, personas: PersonaModel
) -> None:
    flags = dry_run_flags(app_flow, {})
    flags[APP_FLOW] = DryFlag(enabled=False)
    client = DryRunPiecesClient(flags)
    panel = generate_panel(personas, n=30, prefix="off", seed=1)
    summary = run_pieces(
        client, app_flow, reviewers=panel, model_name="hypothesis", rate=None, seed=2
    )
    assert client.events == []
    assert client.closed
    assert all(stats.visitors == 0 for stats in summary.values())


def test_only_exposed_visitors_send_events(app_flow: PiecesExperiment, personas) -> None:
    panel = generate_panel(personas, n=40, prefix="half", seed=3)
    client = HalfExposed(dry_run_flags(app_flow, {}))
    summary = run_pieces(
        client, app_flow, reviewers=panel, model_name="hypothesis", rate=None, seed=5
    )
    sent = {identifier for event, identifier, _ in client.events if event != "$flag_exposure"}
    assert sent
    assert all(_index(identifier) % 2 == 0 for identifier in sent)
    assert sum(stats.visitors for stats in summary.values()) == 20


class StackingRound(DryRunPiecesClient):
    """app_flow is a plain split after its round is completed; only ui_colours is an experiment."""

    def _flag(self, name, identifier):
        flag = super()._flag(name, identifier)
        if name == APP_FLOW:
            return Flag(enabled=True, value=flag.value, feature_id=1, feature_name=name)
        return flag


def test_a_stacking_round_exposes_visitors_through_its_ui_experiment(
    app_flow: PiecesExperiment, personas
) -> None:
    panel = generate_panel(personas, n=30, prefix="stack", seed=3)
    client = StackingRound(dry_run_flags(app_flow, {"ui_colours": "split"}))
    summary = run_pieces(
        client, app_flow, reviewers=panel, model_name="hypothesis", rate=None, seed=5
    )
    exposures = [identifier for event, identifier, _ in client.events if event == "$flag_exposure"]
    assert sorted(exposures) == sorted(panel)
    assert {identifier for event, identifier, _ in client.events if event != "$flag_exposure"}
    assert sum(stats.visitors for stats in summary.values()) == 30


def test_every_visitor_is_exposed_to_app_flow_once(app_flow: PiecesExperiment, personas) -> None:
    panel = generate_panel(personas, n=60, prefix="expo", seed=4)
    client = DryRunPiecesClient(dry_run_flags(app_flow, {}))
    run_pieces(client, app_flow, reviewers=panel, model_name="hypothesis", rate=None, seed=6)
    exposures = [identifier for event, identifier, _ in client.events if event == "$flag_exposure"]
    assert sorted(exposures) == sorted(panel)


def test_the_same_seed_gives_the_same_summary(app_flow: PiecesExperiment, personas) -> None:
    panel = generate_panel(personas, n=200, prefix="same", seed=1)
    assert _run(app_flow, panel, {}, seed=7) == _run(app_flow, panel, {}, seed=7)


def test_turning_the_flow_view_layout_off_lowers_flow_a(
    app_flow: PiecesExperiment, personas
) -> None:
    panel = generate_panel(personas, n=1500, prefix="flow-view", seed=2)
    default = _run(app_flow, panel, {})["a"].completion_rate
    off = _run(app_flow, panel, {"ui_flow_view_layout": "off"})["a"].completion_rate
    assert off < default


def test_buttons_b_adds_dead_clicks_and_buttons_a_removes_them(
    app_flow: PiecesExperiment, personas
) -> None:
    panel = generate_panel(personas, n=1500, prefix="buttons", seed=2)
    default = _dead_total(_run(app_flow, panel, {}))
    more = _dead_total(_run(app_flow, panel, {"ui_buttons": "b"}))
    fewer = _dead_total(_run(app_flow, panel, {"ui_buttons": "a"}))
    assert fewer < default < more


def test_split_gives_each_visitor_their_own_buttons(app_flow: PiecesExperiment) -> None:
    assert dry_run_flags(app_flow, {"ui_buttons": "split"})["ui_buttons"].allocations == (
        STACKING_SPLIT
    )
    client = DryRunPiecesClient(dry_run_flags(app_flow, {"ui_buttons": "split"}))
    seen = Counter(
        read_visitor(client, f"split-{number}", {}).pieces["buttons"] for number in range(300)
    )
    assert set(seen) == set(FLOWS)


def test_fewest_clicks_match_the_designs(app_flow: PiecesExperiment) -> None:
    counts = {version: fewest_clicks(app_flow, version) for version in VERSIONS}
    assert counts == {TODAY: 10, "a": 9, "b": 8, "c": 9}


def test_the_shipped_experiment_is_a_pieces_file() -> None:
    assert is_pieces(EXPERIMENTS_DIR / "app_flow.yaml")
    assert not is_pieces(EXPERIMENTS_DIR / "flow_view.yaml")


def test_overrides_parse_into_switch_settings() -> None:
    assert parse_piece_overrides("ui_buttons=a, ui_flow_view_layout=off") == {
        "ui_buttons": "a",
        "ui_flow_view_layout": "off",
    }
    assert parse_piece_overrides("") == {}


@pytest.mark.parametrize(
    "text", ["ui_buttons", "buttons=a", "ui_nope=a", "ui_buttons=d", "ui_buttons="]
)
def test_bad_overrides_are_refused(text: str) -> None:
    with pytest.raises(ValueError):
        parse_piece_overrides(text)


def _mutated(tmp_path: Path, personas: PersonaModel, change) -> PiecesExperiment:
    data = yaml.safe_load((EXPERIMENTS_DIR / "app_flow.yaml").read_text(encoding="utf-8"))
    change(data)
    path = tmp_path / "app_flow.yaml"
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    return load_pieces(path, personas)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda d: d.update(flag="flow_view"), "must use the app_flow flag"),
        (lambda d: d["allocations"].update(c=30), "allocations must add up to 100"),
        (
            lambda d: d["pieces"]["landing_layout"]["a"]["sign_in_start"].pop("fewest_clicks"),
            "must set fewest_clicks",
        ),
        (
            lambda d: d["pieces"]["repos_layout"]["today"]["repo_pick"].update(fewest_clicks=2),
            "must match the base journey",
        ),
        (
            lambda d: d["pieces"]["font_family"]["a"].update(sign_in={"probability": 1.0}),
            "can change only the review step or all steps",
        ),
        (
            lambda d: d["journey"]["analysis"].update(diagram_moves=1),
            "journey.review must set diagram_moves",
        ),
        (
            lambda d: d["journey"]["sign_in"].update(probability=1.5),
            "must be between 0 and 1",
        ),
    ],
)
def test_bad_experiment_files_are_refused(
    tmp_path: Path, personas: PersonaModel, change, message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        _mutated(tmp_path, personas, change)


def test_dry_run_prints_each_flow_and_every_event(
    offline: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    args = ["--experiment", "app_flow", "--panel", "default", "--limit", "150", "--dry-run"]
    assert simulate.main(args) == 0
    out = capsys.readouterr().out
    assert "Simulated visitors (hypothesis model, dry run)" in out
    assert "Experiment flag app_flow (control a)." in out
    flow_rows = [
        fields
        for fields in map(str.split, out.splitlines())
        if fields and fields[0] in FLOWS and len(fields) == 5
    ]
    assert [fields[0] for fields in flow_rows] == list(FLOWS)
    assert sum(int(fields[1]) for fields in flow_rows) == 150
    assert "Visitors reaching each event" in out
    assert "import_abandoned" in out
    assert "Dry-run pieces" not in out


def test_dry_run_output_is_the_same_each_time(
    offline: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    args = ["--experiment", "app_flow", "--panel", "default", "--limit", "150", "--dry-run"]
    simulate.main(args)
    first = capsys.readouterr().out
    simulate.main(args)
    assert capsys.readouterr().out == first


def test_pieces_override_is_printed_and_changes_the_run(
    offline: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    base = ["--experiment", "app_flow", "--panel", "default", "--limit", "150", "--dry-run"]
    simulate.main(base)
    default = capsys.readouterr().out
    assert simulate.main([*base, "--pieces", "ui_flow_view_layout=off"]) == 0
    off = capsys.readouterr().out
    assert "Dry-run pieces: ui_flow_view_layout=off" in off
    assert off != default


def test_pieces_needs_a_dry_run(offline: Path, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit):
        simulate.main(["--experiment", "app_flow", "--pieces", "ui_buttons=a"])
    assert "--pieces works only with --dry-run" in capsys.readouterr().err


def test_pieces_entries_are_checked(offline: Path, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit):
        simulate.main(["--experiment", "app_flow", "--dry-run", "--pieces", "ui_buttons=d"])
    assert "buttons takes one of" in capsys.readouterr().err


def test_pieces_only_apply_to_pieces_experiments(
    offline: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    args = ["--experiment", "flow_view", "--dry-run", "--limit", "5", "--pieces", "ui_buttons=a"]
    assert simulate.main(args) == 1
    assert "--pieces applies only to pieces experiments" in capsys.readouterr().err
