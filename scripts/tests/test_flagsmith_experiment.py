"""Exercise the experiment CLI with Flagsmith 2.295.2 response shapes."""

import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import flagsmith_experiment as script

ENV_KEY = "test-environment-secret"
ENV_PATH = f"environments/{ENV_KEY}/"
EXPERIMENTS = f"{ENV_PATH}experiments/"
METRICS = f"{ENV_PATH}experiment-metrics/"
DETAIL = f"{EXPERIMENTS}41/"
NAME = "flow_view: overlay vs side by side"
WEIGHTS = [
    {"multivariate_feature_option": 17, "percentage_allocation": 33},
    {"multivariate_feature_option": 18, "percentage_allocation": 33},
]
METRIC_BODIES = [
    {
        "name": "Diff understood",
        "aggregation": "occurrence",
        "direction": "up",
        "definition": {"version": 1, "event": "diff_understood"},
    },
    {
        "name": "Diff time to understand (ms)",
        "aggregation": "mean",
        "direction": "down",
        "definition": {"version": 1, "event": "diff_understood"},
    },
]


class FakeClient:
    def __init__(self):
        self.calls = []
        self.metrics = []
        self.experiments = []
        self.results = None
        self.exposures = None
        self.fail_start = False
        self.feature = {
            "id": 16,
            "name": "flow_view",
            "type": "MULTIVARIATE",
            "multivariate_options": [
                {"id": 17, "type": "unicode", "key": "overlay", "string_value": "overlay"},
                {
                    "id": 18,
                    "type": "unicode",
                    "key": "overlay_summary",
                    "string_value": "overlay_summary",
                },
            ],
        }
        self.flag_state = {
            "enabled": True,
            "feature_state_value": "side_by_side",
            "multivariate_feature_state_values": copy.deepcopy(WEIGHTS),
        }

    @property
    def writes(self):
        return [call for call in self.calls if call[0] != "GET"]

    def list(self, path):
        self.calls.append(("GET", path, None))
        records = {
            "organisations/": [{"id": 7}],
            "projects/?organisation=7": [{"id": 8, "name": "code-flow"}],
            "projects/8/environments/": [{"id": 9, "name": "Production", "api_key": ENV_KEY}],
            "projects/8/features/?search=flow_view": [self.feature],
            f"{EXPERIMENTS}?q=flow_view": self.experiments,
            f"{ENV_PATH}featurestates/?feature=16": [self.flag_state],
            METRICS: self.metrics,
        }
        return copy.deepcopy(records[path])

    def request(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        if method == "GET":
            if path == f"{DETAIL}results/":
                return {"results": self.results}
            if path == f"{DETAIL}exposures/":
                return {"exposures": self.exposures}
            if path == DETAIL:
                return copy.deepcopy(self.experiments[0])
        if method == "POST" and path == METRICS:
            metric = {"id": 31 + len(self.metrics), **body}
            self.metrics.append(metric)
            return metric
        if method == "POST" and path == EXPERIMENTS:
            self.experiments.append(
                {
                    **body,
                    "id": 41,
                    "feature": self.feature,
                    "status": "created",
                    "experiment_rollout": {
                        **body["experiment_rollout"],
                        "audience": {"match": "any", "segments": []},
                    },
                    "metrics": [
                        {**attachment, "metric_name": metric["name"]}
                        for attachment, metric in zip(body["metrics"], self.metrics, strict=True)
                    ],
                }
            )
            return {"id": 41, "feature": 16, "status": "created"}
        if method == "POST" and path == f"{DETAIL}start/":
            if self.fail_start:
                raise script.AdminError("POST", 500)
            self.experiments[0]["status"] = "running"
            return copy.deepcopy(self.experiments[0])
        if method == "POST" and path == f"{DETAIL}complete/":
            self.experiments[0].update(status="completed", **body)
            return copy.deepcopy(self.experiments[0])
        pytest.fail(f"Unexpected fake API request {method}")


def test_create_uses_serializer_fields_and_is_idempotent(capsys):
    client = FakeClient()
    api = script.ExperimentAPI(client, dry_run=False)

    script.run(api, "create")
    script.run(api, "create")

    assert client.writes == [
        ("POST", METRICS, METRIC_BODIES[0]),
        ("POST", METRICS, METRIC_BODIES[1]),
        (
            "POST",
            EXPERIMENTS,
            {
                "name": NAME,
                "feature": 16,
                "hypothesis": script.HYPOTHESIS,
                "metrics": [
                    {"metric": 31, "expected_direction": "increase"},
                    {"metric": 32, "expected_direction": "decrease"},
                ],
                "experiment_rollout": {
                    "enabled": False,
                    "rollout_percentage": 100,
                    "feature_state_value": {"type": "string", "value": "side_by_side"},
                    "multivariate_feature_state_values": WEIGHTS,
                },
            },
        ),
        ("POST", f"{DETAIL}start/", {}),
    ]
    output = capsys.readouterr().out
    assert "already running" in output
    assert ENV_KEY not in output


def test_create_retries_start_of_existing_draft():
    client = FakeClient()
    client.metrics.append({"id": 31, **METRIC_BODIES[0]})
    client.fail_start = True
    api = script.ExperimentAPI(client, dry_run=False)
    with pytest.raises(script.AdminError):
        script.run(api, "create")

    client.calls.clear()
    client.fail_start = False
    script.run(api, "create")

    assert client.writes == [("POST", f"{DETAIL}start/", {})]
    assert client.experiments[0]["status"] == "running"


def test_create_does_not_change_a_different_live_split():
    client = FakeClient()
    client.flag_state["multivariate_feature_state_values"][0]["percentage_allocation"] = 25

    with pytest.raises(script.SetupError, match="34/33/33"):
        script.run(script.ExperimentAPI(client, dry_run=False), "create")

    assert client.writes == []


@pytest.mark.parametrize(
    ("variant", "body"),
    [
        ("side_by_side", {"rollout_decision": "control"}),
        ("overlay_summary", {"rollout_decision": "variant", "rollout_variant": 18}),
    ],
)
def test_rollout_completes_once_and_reports_winner(variant, body, capsys):
    client = FakeClient()
    api = script.ExperimentAPI(client, dry_run=False)
    script.run(api, "create")
    client.calls.clear()

    script.run(api, "rollout", variant)
    script.run(api, "rollout", variant)

    assert client.writes == [("POST", f"{DETAIL}complete/", body)]
    assert f"Already completed with {variant} at 100%" in capsys.readouterr().out
    other_variant = "overlay" if variant == "side_by_side" else "side_by_side"
    with pytest.raises(script.SetupError, match="different rollout decision"):
        script.run(api, "rollout", other_variant)
    assert len(client.writes) == 1


@pytest.mark.parametrize(
    ("arguments", "expected_request"),
    [
        (["create", "--dry-run"], "POST environments/<environment-key>/experiment-metrics/"),
        (["--dry-run", "status"], "GET environments/<environment-key>/experiments/41/results/"),
        (
            ["rollout", "--variant", "overlay", "--dry-run"],
            "POST environments/<environment-key>/experiments/41/complete/",
        ),
    ],
)
def test_cli_dry_runs_send_only_gets_and_hide_keys(
    arguments, expected_request, tmp_path, monkeypatch, capsys
):
    client = FakeClient()
    if arguments[0] != "create":
        script.run(script.ExperimentAPI(client, dry_run=False), "create")
    client.calls.clear()
    capsys.readouterr()
    admin_key = "test-admin-secret"
    server_key = "test-server-secret"
    env_file = tmp_path / ".env"
    env_contents = (
        f"FLAGSMITH_ADMIN_API_KEY='{admin_key}'\nCODEFLOW_FLAGSMITH_SERVER_KEY={server_key}\n"
    )
    env_file.write_text(env_contents)

    def fake_admin_client(url, key):
        assert url == script.DEFAULT_API_URL
        assert key == admin_key
        return client

    monkeypatch.setattr(script, "AdminClient", fake_admin_client)
    monkeypatch.setattr(
        sys, "argv", ["flagsmith_experiment.py", "--env-file", str(env_file), *arguments]
    )
    assert script.main() == 0

    stdout, stderr = capsys.readouterr()
    assert expected_request in stdout
    assert stderr == ""
    assert all(key not in stdout for key in (ENV_KEY, admin_key, server_key))
    assert client.calls
    assert client.writes == []
    assert env_file.read_text() == env_contents


def test_status_formats_cached_results_for_the_two_metrics(capsys):
    client = FakeClient()
    api = script.ExperimentAPI(client, dry_run=False)
    script.run(api, "create")
    client.calls.clear()
    capsys.readouterr()
    client.results = {
        "as_of": "2026-11-26T08:05:00Z",
        "payload": {
            "metrics": [
                {
                    "metric_id": 31,
                    "variants": {
                        "control": {"n": 100, "sum": 40, "sum_squares": 40},
                        "overlay": {"n": 100, "sum": 60, "sum_squares": 60},
                        "overlay_summary": {"n": 3, "sum": 1, "sum_squares": 1},
                    },
                    "inference": {
                        "overlay": {
                            "lift": 0.5,
                            "ci_low": 0.1,
                            "ci_high": 0.9,
                            "chance_to_win": 0.99,
                        },
                        "overlay_summary": None,
                    },
                },
                {
                    "metric_id": 32,
                    "variants": {"control": {"n": 100, "sum": 9550, "sum_squares": 1000000}},
                    "inference": {},
                },
            ],
        },
    }

    script.run(api, "status")

    output = capsys.readouterr().out
    for expected in (
        "is running",
        "side_by_side (control)",
        "40 / 40.0%",
        "60 / 60.0%",
        "+50.0%",
        "[+10.0%, +90.0%]",
        "99.0%",
        "1 / 33.3%",
        "Mean ms / exposure",
        "95.5",
    ):
        assert expected in output
    assert client.writes == []


def test_status_sums_cached_exposures_when_results_are_missing(capsys):
    client = FakeClient()
    api = script.ExperimentAPI(client, dry_run=False)
    script.run(api, "create")
    capsys.readouterr()
    client.exposures = {
        "payload": {
            "timeseries": {
                "points": [
                    {"new_identities": {"control": 15, "overlay": 10}},
                    {"new_identities": {"control": 2, "overlay": 5}},
                ]
            }
        },
    }

    script.run(api, "status")

    lines = capsys.readouterr().out.splitlines()
    assert any("No cached results" in line for line in lines)
    assert next(line for line in lines if line.startswith("side_by_side")).endswith("17")
    assert next(line for line in lines if line.startswith("overlay ")).endswith("15")
