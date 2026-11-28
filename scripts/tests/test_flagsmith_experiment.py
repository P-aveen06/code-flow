"""Exercise the experiment CLI with Flagsmith 2.295.2 response shapes."""

import copy
import sys
from pathlib import Path
from types import SimpleNamespace

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
    def __init__(self, flag="flow_view", *, feature_exists=True, environment="Development"):
        self.calls = []
        self.flag = flag
        self.feature_exists = feature_exists
        self.environment = environment
        self.metrics = []
        self.experiments = []
        self.results = None
        self.results_responses = []
        self.exposures = None
        self.fail_start = False
        self.throttled_refreshes = set()
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
        if flag == "flow_direction":
            self.feature.update(
                name=flag,
                multivariate_options=[
                    {"id": 19, "type": "unicode", "key": "vertical", "string_value": "vertical"}
                ],
            )
            self.flag_state.update(
                feature_state_value="horizontal",
                multivariate_feature_state_values=[
                    {"multivariate_feature_option": 19, "percentage_allocation": 50}
                ],
            )
        if flag == "github_signin":
            self.feature.update(
                name=flag,
                multivariate_options=[
                    {
                        "id": 20,
                        "type": "unicode",
                        "key": "github_signin",
                        "string_value": "github_signin",
                    }
                ],
            )
            self.flag_state.update(
                feature_state_value="url_import",
                multivariate_feature_state_values=[
                    {"multivariate_feature_option": 20, "percentage_allocation": 50}
                ],
            )

        if flag == "app_flow":
            self.feature.update(
                name=flag,
                multivariate_options=[
                    {"id": 21, "type": "unicode", "key": "b", "string_value": "b"},
                    {"id": 22, "type": "unicode", "key": "c", "string_value": "c"},
                ],
            )
            self.flag_state.update(
                feature_state_value="a",
                multivariate_feature_state_values=[
                    {"multivariate_feature_option": 21, "percentage_allocation": 33},
                    {"multivariate_feature_option": 22, "percentage_allocation": 33},
                ],
            )
        if flag == "ui_buttons":
            # A ui_* switch has an option for every flow; a stacking split gives "a" 0% and
            # serves it as the control value.
            self.feature.update(
                name=flag,
                multivariate_options=[
                    {"id": 23, "type": "unicode", "key": "a", "string_value": "a"},
                    {"id": 24, "type": "unicode", "key": "b", "string_value": "b"},
                    {"id": 25, "type": "unicode", "key": "c", "string_value": "c"},
                ],
            )
            self.flag_state.update(
                feature_state_value="a",
                multivariate_feature_state_values=[
                    {"multivariate_feature_option": 23, "percentage_allocation": 0},
                    {"multivariate_feature_option": 24, "percentage_allocation": 33},
                    {"multivariate_feature_option": 25, "percentage_allocation": 33},
                ],
            )

    @property
    def writes(self):
        return [call for call in self.calls if call[0] != "GET"]

    def list(self, path):
        self.calls.append(("GET", path, None))
        records = {
            "organisations/": [{"id": 7}],
            "projects/?organisation=7": [{"id": 8, "name": "code-flow"}],
            "projects/8/environments/": [{"id": 9, "name": self.environment, "api_key": ENV_KEY}],
            f"projects/8/features/?search={self.flag}": [self.feature]
            if self.feature_exists
            else [],
            f"{EXPERIMENTS}?q={self.flag}": self.experiments,
            f"{ENV_PATH}featurestates/?feature=16": [self.flag_state],
            METRICS: self.metrics,
        }
        return copy.deepcopy(records[path])

    def request(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        if method == "GET":
            if path == f"{DETAIL}results/":
                if self.results_responses:
                    return {"results": self.results_responses.pop(0)}
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
        if method == "POST" and path in (
            f"{DETAIL}exposures/refresh/",
            f"{DETAIL}results/refresh/",
        ):
            if path in self.throttled_refreshes:
                raise script.AdminError("POST", 429)
            return None  # HTTP 202 has an empty body.
        pytest.fail(f"Unexpected fake API request {method}")


@pytest.fixture(autouse=True)
def clear_simulation_environment(monkeypatch):
    monkeypatch.delenv("CODEFLOW_SIM_ENVIRONMENT", raising=False)


@pytest.fixture
def running_experiment(capsys):
    client = FakeClient()
    api = script.ExperimentAPI(client, dry_run=False)
    script.run(api, "create")
    client.calls.clear()
    capsys.readouterr()
    return client, api


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
                "hypothesis": script.EXPERIMENTS["flow_view"].hypothesis,
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
            ["refresh", "--wait", "10", "--dry-run"],
            "POST environments/<environment-key>/experiments/41/results/refresh/",
        ),
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
    if arguments[0] == "refresh":
        assert "POST environments/<environment-key>/experiments/41/exposures/refresh/" in stdout
        assert ("GET", f"{DETAIL}results/", None) not in client.calls
    assert stderr == ""
    assert all(key not in stdout for key in (ENV_KEY, admin_key, server_key))
    assert client.calls
    assert client.writes == []
    assert env_file.read_text() == env_contents


