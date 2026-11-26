"""Check the CLI configuration and SDK wiring with stubbed HTTP."""

import json
from pathlib import Path

import pytest
from requests import PreparedRequest, Response, Session

import simulate
from clients import DryRunClient


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    directory = tmp_path / "data" / "shop-demo"
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
    monkeypatch.delenv("FLAGSMITH_API_URL", raising=False)
    monkeypatch.delenv("CODEFLOW_FLAGSMITH_ENV_KEY", raising=False)
    return tmp_path


def test_dry_run_prints_a_simulated_summary(repo: Path, capsys: pytest.CaptureFixture[str]) -> None:
    (repo / ".env").write_text("CODEFLOW_FLAGSMITH_ENV_KEY=local-test-secret\n")
    assert simulate.main(["--dry-run", "--limit", "3", "--model", "null"]) == 0
    captured = capsys.readouterr()
    assert "Simulated reviewers (null model, dry run)" in captured.out
    assert "shop-demo" in captured.out
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
        "CODEFLOW_FLAGSMITH_ENV_KEY=file-test-secret\n"
    )
    monkeypatch.setenv("CODEFLOW_FLAGSMITH_ENV_KEY", "shell-test-secret")
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
    assert "file-test-secret" not in captured.out + captured.err
    assert "shell-test-secret" not in captured.out + captured.err
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
    monkeypatch.setenv("CODEFLOW_FLAGSMITH_ENV_KEY", "test-key")
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


def test_guard_blocks_the_recorded_flow_view_panel_before_contacting_flagsmith(
    repo: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    def unexpected_client(*args: str) -> DryRunClient:
        pytest.fail("The repeat guard must block before starting the client.")

    monkeypatch.setattr(simulate, "flagsmith_client", unexpected_client)
    assert simulate.main(["--experiment", "flow_view", "--panel", "default", "--limit", "1"]) == 1
    error = capsys.readouterr().err
    assert "Flagsmith already counted 1 of the selected reviewers for flow_view" in error
    assert "--allow-repeat" in error

    client = DryRunClient({"side_by_side": 100})
    monkeypatch.setattr(simulate, "flagsmith_client", lambda *_: client)
    assert simulate.main(["--limit", "1", "--allow-repeat"]) == 0
    assert "Flagsmith already counted" in capsys.readouterr().err
    assert client.closed
    assert len(client.events) == 2


def test_future_repeats_are_guarded_by_flag_and_overlapping_identities(
    second_experiment: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    clients: list[DryRunClient] = []

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
