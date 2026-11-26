"""Exercise scoped Flagsmith state and findings using the analyzed shop demo."""

import json
import logging
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock

import pytest
from codeflow.analyze import analyze_repo, load_index
from codeflow.graph import Commit
from fastapi.testclient import TestClient
from flagsmith.exceptions import FlagsmithAPIError
from flagsmith.models import Flag, Flags
from requests import PreparedRequest, Response

from app import config
from app.config import Settings
from app.flagsmith_client import FlagsmithClient, FlagStates
from app.main import create_app

URL = "/api/repos/shop-demo/flags"
TEST_KEY = "ser.fake-secret-for-tests"


class FakeFlagsmith:
    def __init__(self, states: FlagStates) -> None:
        self.states = states
        self.calls = 0
        self.error: FlagsmithAPIError | None = None

    def get_environment_flags(self) -> Flags:
        self.calls += 1
        if self.error:
            raise self.error
        return Flags(
            flags={
                name: Flag(enabled, value, feature_id, name)
                for feature_id, (name, (enabled, value)) in enumerate(self.states.items())
            }
        )


@pytest.fixture
def settings(demo_data: Path, tmp_path: Path) -> Settings:
    scopes = tmp_path / "scopes.json"
    scopes.write_text(
        json.dumps(
            {
                "schema": "code-flow/flagsmith-scopes@1",
                "environment": "Production",
                "repos": {
                    "shop-demo": ["new_checkout", "unused_demo", "flow_view"],
                    "other": ["holiday_discount", "other_demo"],
                },
                "code_flow_flags": ["flow_view"],
            }
        )
    )
    return Settings(demo_data, "http://example.test", scopes_path=scopes)


def test_scoped_findings_and_cache(settings: Settings, checkout_commit: Commit) -> None:
    now = 0.0
    sdk = FakeFlagsmith(
        {
            "new_checkout": (True, None),
            "holiday_discount": (True, 15),
            "unused_demo": (False, "saved value"),
            "flow_view": (True, "overlay"),
            "other_demo": (True, None),
        }
    )
    flagsmith = FlagsmithClient(TEST_KEY, settings.flagsmith_api_url, sdk=sdk, clock=lambda: now)
    with TestClient(create_app(settings, flagsmith_client=flagsmith)) as client:
        response = client.get(URL, params={"sha": checkout_commit.sha[:7]})
        assert response.status_code == 200
        body = response.json()
        assert (body["repo"], body["sha"]) == ("shop-demo", checkout_commit.sha)
        assert body["flagsmith"] == {
            "connected": True,
            "environment": "Production",
            "fetched_at": body["flagsmith"]["fetched_at"],
            "error": None,
        }
        assert body["flagsmith"]["fetched_at"].endswith("Z")
        orphan, checkout, unused = body["flags"]
        assert (orphan["name"], orphan["status"]) == ("holiday_discount", "orphan")
        assert (orphan["in_flagsmith"], orphan["enabled"], orphan["value"]) == (False, None, None)
        assert orphan["guarded_edges"][0]["live"] is None
        assert orphan["dead_calls"] == []
        assert (checkout["name"], checkout["status"], checkout["enabled"]) == (
            "new_checkout",
            "live",
            True,
        )
        assert checkout["checks"] == [
            {
                "file": "shop/api.py",
                "line": 14,
                "function": "shop.api:checkout",
                "call": "is_feature_enabled",
            }
        ]
        legacy_call = {"source": "shop.api:checkout", "target": "shop.checkout:legacy_checkout"}
        new_call = {"source": "shop.api:checkout", "target": "shop.checkout:new_checkout"}
        assert checkout["guarded_edges"] == [
            {**legacy_call, "when": "off", "live": False},
            {**new_call, "when": "on", "live": True},
        ]
        assert checkout["dead_calls"] == [legacy_call]
        assert (unused["name"], unused["status"], unused["value"]) == (
            "unused_demo",
            "unused",
            "saved value",
        )
        assert unused["in_flagsmith"] is True
        assert unused["checks"] == []

        sdk.states["new_checkout"] = (False, None)
        now = 9.99
        assert client.get(URL, params={"sha": checkout_commit.sha}).json() == body
        assert sdk.calls == 1
        now = 10.0
        checkout = client.get(URL, params={"sha": checkout_commit.sha}).json()["flags"][1]
        assert (checkout["status"], checkout["enabled"]) == ("off", False)
        assert checkout["guarded_edges"] == [
            {**legacy_call, "when": "off", "live": True},
            {**new_call, "when": "on", "live": False},
        ]
        assert checkout["dead_calls"] == [new_call]
        assert sdk.calls == 2

        assert client.get(URL, params={"sha": "bad-sha"}).status_code == 404
        assert client.get("/api/repos/missing/flags").status_code == 404