@pytest.mark.parametrize(
    ("configured", "override", "expected"),
    [
        (None, [], "Development"),
        ("QA Preview", [], "QA Preview"),
        ("Production", [], "Production"),
        ("Development", ["--environment", "Production"], "Production"),
    ],
)
def test_status_reads_the_selected_environment(
    configured, override, expected, tmp_path, monkeypatch, capsys
):
    client = FakeClient("flow_direction", environment=expected)
    env_file = tmp_path / ".env"
    env_file.write_text("FLAGSMITH_ADMIN_API_KEY=test-admin-secret\n")
    if configured is not None:
        with env_file.open("a") as file:
            file.write(f"CODEFLOW_SIM_ENVIRONMENT='{configured}'\n")
    monkeypatch.setattr(script, "AdminClient", lambda *_: client)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "flagsmith_experiment.py",
            "--env-file",
            str(env_file),
            "--experiment",
            "flow_direction",
            "status",
            *override,
        ],
    )

    assert script.main() == 0
    output = capsys.readouterr()
    assert f"Using Flagsmith environment code-flow/{expected}." in output.out
    assert (
        "No experiment named flow_direction: vertical vs horizontal for long flows exists."
        in output.out
    )
    assert "secret" not in output.out + output.err
    assert client.calls[-1] == ("GET", f"{EXPERIMENTS}?q=flow_direction", None)
    assert client.writes == []


@pytest.mark.parametrize("command", [["create"], ["refresh"], ["rollout", "--variant", "overlay"]])
def test_implicit_production_write_is_refused(command, tmp_path, monkeypatch, capsys):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "FLAGSMITH_ADMIN_API_KEY=test-admin-secret\nCODEFLOW_SIM_ENVIRONMENT=Development\n"
    )
    monkeypatch.setenv("CODEFLOW_SIM_ENVIRONMENT", "Production")
    monkeypatch.setattr(script, "AdminClient", lambda *_: pytest.fail("Unexpected Admin API call"))
    monkeypatch.setattr(
        sys, "argv", ["flagsmith_experiment.py", "--env-file", str(env_file), *command]
    )

    assert script.main() == 1
    output = capsys.readouterr()
    assert "Using Flagsmith environment code-flow/Production." in output.out
    assert "Production writes require an explicit --environment Production." in output.err
    assert "secret" not in output.out + output.err


@pytest.mark.parametrize("environment", ["Development", "Production"])
def test_create_starts_in_development_by_default_or_in_explicit_production(
    environment, tmp_path, monkeypatch, capsys
):
    client = FakeClient(environment=environment)
    env_file = tmp_path / ".env"
    env_file.write_text("FLAGSMITH_ADMIN_API_KEY=test-admin-secret\n")
    override = ["--environment", "Production"] if environment == "Production" else []
    monkeypatch.setattr(script, "AdminClient", lambda *_: client)
    monkeypatch.setattr(
        sys,
        "argv",
        ["flagsmith_experiment.py", "--env-file", str(env_file), *override, "create"],
    )

    assert script.main() == 0
    assert client.writes[-1][:2] == ("POST", f"{DETAIL}start/")
    output = capsys.readouterr()
    assert f"Using Flagsmith environment code-flow/{environment}." in output.out
    assert "secret" not in output.out + output.err


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
    assert any(
        "Current counts are side_by_side 17, overlay 15, overlay_summary 0." in line
        for line in lines
    )


