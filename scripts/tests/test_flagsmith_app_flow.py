"""Switch the app_flow and ui_* flags between rounds against the in-memory Admin API."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import flagsmith_app_flow as switches
import flagsmith_setup as setup_script
from test_flagsmith_setup import FakeAdminClient


@pytest.fixture
def flagsmith(tmp_path):
    """A code-flow project whose Development environment has the 12 app-flow flags."""
    client = FakeAdminClient()
    project = client.add_project()
    development = client.add_environment(project, "Development")
    client.add_environment(project, "Production")
    env_file = tmp_path / ".env"
    env_file.write_text("FLAGSMITH_ADMIN_API_KEY=test-admin-secret\n")
    setup_script.setup(
        client,
        env_file,
        dry_run=False,
        environment_name="Development",
        scope_file=tmp_path / "scopes.json",
        only=setup_script.APP_FLOW_TAG,
    )
    return client, development


def settings(client, environment):
    return {
        name: switches.describe(*client.project_flag(environment, name))
        for name in switches.FLAG_NAMES
    }


def test_round_one_state_reads_as_split_and_flow(flagsmith):
    client, development = flagsmith
    assert settings(client, development) == {
        "app_flow": "split",
        **{name: "flow" for name in setup_script.UI_SWITCH_NAMES},
    }


def test_ablation_turns_switches_off_and_reset_restores_round_one(flagsmith, capsys):
    client, development = flagsmith
    switches.set_flags(
        client,
        "Development",
        {"ui_flow_view_layout": "off", "ui_branch_switch": "off"},
        dry_run=False,
    )
    after = settings(client, development)
    assert after["ui_flow_view_layout"] == after["ui_branch_switch"] == "off"
    assert after["ui_buttons"] == "flow" and after["app_flow"] == "split"
    assert "ui_flow_view_layout: flow -> off" in capsys.readouterr().out

    switches.set_flags(
        client,
        "Development",
        {"app_flow": "split", **{name: "flow" for name in setup_script.UI_SWITCH_NAMES}},
        dry_run=False,
    )
    assert settings(client, development) == {
        "app_flow": "split",
        **{name: "flow" for name in setup_script.UI_SWITCH_NAMES},
    }


@pytest.mark.parametrize("setting", ["split", "a", "b", "c"])
def test_stacking_splits_or_pins_one_switch(flagsmith, setting):
    client, development = flagsmith
    switches.set_flags(client, "Development", {"ui_colours": setting}, dry_run=False)
    feature, state = client.project_flag(development, "ui_colours")
    assert switches.describe(feature, state) == setting
    assert state["enabled"] is True
    weights = {
        row["multivariate_feature_option"]: row["percentage_allocation"]
        for row in state["multivariate_feature_state_values"]
    }
    by_value = {option["string_value"]: option["id"] for option in feature["multivariate_options"]}
    expected = {"a": 0, "b": 33, "c": 33} if setting == "split" else {"a": 0, "b": 0, "c": 0}
    assert weights == {by_value[value]: weight for value, weight in expected.items()}


def test_off_keeps_the_split_so_turning_on_again_restores_it(flagsmith):
    client, development = flagsmith
    switches.set_flags(client, "Development", {"app_flow": "off"}, dry_run=False)
    feature, state = client.project_flag(development, "app_flow")
    assert switches.describe(feature, state) == "off"
    assert state["feature_state_value"] == "a"
    assert sorted(
        row["percentage_allocation"] for row in state["multivariate_feature_state_values"]
    ) == [
        33,
        33,
    ]


def test_dry_run_sends_only_gets(flagsmith, capsys):
    client, development = flagsmith
    client.calls.clear()
    switches.set_flags(client, "Development", {"ui_buttons": "off"}, dry_run=True)
    assert {method for method, _ in client.calls} == {"GET"}
    assert "ui_buttons: would change flow -> off" in capsys.readouterr().out
    assert settings(client, development)["ui_buttons"] == "flow"


def test_a_flag_with_a_running_experiment_is_left_to_flagsmith(flagsmith):
    client, development = flagsmith
    feature, _ = client.project_flag(development, "app_flow")
    client.experiments[development["id"]] = [
        {
            "id": 41,
            "name": "app_flow round 1",
            "status": "running",
            "feature": {"id": feature["id"]},
        }
    ]
    with pytest.raises(switches.SetupError, match="app_flow has a running experiment"):
        switches.set_flags(client, "Development", {"app_flow": "a"}, dry_run=False)
    # Other switches can still change during the round.
    switches.set_flags(client, "Development", {"ui_buttons": "off"}, dry_run=False)


@pytest.mark.parametrize(
    ("entries", "message"),
    [
        (["ui_buttons"], "Use NAME=SETTING"),
        (["ui_nope=off"], "Unknown flag"),
        (["app_flow=flow"], "app_flow takes one of off, split, a, b, c"),
        (["ui_buttons=off", "ui_buttons=a"], "set twice"),
        ([], "at least one flag"),
    ],
)
def test_assignments_are_checked(entries, message):
    with pytest.raises(switches.SetupError, match=message):
        switches.parse_assignments(entries)


def test_production_is_refused(tmp_path, monkeypatch, capsys):
    env_file = tmp_path / ".env"
    env_file.write_text("FLAGSMITH_ADMIN_API_KEY=test-admin-secret\n")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "flagsmith_app_flow.py",
            "--env-file",
            str(env_file),
            "--environment",
            "production",
            "show",
        ],
    )
    assert switches.main() == 1
    assert "Production is refused" in capsys.readouterr().err
