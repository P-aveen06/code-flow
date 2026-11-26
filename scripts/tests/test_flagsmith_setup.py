"""Exercise the setup against in-memory Flagsmith Admin API responses."""

import copy
import io
import json
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import flagsmith_setup as setup_script


class FakeAdminClient:
    def __init__(self):
        self.projects = [{"id": 1, "name": "unrelated", "organisation": 8}]
        self.environments = []
        self.features = []
        self.states = {}
        self.keys = {}
        self.warehouses = {}
        self.calls = []
        self.next_id = 2
        self.versioned_environments = False

    def record(self, values):
        result = {"id": self.next_id, **values}
        self.next_id += 1
        return result

    def add_environment(self, project, name):
        environment = self.record(
            {
                "name": name,
                "project": project,
                "api_key": f"test-frontend-secret-{self.next_id}",
                "use_v2_feature_versioning": self.versioned_environments,
            }
        )
        self.environments.append(environment)
        for feature in self.features:
            if feature["project"] == project:
                self.add_state(environment["id"], feature)
        return environment

    def add_state(self, environment, feature):
        value = feature["initial_value"]
        # Flagsmith infers the type of a feature's initial_value from a string.
        if value in ("True", "False"):
            value = value == "True"
        elif value is not None and value.isdecimal():
            value = int(value)
        self.states[environment, feature["id"]] = self.record(
            {
                "environment": environment,
                "enabled": feature["default_enabled"],
                "feature_state_value": value,
                "multivariate_feature_state_values": [
                    self.add_weight(option) for option in feature["multivariate_options"]
                ],
            }
        )

    def add_weight(self, option):
        return self.record(
            {
                "multivariate_feature_option": option["id"],
                "percentage_allocation": option["default_percentage_allocation"],
            }
        )

    def environment_for_key(self, key):
        return next(env for env in self.environments if env["api_key"] == key)

    def list(self, path):
        return self.request("GET", path)

    def request(self, method, path, data=None):
        self.calls.append((method, path))
        return copy.deepcopy(self.handle_request(method, path, data))

    def handle_request(self, method, path, data):
        url = urlsplit(path)
        route = url.path.strip("/").split("/")
        params = parse_qs(url.query)
        match method, route:
            case "GET", ["organisations"]:
                return [{"id": 8}]
            case "GET", ["projects"]:
                assert params == {"organisation": ["8"]}
                return self.projects
            case "POST", ["projects"]:
                project = self.record(data)
                self.projects.append(project)
                return project
            case "GET", ["projects", project, "environments"]:
                return [env for env in self.environments if env["project"] == int(project)]
            case "POST", ["environments"]:
                return self.add_environment(data["project"], data["name"])
            case "GET", ["projects", project, "features"]:
                return [flag for flag in self.features if flag["project"] == int(project)]
            case "POST", ["projects", project, "features"]:
                feature = self.record(
                    {
                        "project": int(project),
                        "is_archived": False,
                        "multivariate_options": [],
                        **data,
                    }
                )
                self.features.append(feature)
                for environment in self.environments:
                    if environment["project"] == int(project):
                        self.add_state(environment["id"], feature)
                return feature
            case "PATCH", ["projects", project, "features", feature_id]:
                feature = self.feature(project, feature_id)
                feature["metadata"] = []
                feature.update(data)
                return feature
            case "POST", ["projects", project, "features", feature_id, "mv-options"]:
                feature = self.feature(project, feature_id)
                assert data["feature"] == feature["id"]
                option = self.record({"key": None, **data})
                feature["multivariate_options"].append(option)
                for (_, flag_id), state in self.states.items():
                    if flag_id == feature["id"]:
                        state["multivariate_feature_state_values"].append(self.add_weight(option))
                return option
            case "PUT", ["projects", project, "features", feature_id, "mv-options", option_id]:
                feature = self.feature(project, feature_id)
                option = next(
                    row for row in feature["multivariate_options"] if row["id"] == int(option_id)
                )
                option.update(data)
                return option
            case "GET", ["environments", api_key, "featurestates"]:
                environment = self.environment_for_key(api_key)
                return [self.states[environment["id"], int(params["feature"][0])]]
            case "PATCH", ["features", "featurestates", state_id]:
                state = next(row for row in self.states.values() if row["id"] == int(state_id))
                assert data["environment"] == state["environment"]
                return self.set_state(state, data)
            case "POST", ["environments", environment, "features", feature_id, "versions"]:
                assert data["publish_immediately"] is True
                (changes,) = data["feature_states_to_update"]
                return self.set_state(self.states[int(environment), int(feature_id)], changes)
            case "GET", ["environments", api_key, "api-keys"]:
                return self.keys.get(self.environment_for_key(api_key)["id"], [])
            case "POST", ["environments", api_key, "api-keys"]:
                assert data == {"name": "code-flow server", "active": True}
                environment = self.environment_for_key(api_key)
                key = self.record({"key": f"ser.fake-server-secret-{self.next_id}", **data})
                self.keys.setdefault(environment["id"], []).append(key)
                return key
            case "GET", ["environments", api_key, "warehouse-connections"]:
                assert params == {"exclude_event_stats": ["true"]}
                return self.warehouses.get(self.environment_for_key(api_key)["id"], [])
            case "POST", ["environments", api_key, "warehouse-connections"]:
                assert data == {
                    "warehouse_type": "postgres",
                    "config": {"source": "flagsmith_database"},
                }
                environment = self.environment_for_key(api_key)
                connection = self.record(data)
                self.warehouses.setdefault(environment["id"], []).append(connection)
                return connection
        pytest.fail("Unexpected fake Admin API endpoint")

    def feature(self, project, feature_id):
        return next(
            flag
            for flag in self.features
            if flag["project"] == int(project) and flag["id"] == int(feature_id)
        )

    def set_state(self, state, changes):
        value = changes["feature_state_value"]
        field = {"unicode": "string_value", "int": "integer_value", "bool": "boolean_value"}[
            value["type"]
        ]
        state["feature_state_value"] = value[field]
        state["enabled"] = changes["enabled"]
        if "multivariate_feature_state_values" in changes:
            state["multivariate_feature_state_values"] = [
                self.record(row) for row in changes["multivariate_feature_state_values"]
            ]
        return state

    def project_flag(self, project_name, flag_name):
        project = next(row for row in self.projects if row["name"] == project_name)
        environment = next(
            row
            for row in self.environments
            if row["project"] == project["id"] and row["name"] == "Development"
        )
        feature = next(
            row
            for row in self.features
            if row["project"] == project["id"] and row["name"] == flag_name
        )
        return feature, self.states[environment["id"], feature["id"]]


