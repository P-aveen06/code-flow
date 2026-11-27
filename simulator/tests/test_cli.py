"""Check the CLI configuration and SDK wiring with stubbed HTTP."""

import json
import sqlite3
from pathlib import Path

import pytest
from requests import PreparedRequest, Response, Session

import simulate
from clients import DryRunClient
from diffs import DiffSample


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    directory = tmp_path / "data" / "Flagsmith__flagsmith"
    directory.mkdir(parents=True)
    stats = {
        "nodes_added": 3,
        "nodes_removed": 0,
        "nodes_changed": 0,
        "edges_added": 0,
        "edges_removed": 0,
    }
    (directory / "commits.json").write_text(json.dumps({"commits": [{"stats": stats}]}))
    monkeypatch.setattr(simulate, "REPO_ROOT", tmp_path)
    for name in (
        "FLAGSMITH_API_URL",
        "CODEFLOW_FLAGSMITH_ENV_KEY",
        "CODEFLOW_SIM_FLAGSMITH_ENV_KEY",
        "CODEFLOW_SIM_ENVIRONMENT",
    ):
        monkeypatch.delenv(name, raising=False)
    return tmp_path


def test_dry_run_prints_a_simulated_summary(repo: Path, capsys: pytest.CaptureFixture[str]) -> None:
    (repo / ".env").write_text("CODEFLOW_FLAGSMITH_ENV_KEY=local-test-secret\n")
    assert simulate.main(["--dry-run", "--limit", "3", "--model", "null"]) == 0
    captured = capsys.readouterr()
    assert "Using Flagsmith environment code-flow/Development." in captured.out
    assert "Simulated reviewers (null model, dry run)" in captured.out
    assert "Flagsmith__flagsmith" in captured.out
    assert "Success rate" in captured.out
    assert "Median ms" in captured.out
    assert "Simulated persona counts" not in captured.out
    assert "local-test-secret" not in captured.out + captured.err


def test_dry_run_can_print_persona_counts(repo: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert simulate.main(["--dry-run", "--limit", "10", "--persona-summary"]) == 0
    table = capsys.readouterr().out.split("Simulated persona counts\n")[1].splitlines()
    assert table[0].split() == ["Attribute", "Value", "side_by_side", "overlay", "overlay_summary"]
    rows = [line.split() for line in table[1:]]
    assert len(rows) == 10
    for attribute in ("role", "codebase_familiarity", "reading_style"):
        assert (
            sum(int(count) for name, _, *counts in rows if name == attribute for count in counts)
            == 10
        )


@pytest.mark.parametrize("rejected", [False, True])
def test_sdk_posts_to_self_hosted_api_and_never_prints_keys(
    repo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], rejected: bool
) -> None:
    api_url = "https://flagsmith.example.test/prefix/api/v1"
    (repo / ".env").write_text(
        f"export FLAGSMITH_API_URL='{api_url}/' # self-hosted\n"
        "CODEFLOW_FLAGSMITH_ENV_KEY=production-test-secret\n"
        "CODEFLOW_SIM_FLAGSMITH_ENV_KEY=file-test-secret\n"
    )
    monkeypatch.setenv("CODEFLOW_SIM_FLAGSMITH_ENV_KEY", "shell-test-secret")
    calls: list[PreparedRequest] = []

    def stub_send(session: Session, request: PreparedRequest, **kwargs: object) -> Response:
        calls.append(request)
        response = Response()
        response.request = request
        response.url = request.url
        if request.url == f"{api_url}/identities/":
            response.status_code = 403 if rejected else 200
            response._content = json.dumps(
                {
                    "flags": [
                        {
                            "feature": {"id": 1, "name": "flow_view"},
                            "enabled": True,
                            "feature_state_value": "side_by_side",
                            "variant": "control-key",
                            "metadata": {
                                "experiment": {"id": 2, "name": "flow_view", "in_experiment": True}
                            },
                        }
                    ],
                    "detail": "shell-test-secret",
                }
            ).encode("utf-8")
        else:
            response.status_code = 202
            response._content = b"{}"
        return response

    monkeypatch.setattr(Session, "send", stub_send)
    assert simulate.main(["--panel", "generated", "--n", "1", "--prefix", "test-reviewer"]) == int(
        rejected
    )
    captured = capsys.readouterr()
    assert "Using Flagsmith environment code-flow/Development." in captured.out
    assert "Warning" not in captured.err
    assert "test-secret" not in captured.out + captured.err
    assert all(call.headers["X-Environment-Key"] == "shell-test-secret" for call in calls)
    assert calls[0].url == f"{api_url}/identities/"
    identity = json.loads(calls[0].body)
    assert identity["identifier"] == "test-reviewer-0001"
    traits = {trait["trait_key"]: trait["trait_value"] for trait in identity["traits"]}
    assert set(traits) == {"role", "experience_years", "codebase_familiarity", "reading_style"}
    assert isinstance(traits["experience_years"], (int, float))
    if rejected:
        assert len(calls) == 1
        assert "Flagsmith flag evaluation failed" in captured.err
        return

    identity_call, batch_call = calls
    assert identity_call.method == batch_call.method == "POST"
    assert batch_call.url.rstrip("/") == f"{api_url}/events"
    exposure, outcome = json.loads(batch_call.body)["events"]
    assert exposure["event"] == "$flag_exposure"
    assert exposure["feature_name"] == "flow_view"
    assert exposure["value"] == "control-key"
    assert exposure["identifier"] == outcome["identifier"] == "test-reviewer-0001"
    assert exposure["traits"] == outcome["traits"] == traits
    assert outcome["event"] in ("diff_understood", "diff_confusing")
    assert int(outcome["value"]) > 0


