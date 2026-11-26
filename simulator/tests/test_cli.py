"""Check the CLI configuration and SDK wiring with stubbed HTTP."""

import json
from pathlib import Path

import pytest
from requests import PreparedRequest, Response, Session

import simulate


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
    assert simulate.main(["--dry-run", "--n", "3", "--rate", "1000", "--model", "null"]) == 0
    captured = capsys.readouterr()
    assert "Simulated reviewers (null model, dry run)" in captured.out
    assert "shop-demo" in captured.out
    assert "Understood rate" in captured.out
    assert "Median ms" in captured.out
    assert "Simulated persona counts" not in captured.out
    assert "local-test-secret" not in captured.out + captured.err


def test_dry_run_can_print_persona_counts(repo: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert simulate.main(["--dry-run", "--n", "10", "--rate", "1000", "--persona-summary"]) == 0
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
    assert simulate.main(["--n", "1", "--prefix", "test-reviewer"]) == int(rejected)
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