@pytest.fixture
def export_file(tmp_path):
    states = [
        {
            "feature": {"name": name, "type": "STANDARD"},
            "enabled": enabled,
            "feature_state_value": value,
        }
        for name, enabled, value in [
            ("bool_value", False, False),
            ("integer_value", True, 0),
            ("numeric_string", False, "123"),
            ("empty_string", True, ""),
            ("no_value", False, None),
            ("config_value", True, "test-nonpublic-config-value"),
        ]
    ]
    states.append(
        {
            "feature": {"name": "onboarding", "type": "MULTIVARIATE"},
            "enabled": False,
            "feature_state_value": "",
            "multivariate_feature_state_values": [
                {
                    "multivariate_feature_option": {"key": "single_page", "value": ""},
                    "percentage_allocation": 0,
                }
            ],
        }
    )
    path = tmp_path / "environment.json"
    path.write_text(json.dumps({"api_key": "test-export-secret", "feature_states": states}))
    return path


@pytest.fixture
def env_file(tmp_path):
    path = tmp_path / ".env"
    path.write_bytes(b'FLAGSMITH_ADMIN_API_KEY="test-admin-secret" # admin credential\r\n')
    return path


def test_setup_is_idempotent_and_hides_credentials(export_file, env_file, capsys):
    client = FakeAdminClient()
    defaults = setup_script.load_flagsmith_api_defaults(export_file)
    setup_script.setup(client, defaults, env_file, dry_run=False)
    settings = setup_script.read_env(env_file)
    assert len(client.projects) == 4
    assert len(client.environments) == 3
    assert len(client.features) == len(defaults) + 5
    assert len(client.keys) == 2
    assert len(client.warehouses) == 1
    assert settings["CODEFLOW_FLAGSMITH_ENV_KEY"] == settings["VITE_CODEFLOW_FLAGSMITH_ENV_KEY"]
    for project, key_name in (
        ("shop-demo", "SHOP_DEMO_FLAGSMITH_SERVER_KEY"),
        ("flagsmith-api", "FLAGSMITH_API_FLAGSMITH_SERVER_KEY"),
    ):
        project_id = next(row["id"] for row in client.projects if row["name"] == project)
        environment = next(row for row in client.environments if row["project"] == project_id)
        assert settings[key_name] == client.keys[environment["id"]][0]["key"]
    for project, name, enabled in [
        ("code-flow", "flagsmith_mode", True),
        ("code-flow", "ai_summary", False),
        ("shop-demo", "new_checkout", True),
        ("shop-demo", "holiday_discount", True),
    ]:
        _, state = client.project_flag(project, name)
        assert state["enabled"] is enabled
        assert state["feature_state_value"] is None
    for flag in defaults:
        feature, state = client.project_flag("flagsmith-api", flag.name)
        assert feature["type"] == flag.kind
        assert state["enabled"] is flag.enabled
        assert type(state["feature_state_value"]) is type(flag.value)
        assert state["feature_state_value"] == flag.value

    first = capsys.readouterr()
    assert "Projects created (3)" in first.out
    assert "Environments created (3)" in first.out
    assert "wrote CODEFLOW_FLAGSMITH_ENV_KEY" in first.out
    assert "Enabled the Flagsmith database warehouse." in first.out
    client.calls.clear()
    before = env_file.stat().st_mtime_ns
    setup_script.setup(client, defaults, env_file, dry_run=False)
    second = capsys.readouterr()
    assert all(method == "GET" for method, _ in client.calls)
    assert "Flags unchanged (12)" in second.out
    assert "Flagsmith database warehouse unchanged." in second.out
    assert "wrote" not in second.out
    assert env_file.stat().st_mtime_ns == before
    for secret in [*settings.values(), "test-export-secret", "test-nonpublic-config-value"]:
        assert secret not in first.out + first.err + second.out + second.err


