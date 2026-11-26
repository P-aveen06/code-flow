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
        self.tags = []
        self.features = []
        self.states = {}
        self.keys = {}
        self.warehouses = {}
        self.calls = []
        self.next_id = 2

    def record(self, values):
        result = {"id": self.next_id, **values}
        self.next_id += 1
        return result

    def add_project(self, name="code-flow"):
        project = self.record({"name": name, "organisation": 8})
        self.projects.append(project)
        return project["id"]

    def add_environment(self, project, name, versioned=False):
        environment = self.record(
            {
                "name": name,
                "project": project,
                "api_key": f"test-frontend-secret-{self.next_id}",
                "use_v2_feature_versioning": versioned,
            }
        )
        self.environments.append(environment)
        for feature in self.features:
            if feature["project"] == project:
                self.add_state(environment["id"], feature)
        return environment

    def add_state(self, environment, feature):
        self.states[environment, feature["id"]] = self.record(
            {
                "environment": environment,
                "enabled": feature["default_enabled"],
                "feature_state_value": feature["initial_value"],
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
            case "GET", ["projects", project, "environments"]:
                return [env for env in self.environments if env["project"] == int(project)]
            case "GET", ["projects", project, "tags"]:
                return [tag for tag in self.tags if tag["project"] == int(project)]
            case "POST", ["projects", project, "tags"]:
                assert set(data) == {"label"}
                tag = self.record({"project": int(project), **data})
                self.tags.append(tag)
                return tag
            case "GET", ["projects", project, "features"]:
                return [flag for flag in self.features if flag["project"] == int(project)]
            case "POST", ["projects", project, "features"]:
                feature = self.record(
                    {
                        "project": int(project),
                        "type": "STANDARD",
                        "is_archived": False,
                        "default_enabled": False,
                        "initial_value": None,
                        "tags": [],
                        "metadata": [],
                        "multivariate_options": [],
                        **data,
                    }
                )
                self.features.append(feature)
                for environment in self.environments:
                    if environment["project"] == int(project):
                        self.add_state(environment["id"], feature)
                return feature
            case "GET", ["projects", project, "features", feature_id]:
                return self.feature(project, feature_id)
            case "PATCH", ["projects", project, "features", feature_id]:
                assert set(data) == {"tags", "metadata"}
                feature = self.feature(project, feature_id)
                assert feature["metadata"] == data["metadata"]
                assert set(feature["tags"]) < set(data["tags"])
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

    def project_flag(self, environment, flag_name):
        feature = next(
            row
            for row in self.features
            if row["project"] == environment["project"] and row["name"] == flag_name
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
            ("feature_lifecycle", False, None),
            ("experimental_flags", False, None),
            ("experimentation_warehouse_connection", False, None),
            ("api_usage_overage_charges", True, None),
            ("compress_dynamo_documents", True, None),
            ("segment_membership_inspection", False, None),
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


@pytest.fixture
def scope_file(tmp_path):
    return tmp_path / "data" / "flagsmith_scopes.json"


@pytest.mark.parametrize("dry_run", [False, True])
def test_missing_project_explains_how_to_create_it(env_file, scope_file, dry_run):
    client = FakeAdminClient()
    before = env_file.read_bytes()
    with pytest.raises(setup_script.SetupError) as error:
        setup_script.setup(client, [], env_file, dry_run, scope_file=scope_file)
    assert str(error.value) == "Create a project named code-flow in the Flagsmith dashboard first."
    assert client.calls == [("GET", "organisations/"), ("GET", "projects/?organisation=8")]
    assert env_file.read_bytes() == before
    assert not scope_file.exists()


@pytest.mark.parametrize(
    ("names", "override", "expected"),
    [
        (["Development", "Production"], None, "Production"),
        (["Development", "Production"], "Development", "Development"),
        (['QA "Preview"', "Development"], 'QA "Preview"', 'QA "Preview"'),
    ],
)
def test_environment_selection_uses_one_environment(
    names, override, expected, env_file, scope_file
):
    client = FakeAdminClient()
    project = client.add_project()
    environments = [client.add_environment(project, name) for name in names]
    selected = next(env for env in environments if env["name"] == expected)
    setup_script.setup(
        client,
        [],
        env_file,
        dry_run=False,
        scope_file=scope_file,
        **({"environment_name": override} if override else {}),
    )

    settings = setup_script.read_env(env_file)
    if expected == "Production":
        assert settings["CODEFLOW_FLAGSMITH_ENV_KEY"] == selected["api_key"]
        assert settings["VITE_CODEFLOW_FLAGSMITH_ENV_KEY"] == selected["api_key"]
        assert settings["CODEFLOW_FLAGSMITH_SERVER_KEY"] == client.keys[selected["id"]][0]["key"]
        assert set(client.keys) == {selected["id"]}
        assert json.loads(scope_file.read_bytes())["environment"] == expected
    else:
        assert settings == {
            "FLAGSMITH_ADMIN_API_KEY": "test-admin-secret",
            "CODEFLOW_SIM_FLAGSMITH_ENV_KEY": selected["api_key"],
            "CODEFLOW_SIM_ENVIRONMENT": expected,
        }
        assert not client.keys
        assert not scope_file.exists()
    assert set(client.warehouses) == {selected["id"]}
    for env in environments:
        _, state = client.project_flag(env, "flow_view")
        assert state["enabled"] is (env == selected)
        assert state["feature_state_value"] == ("side_by_side" if env == selected else None)
        allocations = [
            row["percentage_allocation"] for row in state["multivariate_feature_state_values"]
        ]
        assert allocations == ([33, 33] if env == selected else [0, 0])


@pytest.mark.parametrize(
    ("environments", "override", "message"),
    [
        (["Production"], "Missing", "Environment 'Missing' was not found"),
        (["Staging", "Development"], None, "Environment 'Production' was not found"),
        ([], None, "Create it in Flagsmith"),
    ],
)
def test_environment_selection_errors_before_writes(
    environments, override, message, env_file, scope_file
):
    client = FakeAdminClient()
    project = client.add_project()
    for name in environments:
        client.add_environment(project, name)
    with pytest.raises(setup_script.SetupError, match=message):
        setup_script.setup(
            client,
            [],
            env_file,
            dry_run=False,
            scope_file=scope_file,
            **({"environment_name": override} if override else {}),
        )
    assert all(method == "GET" for method, _ in client.calls)
    assert not scope_file.exists()


@pytest.mark.parametrize("versioned", [False, True])
def test_development_cli_restores_experiment_states_and_preserves_production(
    versioned, export_file, env_file, scope_file, monkeypatch, capsys
):
    client = FakeAdminClient()
    project = client.add_project()
    production = client.add_environment(project, "Production")
    development = client.add_environment(project, "Development", versioned=versioned)
    defaults = setup_script.load_flagsmith_api_defaults(export_file)
    setup_script.setup(client, defaults, env_file, dry_run=False, scope_file=scope_file)

    for flag_name, winner in (
        ("flow_view", "overlay_summary"),
        ("flow_direction", "vertical"),
    ):
        _, state = client.project_flag(production, flag_name)
        state["feature_state_value"] = winner
        for weight in state["multivariate_feature_state_values"]:
            weight["percentage_allocation"] = 0

    _, drifted = client.project_flag(development, "flow_view")
    drifted.update(enabled=True, feature_state_value="overlay")
    for row, allocation in zip(drifted["multivariate_feature_state_values"], (60, 10), strict=True):
        row["percentage_allocation"] = allocation
    # flow_direction still has the empty Development state created with the project flag.
    before_production = copy.deepcopy(
        {key: state for key, state in client.states.items() if key[0] == production["id"]}
    )
    before_env = env_file.read_bytes()
    before_scope = scope_file.read_bytes()
    client.calls.clear()
    capsys.readouterr()

    monkeypatch.setattr(setup_script, "AdminClient", lambda *_: client)
    args = [
        "flagsmith_setup.py",
        "--environment",
        "Development",
        "--env-file",
        str(env_file),
        "--scope-file",
        str(scope_file),
        "--environment-json",
        str(export_file),
    ]
    monkeypatch.setattr(sys, "argv", [*args, "--dry-run"])
    assert setup_script.main() == 0
    preview = capsys.readouterr().out
    assert "Would set flow_view" in preview and "Would set flow_direction" in preview
    assert all(method == "GET" for method, _ in client.calls)
    assert env_file.read_bytes() == before_env
    assert scope_file.read_bytes() == before_scope

    monkeypatch.setattr(sys, "argv", args)
    client.calls.clear()
    assert setup_script.main() == 0
    assert (
        env_file.read_bytes()
        == before_env
        + (
            f"CODEFLOW_SIM_FLAGSMITH_ENV_KEY={development['api_key']}\r\n"
            "CODEFLOW_SIM_ENVIRONMENT=Development\r\n"
        ).encode()
    )
    assert scope_file.read_bytes() == before_scope
    assert {key: client.states[key] for key in before_production} == before_production
    assert all(production["api_key"] not in path for _, path in client.calls)
    assert len(client.features) == len(defaults) + 6
    assert set(client.keys) == {production["id"]}
    assert set(client.warehouses) == {production["id"], development["id"]}
    for flag_name, control, expected in (
        ("flow_view", "side_by_side", {"overlay": 33, "overlay_summary": 33}),
        ("flow_direction", "horizontal", {"vertical": 50}),
    ):
        flag, state = client.project_flag(development, flag_name)
        assert state["enabled"] is True
        assert state["feature_state_value"] == control
        option_keys = {option["id"]: option["key"] for option in flag["multivariate_options"]}
        assert {
            option_keys[row["multivariate_feature_option"]]: row["percentage_allocation"]
            for row in state["multivariate_feature_state_values"]
        } == expected

    output = capsys.readouterr()
    assert "Using Flagsmith environment code-flow/Development." in output.out
    assert "secret" not in preview + output.out + output.err
    client.calls.clear()
    assert setup_script.main() == 0
    assert all(method == "GET" for method, _ in client.calls)


def test_setup_is_idempotent_and_hides_credentials(export_file, env_file, scope_file, capsys):
    client = FakeAdminClient()
    project = client.add_project()
    environment = client.add_environment(project, "Production", versioned=True)
    defaults = setup_script.load_flagsmith_api_defaults(export_file)

    setup_script.setup(client, defaults, env_file, dry_run=False, scope_file=scope_file)

    assert len(client.projects) == 2
    assert len(client.environments) == 1
    assert {tag["label"] for tag in client.tags} == {
        "code-flow",
        "repo:flagsmith-api",
        "repo:shop-demo",
    }
    assert all(tag["project"] == project for tag in client.tags)
    assert (
        sum(
            (method, path) == ("POST", f"projects/{project}/tags/") for method, path in client.calls
        )
        == 3
    )
    assert len(client.features) == len(defaults) + 6
    assert len(client.keys[environment["id"]]) == 1

    feature, state = client.project_flag(environment, "flow_view")
    assert feature["type"] == "MULTIVARIATE"
    assert state["enabled"] is True
    assert state["feature_state_value"] == "side_by_side"
    options = {option["id"]: option for option in feature["multivariate_options"]}
    allocations = {
        options[row["multivariate_feature_option"]]["key"]: row["percentage_allocation"]
        for row in state["multivariate_feature_state_values"]
    }
    assert allocations == {"overlay": 33, "overlay_summary": 33}
    assert 100 - sum(allocations.values()) == 34
    assert all(option["string_value"] == option["key"] for option in options.values())
    assert (
        "POST",
        f"environments/{environment['id']}/features/{feature['id']}/versions/",
    ) in client.calls

    direction, state = client.project_flag(environment, "flow_direction")
    assert direction["type"] == "MULTIVARIATE"
    assert direction["tags"] == feature["tags"]
    assert state["enabled"] is True
    assert state["feature_state_value"] == "horizontal"
    (vertical,) = direction["multivariate_options"]
    assert vertical["key"] == vertical["string_value"] == "vertical"
    (weight,) = state["multivariate_feature_state_values"]
    assert weight["multivariate_feature_option"] == vertical["id"]
    assert weight["percentage_allocation"] == 50
    for name, enabled in [
        ("flagsmith_mode", True),
        ("ai_summary", False),
        ("new_checkout", True),
        ("holiday_discount", True),
    ]:
        _, state = client.project_flag(environment, name)
        assert state["enabled"] is enabled
        assert state["feature_state_value"] is None
    for flag in defaults:
        feature, state = client.project_flag(environment, flag.name)
        assert feature["type"] == flag.kind
        assert state["enabled"] is flag.enabled
        assert type(state["feature_state_value"]) is type(flag.value)
        assert state["feature_state_value"] == flag.value

    assert json.loads(scope_file.read_bytes()) == {
        "schema": "code-flow/flagsmith-scopes@1",
        "project": "code-flow",
        "environment": "Production",
        "repos": {
            "shop-demo": ["holiday_discount", "new_checkout"],
            "Flagsmith__flagsmith": sorted(flag.name for flag in defaults),
        },
        "code_flow_flags": ["ai_summary", "flagsmith_mode", "flow_direction", "flow_view"],
    }

    first = capsys.readouterr()
    assert "Using Flagsmith environment code-flow/Production." in first.out
    assert "Wrote CODEFLOW_FLAGSMITH_ENV_KEY" in first.out
    assert "Enabled the Flagsmith database warehouse." in first.out
    client.calls.clear()
    before = (env_file.stat().st_mtime_ns, scope_file.stat().st_mtime_ns)

    setup_script.setup(client, defaults, env_file, dry_run=False, scope_file=scope_file)

    second = capsys.readouterr()
    assert client.calls and all(method == "GET" for method, _ in client.calls)
    assert "differs from defaults" not in second.out
    assert "Wrote" not in second.out
    assert (env_file.stat().st_mtime_ns, scope_file.stat().st_mtime_ns) == before
    settings = setup_script.read_env(env_file)
    scopes = scope_file.read_text()
    for secret in [*settings.values(), "test-export-secret", "test-nonpublic-config-value"]:
        assert secret not in first.out + first.err + second.out + second.err + scopes


def test_existing_flag_only_gets_missing_tag_and_scope_uses_actual_tags(
    env_file, scope_file, capsys
):
    client = FakeAdminClient()
    project = client.add_project()
    environment = client.add_environment(project, "Production")
    tags_path = f"projects/{project}/tags/"
    features_path = f"projects/{project}/features/"
    shop_tag = client.request("POST", tags_path, {"label": "repo:shop-demo"})
    other_tag = client.request("POST", tags_path, {"label": "other"})
    client.request("POST", features_path, {"name": "extra_shop_flag", "tags": [shop_tag["id"]]})
    client.request("POST", features_path, {"name": "untagged_flag"})
    existing = client.request(
        "POST",
        features_path,
        {
            "name": "flow_view",
            "type": "MULTIVARIATE",
            "is_archived": True,
            "initial_value": "test-remote-secret-value",
            "tags": [other_tag["id"]],
            "metadata": [{"id": 31, "model_field": 12, "field_value": "test-metadata-secret"}],
        },
    )
    client.request(
        "POST",
        f"{features_path}{existing['id']}/mv-options/",
        {
            "feature": existing["id"],
            "key": "custom_variant",
            "type": "unicode",
            "string_value": "test-variant-secret-value",
            "default_percentage_allocation": 19,
        },
    )
    feature, state = client.project_flag(environment, "flow_view")
    old_feature = copy.deepcopy(feature)
    old_state = copy.deepcopy(state)
    client.calls.clear()

    setup_script.setup(client, [], env_file, dry_run=False, scope_file=scope_file)

    code_flow_tag = next(tag for tag in client.tags if tag["label"] == "code-flow")
    assert feature == {**old_feature, "tags": [other_tag["id"], code_flow_tag["id"]]}
    assert state == old_state
    assert ("PATCH", f"{features_path}{existing['id']}/") in client.calls
    assert json.loads(scope_file.read_bytes())["repos"]["shop-demo"] == [
        "extra_shop_flag",
        "holiday_discount",
        "new_checkout",
    ]
    output = capsys.readouterr()
    (drift_note,) = [line for line in output.out.splitlines() if "differs from defaults" in line]
    assert "flow_view" in drift_note
    assert "side_by_side" in drift_note
    assert "19%" in drift_note
    assert "test-" not in output.out + output.err


@pytest.mark.parametrize("existing_scope", [False, True])
def test_dry_run_has_no_api_or_file_writes(env_file, scope_file, capsys, existing_scope):
    client = FakeAdminClient()
    project = client.add_project()
    client.add_environment(project, "Production")
    client.request("POST", f"projects/{project}/features/", {"name": "flagsmith_mode"})
    client.calls.clear()
    original_env = env_file.read_bytes()
    if existing_scope:
        scope_file.parent.mkdir()
        scope_file.write_bytes(b'{"old": true}\n')

    setup_script.setup(client, [], env_file, dry_run=True, scope_file=scope_file)

    assert client.calls and all(method == "GET" for method, _ in client.calls)
    assert env_file.read_bytes() == original_env
    if existing_scope:
        assert scope_file.read_bytes() == b'{"old": true}\n'
    else:
        assert not scope_file.parent.exists()
    output = capsys.readouterr()
    assert "Would create tag code-flow." in output.out
    assert "Would add tag code-flow to flagsmith_mode." in output.out
    assert "Would create flag flow_view" in output.out
    assert (
        'Would create flag flow_direction with tag code-flow (on, "horizontal" 50%, "vertical" 50%).'
        in output.out
    )
    assert '"side_by_side" 34%, "overlay" 33%, "overlay_summary" 33%' in output.out
    assert "Would create server-side key code-flow server." in output.out
    assert "Would enable the Flagsmith database warehouse." in output.out
    assert "Would write CODEFLOW_FLAGSMITH_SERVER_KEY" in output.out
    assert "Would write the Flagsmith scope file" in output.out
    assert "secret" not in output.out + output.err


def test_env_update_preserves_other_bytes_and_inline_comments(tmp_path):
    path = tmp_path / ".env"
    path.write_bytes(
        b"# header \xff\r\nFLAGSMITH_ADMIN_API_KEY=test-admin-secret\r\n"
        b"export CODEFLOW_FLAGSMITH_ENV_KEY = 'old'  # retain comment\r\n"
        b"OTHER=a=b#c\nSHOP_DEMO_FLAGSMITH_SERVER_KEY=legacy-shop-key\r\n"
        b"FLAGSMITH_API_FLAGSMITH_SERVER_KEY=legacy-api-key\r\n"
        b"VITE_CODEFLOW_FLAGSMITH_ENV_KEY=already-right\r\n# final comment"
    )
    path.chmod(0o640)
    values = {
        "CODEFLOW_FLAGSMITH_ENV_KEY": "new",
        "VITE_CODEFLOW_FLAGSMITH_ENV_KEY": "already-right",
        "CODEFLOW_FLAGSMITH_SERVER_KEY": "appended",
    }
    assert setup_script.update_env_file(path, values) == [
        "CODEFLOW_FLAGSMITH_ENV_KEY",
        "CODEFLOW_FLAGSMITH_SERVER_KEY",
    ]
    assert path.read_bytes() == (
        b"# header \xff\r\nFLAGSMITH_ADMIN_API_KEY=test-admin-secret\r\n"
        b"export CODEFLOW_FLAGSMITH_ENV_KEY = 'new'  # retain comment\r\n"
        b"OTHER=a=b#c\nSHOP_DEMO_FLAGSMITH_SERVER_KEY=legacy-shop-key\r\n"
        b"FLAGSMITH_API_FLAGSMITH_SERVER_KEY=legacy-api-key\r\n"
        b"VITE_CODEFLOW_FLAGSMITH_ENV_KEY=already-right\r\n# final comment\r\n"
        b"CODEFLOW_FLAGSMITH_SERVER_KEY=appended\r\n"
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


def test_existing_warehouse_connection_is_preserved(capsys):
    client = FakeAdminClient()
    environment = client.add_environment(client.add_project(), "Production")
    existing = {"warehouse_type": "postgres", "config": {"source": "external"}}
    client.warehouses[environment["id"]] = [existing]

    setup_script.ensure_warehouse(client, environment, dry_run=False)

    assert client.calls and all(method == "GET" for method, _ in client.calls)
    assert client.warehouses == {environment["id"]: [existing]}
    assert "already has a different warehouse connection" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("status", "expected_schemes"), [(403, ["Api-Key"]), (401, ["Api-Key", "Token"])]
)
def test_main_hides_http_error_url_and_body(
    status, expected_schemes, export_file, env_file, monkeypatch, capsys
):
    authorizations = []

    class ErrorOpener:
        def open(self, request, timeout):
            assert request.get_method() == "GET"
            authorizations.append(request.get_header("Authorization"))
            assert request.full_url == "http://localhost:8000/api/v1/organisations/"
            raise HTTPError(
                request.full_url + "test-secret-url",
                status,
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
    assert authorizations == [f"{scheme} test-admin-secret" for scheme in expected_schemes]
    result = capsys.readouterr()
    assert (
        result.err == f"Flagsmith setup failed. Flagsmith Admin API GET returned HTTP {status}.\n"
    )
    assert "secret" not in result.out + result.err


@pytest.mark.parametrize(
    ("working_scheme", "expected_schemes"),
    [("Api-Key", ["Api-Key", "Api-Key"]), ("Token", ["Api-Key", "Token", "Token"])],
)
def test_admin_client_remembers_working_auth_scheme(monkeypatch, working_scheme, expected_schemes):
    authorizations = []

    class AuthOpener:
        def open(self, request, timeout):
            authorization = request.get_header("Authorization")
            authorizations.append(authorization)
            path = urlsplit(request.full_url).path
            if authorization != f"{working_scheme} test-key" or path.endswith("/projects/"):
                raise HTTPError(request.full_url, 401, "Unauthorized", {}, io.BytesIO())
            return io.BytesIO(b'[{"id": 1}]')

    monkeypatch.setattr(setup_script, "build_opener", lambda _: AuthOpener())
    client = setup_script.AdminClient("http://example.test/api/v1/", "test-key")
    assert client.list("organisations/") == [{"id": 1}]
    with pytest.raises(setup_script.AdminError, match="HTTP 401"):
        client.list("projects/")
    assert authorizations == [f"{scheme} test-key" for scheme in expected_schemes]


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