def test_missing_simulation_key_does_not_fall_back_to_production(repo, monkeypatch, capsys):
    (repo / ".env").write_text("CODEFLOW_FLAGSMITH_ENV_KEY=production-test-secret\n")
    monkeypatch.setattr(simulate, "flagsmith_client", lambda *_: pytest.fail("Unexpected SDK call"))

    assert simulate.main(["--limit", "1"]) == 1

    output = capsys.readouterr()
    assert "code-flow/Development" in output.out
    assert "Set CODEFLOW_SIM_FLAGSMITH_ENV_KEY" in output.err
    assert "python3 scripts/flagsmith_setup.py --environment Development" in output.err
    assert "test-secret" not in output.out + output.err


def test_production_requires_an_explicit_option_and_warns(repo, monkeypatch, capsys):
    (repo / ".env").write_text(
        "CODEFLOW_SIM_ENVIRONMENT=Production\n"
        "CODEFLOW_SIM_FLAGSMITH_ENV_KEY=simulation-test-secret\n"
        "CODEFLOW_FLAGSMITH_ENV_KEY=production-test-secret\n"
    )
    client = DryRunClient({"side_by_side": 100})
    keys = []

    def fake_client(api_url, key):
        keys.append(key)
        return client

    monkeypatch.setattr(simulate, "flagsmith_client", fake_client)
    args = ["--panel", "generated", "--n", "1", "--prefix", "new-reviewer"]
    assert simulate.main(args) == 1
    output = capsys.readouterr()
    assert "Targeting Production requires an explicit --environment Production." in output.err
    assert keys == []

    assert simulate.main([*args, "--environment", "Production"]) == 0
    output = capsys.readouterr()
    assert "code-flow/Production" in output.out
    assert "simulated users will go into the Production real-reviewer environment" in output.err
    assert "test-secret" not in output.out + output.err
    assert keys == ["production-test-secret"]
    assert client.closed


def test_live_simulation_uses_the_configured_non_production_environment(repo, monkeypatch, capsys):
    (repo / ".env").write_text(
        'CODEFLOW_SIM_ENVIRONMENT="QA \\"Preview\\""\nCODEFLOW_SIM_FLAGSMITH_ENV_KEY=test-sim-key\n'
    )
    keys = []

    def fake_client(api_url, key):
        keys.append(key)
        return DryRunClient({"side_by_side": 100})

    monkeypatch.setattr(simulate, "flagsmith_client", fake_client)
    assert simulate.main(["--limit", "1", "--environment", "Development"]) == 1
    assert "must match CODEFLOW_SIM_ENVIRONMENT" in capsys.readouterr().err
    assert simulate.main(["--limit", "1"]) == 0
    output = capsys.readouterr()
    assert 'code-flow/QA "Preview"' in output.out
    assert "test-sim-key" not in output.out + output.err
    assert keys == ["test-sim-key"]