def test_flow_view_corrects_drift_in_development(env_file, capsys):
    client = FakeAdminClient()
    client.versioned_environments = True
    project = client.request("POST", "projects/", {"name": "code-flow", "organisation": 8})
    project_id = project["id"]
    development = client.add_environment(project_id, "Development")
    production = client.add_environment(project_id, "Production")
    flag = client.request(
        "POST",
        f"projects/{project_id}/features/",
        {
            "name": "flow_view",
            "type": "STANDARD",
            "default_enabled": False,
            "initial_value": "old",
            "metadata": [{"id": 31, "model_field": 12, "field_value": "existing"}],
        },
    )
    options_path = f"projects/{project_id}/features/{flag['id']}/mv-options/"
    for key, value, weight in [
        ("overlay", "old_overlay", 20),
        ("unused", "unused", 70),
    ]:
        client.request(
            "POST",
            options_path,
            {
                "feature": flag["id"],
                "key": key,
                "type": "unicode",
                "string_value": value,
                "default_percentage_allocation": weight,
            },
        )

    setup_script.setup(client, [], env_file, dry_run=False)
    feature, state = client.project_flag("code-flow", "flow_view")
    assert feature["type"] == "MULTIVARIATE"
    assert feature["metadata"] == flag["metadata"]
    assert state["enabled"] is True
    assert state["feature_state_value"] == "side_by_side"
    values = {option["id"]: option["string_value"] for option in feature["multivariate_options"]}
    weights = {
        values[row["multivariate_feature_option"]]: row["percentage_allocation"]
        for row in state["multivariate_feature_state_values"]
    }
    assert weights == {"overlay": 33, "overlay_summary": 33, "unused": 0}
    assert 100 - sum(weights.values()) == 34
    production_state = client.states[production["id"], feature["id"]]
    assert [
        row["percentage_allocation"]
        for row in production_state["multivariate_feature_state_values"]
    ] == [
        20,
        70,
        0,
    ]
    assert (
        "POST",
        f"environments/{development['id']}/features/{flag['id']}/versions/",
    ) in client.calls
    assert "Flags updated (1) — code-flow/flow_view" in capsys.readouterr().out
    client.calls.clear()
    setup_script.setup(client, [], env_file, dry_run=False)
    assert all(method == "GET" for method, _ in client.calls)


def test_dry_run_with_a_missing_project_and_drifted_flag(env_file, capsys):
    client = FakeAdminClient()
    setup_script.setup(client, [], env_file, dry_run=False)
    client.projects = [project for project in client.projects if project["name"] != "flagsmith-api"]
    _, state = client.project_flag("code-flow", "flagsmith_mode")
    state["enabled"] = False
    original = env_file.read_bytes()
    client.calls.clear()
    capsys.readouterr()
    setup_script.setup(client, [], env_file, dry_run=True)

    assert client.calls and all(method == "GET" for method, _ in client.calls)
    assert state["enabled"] is False
    assert env_file.read_bytes() == original
    output = capsys.readouterr().out
    assert "Projects created (1) — flagsmith-api" in output
    assert "Flags updated (1) — code-flow/flagsmith_mode" in output
    assert "would write FLAGSMITH_API_FLAGSMITH_SERVER_KEY" in output
    assert "secret-" not in output