@pytest.mark.parametrize(
    ("enabled", "value", "expected_status"),
    [
        (True, 15, "live"),
        ("false", None, "unknown"),
        (True, {"unexpected": "object"}, "unknown"),
        (True, float("nan"), "unknown"),
    ],
)
def test_remote_environment_lookup(
    settings: Settings,
    enabled: object,
    value: object,
    expected_status: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    raw_flags = [
        {
            "feature": {"id": 1, "name": "new_checkout"},
            "enabled": enabled,
            "feature_state_value": value,
        }
    ]

    def respond(request: PreparedRequest, **_kwargs: object) -> Response:
        upstream = Response()
        upstream.status_code = 200
        upstream.url = request.url
        upstream._content = json.dumps(raw_flags).encode()
        return upstream

    send = Mock(side_effect=respond)
    monkeypatch.setattr("requests.adapters.HTTPAdapter.send", send)
    settings = replace(
        settings,
        flagsmith_api_url="https://flagsmith.example.test/api/v1/",
        flagsmith_server_key=TEST_KEY,
    )

    with caplog.at_level(logging.DEBUG), TestClient(create_app(settings)) as client:
        response = client.get(URL)

    assert response.status_code == 200
    send.assert_called_once()
    request = send.call_args.args[0]
    assert request.method == "GET"
    assert request.url == "https://flagsmith.example.test/api/v1/flags/"
    assert request.headers["X-Environment-Key"] == TEST_KEY
    assert send.call_args.kwargs["timeout"] == 4

    payload = response.json()
    checkout = next(flag for flag in payload["flags"] if flag["name"] == "new_checkout")
    assert checkout["status"] == expected_status
    if expected_status == "live":
        assert payload["flagsmith"]["connected"] is True
        assert checkout["value"] == 15
    else:
        assert payload["flagsmith"]["connected"] is False
        assert payload["flagsmith"]["error"] == "Flagsmith returned invalid flag data"
        assert (checkout["enabled"], checkout["value"]) == (None, None)
    assert TEST_KEY not in response.text
    assert TEST_KEY not in caplog.text


def test_stale_in_every_listed_commit(demo_data: Path, tmp_path: Path, settings: Settings) -> None:
    now = 0.0
    index = load_index(demo_data / "shop-demo")
    trimmed = tmp_path / "trimmed"
    analyze_repo(index["repo_path"], trimmed / "shop-demo", branch="main", max_commits=5)
    assert settings.scopes_path is not None
    settings.scopes_path.write_text(
        json.dumps({"environment": "Production", "repos": {"shop-demo": ["holiday_discount"]}})
    )
    sdk = FakeFlagsmith({"holiday_discount": (False, 15)})
    flagsmith = FlagsmithClient(TEST_KEY, settings.flagsmith_api_url, sdk=sdk, clock=lambda: now)
    with TestClient(create_app(settings, flagsmith_client=flagsmith)) as client:
        discount = client.get(URL).json()["flags"][1]
        assert discount["name"] == "holiday_discount"
        assert discount["stale"] is False
        assert discount["stale_reason"] is None

    with TestClient(
        create_app(replace(settings, data_dir=trimmed), flagsmith_client=flagsmith)
    ) as client:
        four = client.get(URL, params={"sha": index["commits"][-2]["sha"]}).json()
        five = client.get(URL).json()
        assert five["sha"] == index["commits"][-1]["sha"]
        before, after = four["flags"][1], five["flags"][1]
        assert before["checks"][0]["line"] != after["checks"][0]["line"]
        assert before["stale"] is False
        assert after["stale"] is True
        assert after["stale_reason"] == "Off in Flagsmith and unchanged for 5 analyzed commits"
        assert after["dead_calls"] == [
            {"source": "shop.cart:Cart.total", "target": "shop.pricing:apply_holiday_discount"}
        ]

        sdk.states["holiday_discount"] = (True, None)
        now += 10
        discount = client.get(URL).json()["flags"][1]
        assert discount["stale_reason"] == "On in Flagsmith and unchanged for 5 analyzed commits"
        assert discount["dead_calls"] == []

        sdk.states["holiday_discount"] = (True, 15)
        now += 10
        discount = client.get(URL).json()["flags"][1]
        assert discount["value"] == 15
        assert discount["stale"] is False


@pytest.mark.parametrize("missing_key", [True, False])
def test_code_only_when_flagsmith_unavailable(
    settings: Settings, missing_key: bool, caplog: pytest.LogCaptureFixture
) -> None:
    sdk = FakeFlagsmith({})
    sdk.error = FlagsmithAPIError(f"Remote error contained {TEST_KEY}")
    flagsmith = FlagsmithClient(TEST_KEY, settings.flagsmith_api_url, sdk=sdk)
    with (
        caplog.at_level(logging.DEBUG),
        TestClient(
            create_app(settings, flagsmith_client=None if missing_key else flagsmith)
        ) as client,
    ):
        response = client.get(URL)
    assert response.status_code == 200
    body = response.json()
    assert body["flagsmith"] == {
        "connected": False,
        "environment": "Production",
        "fetched_at": None,
        "error": (
            "CODEFLOW_FLAGSMITH_SERVER_KEY is missing"
            if missing_key
            else "Could not fetch flags from Flagsmith"
        ),
    }
    assert [flag["name"] for flag in body["flags"]] == ["holiday_discount", "new_checkout"]
    for flag in body["flags"]:
        assert (flag["status"], flag["enabled"], flag["value"]) == ("unknown", None, None)
        assert flag["checks"]
        assert flag["dead_calls"] == []
        assert all(edge["live"] is None for edge in flag["guarded_edges"])
    assert TEST_KEY not in response.text
    assert TEST_KEY not in caplog.text


def test_root_dotenv_and_environment_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(config, "__file__", str(tmp_path / "server" / "app" / "config.py"))
    cwd = tmp_path / "working"
    cwd.mkdir()
    monkeypatch.chdir(cwd)
    for name in (
        "FLAGSMITH_API_URL",
        "CODEFLOW_FLAGSMITH_SERVER_KEY",
        "CODEFLOW_DATA_DIR",
        "CODEFLOW_FLAGSMITH_SCOPES_PATH",
    ):
        monkeypatch.delenv(name, raising=False)
    (tmp_path / ".env").write_text(
        f"# test settings\nexport CODEFLOW_FLAGSMITH_SERVER_KEY='{TEST_KEY}' # comment\n"
        'FLAGSMITH_API_URL="http://flagsmith.example.test/api/v1/"\n'
        "CODEFLOW_DATA_DIR=./analysis # comment\n"
    )
    settings = Settings.from_env()
    assert settings.flagsmith_server_key == TEST_KEY
    assert TEST_KEY not in repr(settings)
    assert settings.flagsmith_api_url == "http://flagsmith.example.test/api/v1/"
    assert settings.data_dir == tmp_path / "analysis"
    assert settings.scopes_path == settings.data_dir / "flagsmith_scopes.json"

    monkeypatch.setenv("FLAGSMITH_API_URL", "http://override.test/api/v1/")
    monkeypatch.setenv("CODEFLOW_FLAGSMITH_SERVER_KEY", "")
    monkeypatch.setenv("CODEFLOW_FLAGSMITH_SCOPES_PATH", "scopes.json")
    settings = Settings.from_env()
    assert settings.flagsmith_api_url == "http://override.test/api/v1/"
    assert settings.flagsmith_server_key is None
    assert settings.scopes_path == cwd / "scopes.json"