@pytest.mark.parametrize(
    ("reviewers", "conversions", "threshold", "counts"),
    [
        (
            (24, 41, 35),
            (5, 5, 5),
            "50 reviewers",
            "side_by_side 24, overlay 41, overlay_summary 35",
        ),
        ((50, 50, 50), (5, 4, 1), "5 conversions", "side_by_side 5, overlay 4, overlay_summary 1"),
    ],
)
def test_status_explains_below_minimum_results(
    running_experiment, reviewers, conversions, threshold, counts, capsys
):
    client, api = running_experiment
    client.results = {
        "payload": {
            "metrics": [
                {
                    "metric_id": 31,
                    "variants": {
                        key: {"n": n, "sum": total}
                        for key, n, total in zip(
                            ("control", "overlay", "overlay_summary"),
                            reviewers,
                            conversions,
                            strict=True,
                        )
                    },
                    "inference": {"overlay": None, "overlay_summary": None},
                }
            ]
        }
    }

    script.run(api, "status")

    output = capsys.readouterr().out
    assert f"Flagsmith needs >= {threshold} per variant" in output
    assert f"Current counts are {counts}." in output
    assert client.writes == []


@pytest.mark.parametrize("throttled", [False, True])
def test_refresh_posts_to_both_endpoints(running_experiment, throttled, capsys):
    client, api = running_experiment
    if throttled:
        client.throttled_refreshes.add(f"{DETAIL}exposures/refresh/")

    script.run(api, "refresh")

    assert client.writes == [
        ("POST", f"{DETAIL}exposures/refresh/", {}),
        ("POST", f"{DETAIL}results/refresh/", {}),
    ]
    assert ("GET", f"{DETAIL}results/", None) not in client.calls
    output = capsys.readouterr().out
    if throttled:
        assert "Flagsmith allows one exposures refresh every 5 minutes" in output
    else:
        assert "Requested exposures refresh" in output
    assert "Requested results refresh" in output
    assert ENV_KEY not in output


def test_refresh_waits_for_a_fresh_results_payload(running_experiment, monkeypatch, capsys):
    client, api = running_experiment
    cached = {
        "as_of": "2026-11-26T08:05:00Z",
        "refresh_requested_at": "2026-11-26T08:05:00.5Z",
        "payload": {
            "metrics": [
                {"metric_id": 31, "variants": {"control": {"n": 100, "sum": 40}}, "inference": {}}
            ]
        },
    }
    client.results_responses = [None, cached, {**cached, "as_of": "2026-11-26T08:05:01Z"}]
    sleeps = []
    times = iter([0, 0, 2])
    monkeypatch.setattr(
        script, "time", SimpleNamespace(monotonic=times.__next__, sleep=sleeps.append)
    )

    script.run(api, "refresh", wait_seconds=10)

    assert client.calls[-3:] == [("GET", f"{DETAIL}results/", None)] * 3
    assert sleeps == [2, 2]
    output = capsys.readouterr().out
    assert "40 / 40.0%" in output
    assert "Timed out" not in output


def test_refresh_wait_reports_timeout(running_experiment, monkeypatch, capsys):
    client, api = running_experiment
    sleeps = []
    times = iter([0, 0, 1])
    monkeypatch.setattr(
        script, "time", SimpleNamespace(monotonic=times.__next__, sleep=sleeps.append)
    )

    script.run(api, "refresh", wait_seconds=1)

    assert client.calls[-3:] == [
        ("GET", f"{DETAIL}results/", None),
        ("GET", f"{DETAIL}results/", None),
        ("GET", f"{DETAIL}exposures/", None),
    ]
    assert sleeps == [1]
    assert "Timed out after 1s waiting for refreshed results" in capsys.readouterr().out