def test_env_update_preserves_other_bytes_and_inline_comments(tmp_path):
    path = tmp_path / ".env"
    path.write_bytes(
        b"# header \xff\r\nFLAGSMITH_ADMIN_API_KEY=test-admin-secret\r\n"
        b"export CODEFLOW_FLAGSMITH_ENV_KEY = 'old'  # retain comment\r\n"
        b"OTHER=a=b#c\nSHOP_DEMO_FLAGSMITH_SERVER_KEY= # existing comment\r\n"
        b"VITE_CODEFLOW_FLAGSMITH_ENV_KEY=already-right\r\n# final comment"
    )
    path.chmod(0o640)
    values = {
        "CODEFLOW_FLAGSMITH_ENV_KEY": "new",
        "SHOP_DEMO_FLAGSMITH_SERVER_KEY": "changed",
        "VITE_CODEFLOW_FLAGSMITH_ENV_KEY": "already-right",
        "FLAGSMITH_API_FLAGSMITH_SERVER_KEY": "appended",
    }
    assert setup_script.update_env_file(path, values) == [
        "CODEFLOW_FLAGSMITH_ENV_KEY",
        "SHOP_DEMO_FLAGSMITH_SERVER_KEY",
        "FLAGSMITH_API_FLAGSMITH_SERVER_KEY",
    ]
    assert path.read_bytes() == (
        b"# header \xff\r\nFLAGSMITH_ADMIN_API_KEY=test-admin-secret\r\n"
        b"export CODEFLOW_FLAGSMITH_ENV_KEY = 'new'  # retain comment\r\n"
        b"OTHER=a=b#c\nSHOP_DEMO_FLAGSMITH_SERVER_KEY=changed # existing comment\r\n"
        b"VITE_CODEFLOW_FLAGSMITH_ENV_KEY=already-right\r\n# final comment\r\n"
        b"FLAGSMITH_API_FLAGSMITH_SERVER_KEY=appended\r\n"
    )
    assert path.stat().st_mode & 0o777 == 0o640
    assert setup_script.update_env_file(path, values) == []


def test_load_defaults_from_git_head(export_file, tmp_path, monkeypatch):
    def local_git_only(command, **kwargs):
        assert command == [
            "git",
            "-C",
            str(tmp_path),
            "show",
            f"HEAD:{setup_script.ENVIRONMENT_EXPORT}",
        ]
        assert kwargs["env"]["GIT_NO_LAZY_FETCH"] == "1"
        assert kwargs["stderr"] == subprocess.DEVNULL
        return export_file.read_bytes()

    monkeypatch.setattr(setup_script.subprocess, "check_output", local_git_only)
    assert setup_script.load_flagsmith_api_defaults(
        tmp_path
    ) == setup_script.load_flagsmith_api_defaults(export_file)


def test_warehouse_manual_step_for_unavailable_endpoint(capsys):
    class NoWarehouseAPI:
        def list(self, path):
            raise setup_script.AdminError("GET", 404)

    setup_script.ensure_warehouse(
        NoWarehouseAPI(), {"api_key": "test-frontend-secret"}, dry_run=False
    )
    output = capsys.readouterr().out
    assert "Environment Settings > Warehouse > Flagsmith database > Enable" in output
    assert "test-frontend-secret" not in output


def test_main_hides_http_error_url_and_body(export_file, env_file, monkeypatch, capsys):
    class ErrorOpener:
        def open(self, request, timeout):
            assert request.get_method() == "GET"
            assert request.get_header("Authorization") == "Api-Key test-admin-secret"
            assert request.full_url == "http://localhost:8000/api/v1/organisations/"
            raise HTTPError(
                request.full_url + "test-secret-url",
                403,
                "test-secret-message",
                {},
                io.BytesIO(b"test-secret-body"),
            )

    monkeypatch.setattr(setup_script, "build_opener", lambda _: ErrorOpener())
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "flagsmith_setup.py",
            "--dry-run",
            "--env-file",
            str(env_file),
            "--environment-json",
            str(export_file),
        ],
    )
    assert setup_script.main() == 1
    result = capsys.readouterr()
    assert result.err == "Flagsmith setup failed. Flagsmith Admin API GET returned HTTP 403.\n"
    assert "secret" not in result.out + result.err


def test_admin_client_follows_paginated_lists(monkeypatch):
    class ListOpener:
        def open(self, request, timeout):
            assert request.get_method() == "GET"
            query = urlsplit(request.full_url).query
            if query == "page=2":
                page = {"next": None, "results": [{"id": 2}]}
            else:
                assert query == ""
                page = {"next": "?page=2", "results": [{"id": 1}]}
            return io.BytesIO(json.dumps(page).encode())

    monkeypatch.setattr(setup_script, "build_opener", lambda _: ListOpener())
    assert setup_script.AdminClient("http://example.test/api/v1/", "test-key").list(
        "projects/"
    ) == [{"id": 1}, {"id": 2}]