@pytest.fixture
def second_experiment(repo: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    template = (simulate.EXPERIMENTS_DIR / "_template.yaml").read_text()
    config = template.replace("example_feature", "guided_review")
    config = config.replace("example_completed", "review_finished")
    config = config.replace("example_abandoned", "review_skipped")
    config = config.replace("success_probability: 0.60", "success_probability: 1.0")
    config = config.replace("success_probability: 0.65", "success_probability: 0.0")
    directory = repo / "experiments"
    directory.mkdir()
    (directory / "guided.yaml").write_text(config)
    (directory / "other.yaml").write_text(config.replace("flag: guided_review", "flag: other_flag"))
    monkeypatch.setattr(simulate, "EXPERIMENTS_DIR", directory)
    return "guided"


def test_a_second_experiment_uses_its_flag_events_and_stored_traits(
    second_experiment: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CODEFLOW_SIM_FLAGSMITH_ENV_KEY", "test-key")
    identities = []
    events = []

    def stub_send(session: Session, request: PreparedRequest, **kwargs: object) -> Response:
        response = Response()
        response.request = request
        response.url = request.url
        body = json.loads(request.body)
        if request.url.endswith("/identities/"):
            index = len(identities)
            identities.append(body)
            response.status_code = 200
            response._content = json.dumps(
                {
                    "flags": [
                        {
                            "feature": {"id": 1, "name": "guided_review"},
                            "enabled": True,
                            "feature_state_value": ("baseline", "treatment")[index],
                            "variant": ("control-key", "treatment-key")[index],
                            "metadata": {
                                "experiment": {"id": 2, "name": "guided", "in_experiment": True}
                            },
                        }
                    ]
                }
            ).encode()
        else:
            assert request.url.endswith("/events")
            events.extend(body["events"])
            response.status_code = 202
            response._content = b"{}"
        return response

    monkeypatch.setattr(Session, "send", stub_send)
    assert (
        simulate.main(
            ["--experiment", second_experiment, "--offset", "100", "--limit", "2", "--rate", "1000"]
        )
        == 0
    )

    assert [identity["identifier"] for identity in identities] == [
        "sim-persona-b-0001",
        "sim-persona-b-0002",
    ]
    assert [event["event"] for event in events] == [
        "$flag_exposure",
        "review_finished",
        "$flag_exposure",
        "review_skipped",
    ]
    assert events[0]["feature_name"] == events[2]["feature_name"] == "guided_review"
    expected_traits = [
        {
            "role": "junior_dev",
            "experience_years": 0.01,
            "codebase_familiarity": "none",
            "reading_style": "visual",
        },
        {
            "role": "junior_dev",
            "experience_years": 2.043,
            "codebase_familiarity": "high",
            "reading_style": "visual",
        },
    ]
    for index, (identity, traits) in enumerate(zip(identities, expected_traits, strict=True)):
        exposure, outcome = events[2 * index : 2 * index + 2]
        assert {item["trait_key"]: item["trait_value"] for item in identity["traits"]} == traits
        assert exposure["identifier"] == outcome["identifier"] == identity["identifier"]
        assert exposure["traits"] == outcome["traits"] == traits


def test_profiles_need_no_experiment_or_diff_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(simulate, "REPO_ROOT", tmp_path)
    assert simulate.main(["--panel", "default", "--profiles", "--experiment", "missing"]) == 0
    captured = capsys.readouterr()
    assert "Reviewer panel default (1,300 reviewers)" in captured.out
    assert "experience_years 0–2 403" in " ".join(captured.out.split())
    assert not (tmp_path / "data").exists()


@pytest.mark.parametrize(
    ("flag", "control"), [("flow_view", "side_by_side"), ("flow_direction", "horizontal")]
)
def test_guard_blocks_the_recorded_production_panel_before_contacting_flagsmith(
    repo: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    flag: str,
    control: str,
) -> None:
    def unexpected_client(*args: str) -> DryRunClient:
        pytest.fail("The repeat guard must block before starting the client.")

    monkeypatch.setenv("CODEFLOW_FLAGSMITH_ENV_KEY", "test-key")
    monkeypatch.setenv("CODEFLOW_SIM_FLAGSMITH_ENV_KEY", "test-sim-key")
    monkeypatch.setattr(
        simulate, "load_diffs", lambda *_, **__: ("Flagsmith__flagsmith", [DiffSample(3, 4)])
    )
    monkeypatch.setattr(simulate, "flagsmith_client", unexpected_client)
    args = ["--limit", "1", "--experiment", flag]
    production_args = [*args, "--environment", "Production"]
    assert simulate.main(production_args) == 1
    error = capsys.readouterr().err
    assert f"Flagsmith already counted 1 of the selected reviewers for {flag}" in error
    assert "--allow-repeat" in error

    client = DryRunClient({control: 100})
    monkeypatch.setattr(simulate, "flagsmith_client", lambda *_: client)
    assert simulate.main([*production_args, "--allow-repeat"]) == 0
    assert "Flagsmith already counted" in capsys.readouterr().err
    assert client.closed
    assert len(client.events) == 2

    client = DryRunClient({control: 100})
    assert simulate.main(args) == 0
    assert "already counted" not in capsys.readouterr().err
    assert client.closed
    assert len(client.events) == 2


def test_legacy_production_history_does_not_block_development(
    repo, second_experiment, monkeypatch, capsys
):
    monkeypatch.setenv("CODEFLOW_FLAGSMITH_ENV_KEY", "test-key")
    monkeypatch.setenv("CODEFLOW_SIM_FLAGSMITH_ENV_KEY", "test-sim-key")
    monkeypatch.setattr(simulate, "flagsmith_client", lambda *_: DryRunClient({"baseline": 100}))
    history = repo / "data" / "simulator-runs.sqlite3"
    with sqlite3.connect(history) as database:
        database.execute(
            "CREATE TABLE reviewer_runs (flag TEXT NOT NULL, identity TEXT NOT NULL, "
            "PRIMARY KEY (flag, identity))"
        )
        database.execute("INSERT INTO reviewer_runs VALUES ('guided_review', 'sim-reviewer-0001')")

    args = ["--experiment", second_experiment, "--panel", "generated", "--n", "1"]
    assert simulate.main(args) == 0
    assert "may already have counted" not in capsys.readouterr().err
    assert simulate.main([*args, "--environment", "Production"]) == 1
    assert "may already have counted 1" in capsys.readouterr().err
    with sqlite3.connect(history) as database:
        assert database.execute("SELECT * FROM reviewer_runs ORDER BY environment").fetchall() == [
            ("Development", "guided_review", "sim-reviewer-0001"),
            ("Production", "guided_review", "sim-reviewer-0001"),
        ]


def test_future_repeats_are_guarded_by_flag_and_overlapping_identities(
    second_experiment: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    clients: list[DryRunClient] = []
    monkeypatch.setenv("CODEFLOW_SIM_FLAGSMITH_ENV_KEY", "test-key")

    def fake_client(*args: str) -> DryRunClient:
        client = DryRunClient({"baseline": 100})
        clients.append(client)
        return client

    monkeypatch.setattr(simulate, "flagsmith_client", fake_client)
    args = ["--experiment", second_experiment, "--rate", "1000"]
    assert simulate.main([*args, "--offset", "2", "--limit", "2", "--dry-run"]) == 0
    assert simulate.main([*args, "--offset", "2", "--limit", "2"]) == 0
    assert simulate.main([*args, "--offset", "3", "--limit", "2"]) == 1
    error = capsys.readouterr().err
    assert (
        "Flagsmith may already have counted 1 of the selected reviewers for guided_review" in error
    )
    assert "--allow-repeat" in error
    assert clients[-1].closed and not clients[-1].events

    assert simulate.main([*args, "--offset", "4", "--limit", "1"]) == 0
    assert simulate.main([*args, "--offset", "3", "--limit", "2", "--allow-repeat"]) == 0
    assert (
        simulate.main(["--experiment", "other", "--offset", "3", "--limit", "2", "--rate", "1000"])
        == 0
    )
    assert all(client.closed for client in clients)