def test_flow_direction_create_status_refresh_and_rollout(capsys):
    client = FakeClient("flow_direction")
    api = script.ExperimentAPI(client, dry_run=False)
    options = {"experiment_flag": "flow_direction"}

    script.run(api, "create", **options)
    script.run(api, "create", **options)

    assert [path for _, path, _ in client.writes] == [
        METRICS,
        METRICS,
        EXPERIMENTS,
        f"{DETAIL}start/",
    ]
    metric_bodies = [body for _, path, body in client.writes if path == METRICS]
    assert metric_bodies == [
        {
            **body,
            "name": body["name"].replace("Diff ", "Layout "),
            "definition": {"version": 1, "event": "layout_understood"},
        }
        for body in METRIC_BODIES
    ]
    created = client.writes[2][2]
    assert created["name"] == "flow_direction: vertical vs horizontal for long flows"
    assert created["experiment_rollout"] == {
        "enabled": False,
        "rollout_percentage": 100,
        "feature_state_value": {"type": "string", "value": "horizontal"},
        "multivariate_feature_state_values": [
            {"multivariate_feature_option": 19, "percentage_allocation": 50}
        ],
    }
    assert "horizontal 50%, vertical 50%" in capsys.readouterr().out
    client.calls.clear()
    client.results = {
        "payload": {
            "metrics": [
                {
                    "metric_id": metric["id"],
                    "variants": {"control": {"n": 60, "sum": 30}, "vertical": {"n": 60, "sum": 36}},
                    "inference": {},
                }
                for metric in client.metrics
            ]
        }
    }
    script.run(api, "status", **options)
    output = capsys.readouterr().out
    assert "horizontal (control)" in output
    assert "36 / 60.0%" in output
    assert "Layout understood" in output
    assert "Layout time to understand (ms)" in output

    script.run(api, "refresh", **options)
    script.run(api, "rollout", "vertical", **options)
    assert client.writes == [
        ("POST", f"{DETAIL}exposures/refresh/", {}),
        ("POST", f"{DETAIL}results/refresh/", {}),
        ("POST", f"{DETAIL}complete/", {"rollout_decision": "variant", "rollout_variant": 19}),
    ]
    assert ("GET", f"{EXPERIMENTS}?q=flow_direction", None) in client.calls


def test_github_signin_create_tracks_completion_time_and_abandons(capsys):
    client = FakeClient("github_signin")
    api = script.ExperimentAPI(client, dry_run=False)

    script.run(api, "create", experiment_flag="github_signin")

    metric_bodies = [body for _, path, body in client.writes if path == METRICS]
    assert [
        (body["name"], body["definition"]["event"], body["aggregation"], body["direction"])
        for body in metric_bodies
    ] == [
        ("Import completed", "import_completed", "occurrence", "up"),
        ("Time to first flow (ms)", "first_flow_viewed", "mean", "down"),
        ("Import abandoned", "import_abandoned", "occurrence", "down"),
    ]
    created = next(body for _, path, body in client.writes if path == EXPERIMENTS)
    assert created["name"] == "github_signin: sign in with GitHub vs public URL import"
    # Sign-in is expected to cost time, so that metric is a guardrail, not a goal.
    assert [row["expected_direction"] for row in created["metrics"]] == [
        "increase",
        "increase",
        "decrease",
    ]
    assert created["experiment_rollout"]["feature_state_value"] == {
        "type": "string",
        "value": "url_import",
    }
    assert created["experiment_rollout"]["multivariate_feature_state_values"] == [
        {"multivariate_feature_option": 20, "percentage_allocation": 50}
    ]
    assert "url_import 50%, github_signin 50%" in capsys.readouterr().out
    assert client.writes[-1] == ("POST", f"{DETAIL}start/", {})


@pytest.mark.parametrize("feature_exists", [True, False])
def test_cli_previews_flow_direction_with_or_without_feature(
    feature_exists, tmp_path, monkeypatch, capsys
):
    client = FakeClient("flow_direction", feature_exists=feature_exists)
    env_file = tmp_path / ".env"
    env_file.write_text("FLAGSMITH_ADMIN_API_KEY=fake-key\n")
    monkeypatch.setattr(script, "AdminClient", lambda url, key: client)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "flagsmith_experiment.py",
            "--env-file",
            str(env_file),
            "--experiment",
            "flow_direction",
            "create",
            "--dry-run",
        ],
    )

    assert script.main() == 0
    assert client.writes == []
    output = capsys.readouterr().out
    assert ENV_KEY not in output
    assert '"event": "layout_understood"' in output
    assert '"percentage_allocation": 50' in output
    assert "POST environments/<environment-key>/experiments/<new experiment ID>/start/" in output
    if feature_exists:
        assert '"multivariate_feature_option": 19' in output
    else:
        assert "Prerequisite: setup must create flow_direction" in output
        assert "<new option ID for vertical>" in output
        assert all("featurestates/" not in path for _, path, _ in client.calls)


def test_cli_rejects_a_rollout_variant_from_another_experiment(monkeypatch, capsys):
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "flagsmith_experiment.py",
            "--experiment",
            "flow_direction",
            "rollout",
            "--variant",
            "overlay",
            "--dry-run",
        ],
    )
    with pytest.raises(SystemExit) as error:
        script.main()
    assert error.value.code == 2
    assert "must be one of horizontal, vertical" in capsys.readouterr().err


JOURNEY_METRIC_ROWS = [
    ("Journey completed", "journey_completed", "occurrence", "up"),
    ("Import completed", "import_completed", "occurrence", "up"),
    ("Diff understood", "diff_understood", "occurrence", "up"),
    ("Journey clicks", "journey_clicks", "mean", "down"),
    ("Dead clicks", "dead_clicks", "mean", "down"),
]


def test_app_flow_round_creates_a_named_experiment_with_journey_metrics(capsys):
    client = FakeClient("app_flow")
    api = script.ExperimentAPI(client, dry_run=False)

    script.run(api, "create", experiment_flag="app_flow", round_label="round 1")

    metric_bodies = [body for _, path, body in client.writes if path == METRICS]
    assert [
        (body["name"], body["definition"]["event"], body["aggregation"], body["direction"])
        for body in metric_bodies
    ] == JOURNEY_METRIC_ROWS
    created = next(body for _, path, body in client.writes if path == EXPERIMENTS)
    assert created["name"] == "app_flow: Guided vs Workbench vs Canvas [round 1]"
    # journey_completed comes first, so Flagsmith's dashboard shows it as the primary metric.
    assert created["metrics"][0]["metric"] == client.metrics[0]["id"]
    assert created["experiment_rollout"]["feature_state_value"] == {"type": "string", "value": "a"}
    assert created["experiment_rollout"]["multivariate_feature_state_values"] == [
        {"multivariate_feature_option": 21, "percentage_allocation": 33},
        {"multivariate_feature_option": 22, "percentage_allocation": 33},
    ]
    assert "a 34%, b 33%, c 33%" in capsys.readouterr().out
    assert client.writes[-1] == ("POST", f"{DETAIL}start/", {})


def test_next_round_needs_the_previous_one_completed(capsys):
    client = FakeClient("app_flow")
    api = script.ExperimentAPI(client, dry_run=False)
    script.run(api, "create", experiment_flag="app_flow", round_label="round 1")

    with pytest.raises(script.SetupError, match="already has a different active experiment"):
        script.run(api, "create", experiment_flag="app_flow", round_label="round 2")

    script.run(api, "rollout", "a", experiment_flag="app_flow", round_label="round 1")
    client.experiments[0]["name"] = "app_flow: Guided vs Workbench vs Canvas [round 1]"
    client.calls.clear()
    # Flagsmith answers the search with every app_flow experiment; round 2 is a new one.
    script.run(api, "create", experiment_flag="app_flow", round_label="round 2")
    created = [body for _, path, body in client.writes if path == EXPERIMENTS]
    assert [body["name"] for body in created] == [
        "app_flow: Guided vs Workbench vs Canvas [round 2]"
    ]


def test_ui_switch_stacking_split_serves_a_as_control_with_its_option_at_zero(capsys):
    client = FakeClient("ui_buttons")
    api = script.ExperimentAPI(client, dry_run=False)

    script.run(api, "create", experiment_flag="ui_buttons", round_label="round 14")

    created = next(body for _, path, body in client.writes if path == EXPERIMENTS)
    assert created["name"] == "ui_buttons: a vs b vs c [round 14]"
    assert created["experiment_rollout"]["feature_state_value"] == {"type": "string", "value": "a"}
    assert created["experiment_rollout"]["multivariate_feature_state_values"] == [
        {"multivariate_feature_option": 24, "percentage_allocation": 33},
        {"multivariate_feature_option": 25, "percentage_allocation": 33},
        {"multivariate_feature_option": 23, "percentage_allocation": 0},
    ]
    assert "a 34%, b 33%, c 33%" in capsys.readouterr().out
