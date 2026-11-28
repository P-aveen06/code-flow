"""Set up code-flow's app flags and read repo scopes from existing Flagsmith tags."""

import argparse
import fcntl
import json
import os
import re
import sys
import tempfile
from collections import Counter
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from http.client import HTTPException
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

DEFAULT_API_URL = "http://localhost:8000/api/v1/"
DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DEFAULT_SCOPE_FILE = DATA_DIR / "flagsmith_scopes.json"
PROJECT_NAME = "code-flow"
PRODUCTION_ENVIRONMENT = "Production"
DEFAULT_SIM_ENVIRONMENT = "Development"
SIM_ENVIRONMENT_SETTING = "CODEFLOW_SIM_ENVIRONMENT"
CODE_FLOW_TAG = "code-flow"
VARIANT_PREVIEW = "variant_preview"
REPO_ID_BY_TAG = {
    "repo:flagsmith-api": "Flagsmith__flagsmith",
}
SERVER_KEY_NAME = "code-flow server"
MANUAL_WAREHOUSE_STEP = "Environment Settings > Warehouse > Flagsmith database > Enable"

Record = dict[str, Any]
FlagValue = str | int | bool | None


class SetupError(Exception):
    """An error with a message safe to show on the command line."""


class AdminError(SetupError):
    """A failed Flagsmith HTTP request."""

    def __init__(self, method: str, status: int):
        self.status = status
        super().__init__(f"Flagsmith Admin API {method} returned HTTP {status}.")


class NoRedirects(HTTPRedirectHandler):
    """Keep credentials on the configured API and preserve the HTTP method."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AdminClient:
    """Send JSON requests to the Flagsmith Admin API."""

    def __init__(self, api_url: str, admin_key: str):
        self.base_url = api_url.rstrip("/") + "/"
        self.base = urlsplit(self.base_url)
        if (
            self.base.scheme not in ("http", "https")
            or not self.base.hostname
            or self.base.username is not None
            or self.base.query
            or self.base.fragment
        ):
            raise SetupError("FLAGSMITH_API_URL must be an HTTP(S) API base URL.")
        self.admin_key = admin_key
        self.opener = build_opener(NoRedirects())
        self._auth_scheme: str | None = None

    def request(self, method: str, path: str, data: Record | None = None) -> Any:
        if self._auth_scheme is not None:
            return self._request(method, path, data, self._auth_scheme)

        # Organisation API keys use Api-Key. Personal API tokens use Token.
        scheme = "Api-Key"
        try:
            result = self._request(method, path, data, scheme)
        except AdminError as error:
            if error.status != 401:
                raise
            scheme = "Token"
            result = self._request(method, path, data, scheme)
        self._auth_scheme = scheme
        return result

    def _request(self, method: str, path: str, data: Record | None, scheme: str) -> Any:
        url = urljoin(self.base_url, path)
        target = urlsplit(url)
        if (target.scheme, target.netloc) != (
            self.base.scheme,
            self.base.netloc,
        ) or not target.path.startswith(self.base.path):
            raise SetupError("Flagsmith returned a pagination link outside the API base URL.")
        headers = {"Authorization": f"{scheme} {self.admin_key}", "Accept": "application/json"}
        body = None
        if data is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(data).encode()
        try:
            request = Request(url, data=body, headers=headers, method=method)
            with self.opener.open(request, timeout=15) as response:
                content = response.read()
                return json.loads(content) if content else None
        except HTTPError as error:
            error.close()
            raise AdminError(method, error.code) from None
        except (OSError, HTTPException, ValueError):
            raise SetupError(f"Flagsmith Admin API {method} failed to return JSON.") from None

    def list(self, path: str) -> list[Record]:
        records = []
        visited = set()
        url = urljoin(self.base_url, path)
        while url:
            if url in visited:
                raise SetupError("Flagsmith returned a repeated pagination link.")
            visited.add(url)
            page = self.request("GET", url)
            if isinstance(page, list):
                records.extend(page)
                break
            if not isinstance(page, dict) or not isinstance(page.get("results"), list):
                raise SetupError("Flagsmith returned an unexpected list response.")
            records.extend(page["results"])
            next_page = page.get("next")
            url = urljoin(url, next_page) if next_page else ""
        return records


@dataclass(frozen=True)
class Variant:
    value: FlagValue
    allocation: float
    key: str | None = None


@dataclass(frozen=True)
class Flag:
    name: str
    enabled: bool
    value: FlagValue = None
    kind: str = "STANDARD"
    variants: tuple[Variant, ...] = ()


FLOW_VIEW_FLAG = Flag(
    "flow_view",
    True,
    "side_by_side",
    "MULTIVARIATE",
    (
        Variant("overlay", 33, "overlay"),
        Variant("overlay_summary", 33, "overlay_summary"),
    ),
)
FLOW_DIRECTION_FLAG = Flag(
    "flow_direction",
    True,
    "horizontal",
    "MULTIVARIATE",
    (Variant("vertical", 50, "vertical"),),
)
# Control keeps the public URL form; the variant leads with Sign in with GitHub.
GITHUB_SIGNIN_FLAG = Flag(
    "github_signin",
    True,
    "url_import",
    "MULTIVARIATE",
    (Variant("github_signin", 50, "github_signin"),),
)
# How many recent commits the repo details page lists and analyzes for a chosen branch.
BRANCH_COMMIT_COUNT_FLAG = Flag("branch_commit_count", True, 20)


def same_value(left: FlagValue, right: FlagValue) -> bool:
    return type(left) is type(right) and left == right


def value_fields(value: FlagValue) -> Record:
    """Encode Flagsmith's typed value fields, including an explicit null."""
    if isinstance(value, bool):
        return {"type": "bool", "boolean_value": value}
    if isinstance(value, int):
        return {"type": "int", "integer_value": value}
    return {"type": "unicode", "string_value": value}


def find_record(records: list[Record], field: str, value: str, resource: str) -> Record | None:
    matches = [record for record in records if record[field] == value]
    if len(matches) > 1:
        raise SetupError(f"Flagsmith has multiple matching {resource} records.")
    return matches[0] if matches else None


def select_environment(environments: list[Record], name: str) -> Record:
    environment = find_record(environments, "name", name, "environment")
    if environment is None:
        raise SetupError(
            f"Environment {name!r} was not found in the code-flow project. "
            "Create it in Flagsmith or select an existing one with --environment."
        )
    return environment


def ensure_tag(
    client: AdminClient, path: str, tags: list[Record], label: str, dry_run: bool
) -> int | None:
    tag = find_record(tags, "label", label, "tag")
    if tag is not None:
        return tag["id"]
    if dry_run:
        print(f"Would create tag {label}.")
        return None
    tag = client.request("POST", path, {"label": label})
    print(f"Created tag {label}.")
    return tag["id"]


def create_flag(
    client: AdminClient,
    path: str,
    flag: Flag,
    tag_id: int,
    environment_defaults: list[tuple[Record, Flag]],
) -> None:
    # Flagsmith creates a state in every environment.
    feature = client.request("POST", path, {"name": flag.name, "type": flag.kind, "tags": [tag_id]})
    feature_id = feature["id"]
    weights = {}
    for variant in flag.variants:
        data = {
            "feature": feature_id,
            "default_percentage_allocation": 0,
            **value_fields(variant.value),
        }
        if variant.key is not None:
            data["key"] = variant.key
        option = client.request("POST", f"{path}{feature_id}/mv-options/", data)
        weights[option["id"]] = variant.allocation
    for environment, defaults in environment_defaults:
        state = get_flag_state(client, environment, feature_id)
        if state is None:
            raise SetupError("Flagsmith did not create an initial state for the new flag.")
        apply_flag_defaults(
            client, environment, feature_id, defaults, weights if defaults.enabled else {}, state
        )


def get_flag_state(client: AdminClient, environment: Record, feature_id: int) -> Record | None:
    path = f"environments/{environment['api_key']}/featurestates/?feature={feature_id}"
    states = client.list(path)
    if len(states) > 1:
        raise SetupError("Flagsmith returned multiple live states for one environment flag.")
    return states[0] if states else None


def apply_flag_defaults(
    client: AdminClient,
    environment: Record,
    feature_id: int,
    flag: Flag,
    weights: dict[int, float],
    state: Record,
) -> None:
    weight_rows = {
        row["multivariate_feature_option"]: row
        for row in state["multivariate_feature_state_values"]
    }
    actual_weights = {option: row["percentage_allocation"] for option, row in weight_rows.items()}
    if (
        state["enabled"] == flag.enabled
        and same_value(state["feature_state_value"], flag.value)
        and actual_weights == weights
    ):
        return

    data = {"enabled": flag.enabled, "feature_state_value": value_fields(flag.value)}
    if actual_weights != weights:
        data["multivariate_feature_state_values"] = [
            {
                **({"id": weight_rows[option]["id"]} if option in weight_rows else {}),
                "multivariate_feature_option": option,
                "percentage_allocation": allocation,
            }
            for option, allocation in weights.items()
        ]
    environment_id = environment["id"]
    if environment["use_v2_feature_versioning"]:
        client.request(
            "POST",
            f"environments/{environment_id}/features/{feature_id}/versions/",
            {"publish_immediately": True, "feature_states_to_update": [data]},
        )
    else:
        client.request(
            "PATCH",
            f"features/featurestates/{state['id']}/",
            {"environment": environment_id, **data},
        )


def show_value(value: FlagValue) -> str:
    # Remote strings may contain credentials.
    if isinstance(value, str) and value not in (
        "",
        "side_by_side",
        "overlay",
        "overlay_summary",
        "horizontal",
        "vertical",
        "url_import",
        "github_signin",
    ):
        return "<redacted>"
    return json.dumps(value)


def show_state(enabled: bool, value: FlagValue, variants: tuple[Variant, ...]) -> str:
    status = "on" if enabled else "off"
    parts = [status, show_value(value)]
    if variants and (enabled or any(variant.allocation for variant in variants)):
        control = 100 - sum(variant.allocation for variant in variants)
        parts[-1] += f" {control:g}%"
        parts.extend(f"{show_value(variant.value)} {variant.allocation:g}%" for variant in variants)
    return ", ".join(parts)


def configure_existing_flag(
    client: AdminClient,
    environment: Record,
    feature: Record,
    flag: Flag,
    *,
    active_experiment: Record | None,
    simulation_environment: bool,
    dry_run: bool,
) -> None:
    if active_experiment is not None:
        name = json.dumps(active_experiment["name"], ensure_ascii=False)
        status = active_experiment["status"]
        print(
            f"Skipping {flag.name}: experiment {name} is {status} in {environment['name']}; "
            "Flagsmith manages its state."
        )
        return

    restore_defaults = simulation_environment and flag.name in (
        FLOW_VIEW_FLAG.name,
        FLOW_DIRECTION_FLAG.name,
        GITHUB_SIGNIN_FLAG.name,
        VARIANT_PREVIEW,
    )
    state = get_flag_state(client, environment, feature["id"])
    if state is None:
        if restore_defaults:
            raise SetupError(f"{flag.name} has no environment state to configure.")
        print(f"{flag.name} differs from defaults (no live state).")
        return
    weights = {
        row["multivariate_feature_option"]: row["percentage_allocation"]
        for row in state["multivariate_feature_state_values"]
    }
    value_fields_by_type = {
        "unicode": "string_value",
        "int": "integer_value",
        "bool": "boolean_value",
    }
    variants_by_id = {
        option["id"]: Variant(
            option[value_fields_by_type.get(option["type"], "string_value")],
            weights.get(option["id"], 0),
            option.get("key"),
        )
        for option in feature["multivariate_options"]
    }
    variants = tuple(variants_by_id.values())
    live_value = state["feature_state_value"]
    live_enabled = state["enabled"]
    if (
        live_enabled == flag.enabled
        and same_value(live_value, flag.value)
        and Counter((type(variant.value), variant) for variant in variants)
        == Counter((type(variant.value), variant) for variant in flag.variants)
        and feature["type"] == flag.kind
    ):
        return

    if restore_defaults:
        expected_options = {
            (type(variant.value), variant.value, variant.key): variant.allocation
            for variant in flag.variants
        }
        actual_options = {
            option_id: (type(variant.value), variant.value, variant.key)
            for option_id, variant in variants_by_id.items()
        }
        if (
            feature["type"] == flag.kind
            and len(variants) == len(flag.variants) == len(expected_options)
            and set(actual_options.values()) == expected_options.keys()
        ):
            allocations = {
                option_id: expected_options[signature]
                for option_id, signature in actual_options.items()
            }
            if not dry_run:
                apply_flag_defaults(client, environment, feature["id"], flag, allocations, state)
            verb = "Would set" if dry_run else "Set"
            print(f"{verb} {flag.name} to {show_state(flag.enabled, flag.value, flag.variants)}.")
            return
        raise SetupError(f"{flag.name} has project variants that differ from setup defaults.")

    print(
        f"{flag.name} differs from defaults "
        f"(current {feature['type']} {show_state(live_enabled, live_value, variants)} | "
        f"expected {flag.kind} {show_state(flag.enabled, flag.value, flag.variants)})."
    )


def add_tag_to_flag(
    client: AdminClient, path: str, feature: Record, label: str, tag_id: int | None, dry_run: bool
) -> None:
    if tag_id in feature["tags"]:
        return
    if dry_run:
        print(f"Would add tag {label} to {feature['name']}.")
        return
    detail_path = f"{path}{feature['id']}/"
    latest = client.request("GET", detail_path)
    if tag_id not in latest["tags"]:
        # Flagsmith replaces metadata even when PATCH omits it.
        client.request(
            "PATCH",
            detail_path,
            {"tags": [*latest["tags"], tag_id], "metadata": latest["metadata"]},
        )
        print(f"Added tag {label} to {feature['name']}.")


def ensure_server_key(client: AdminClient, environment: Record, dry_run: bool) -> str | None:
    path = f"environments/{environment['api_key']}/api-keys/"
    key = find_record(client.list(path), "name", SERVER_KEY_NAME, "server key")
    if key is None:
        if dry_run:
            print(f"Would create server-side key {SERVER_KEY_NAME}.")
            return None
        key = client.request("POST", path, {"name": SERVER_KEY_NAME, "active": True})
        print(f"Created server-side key {SERVER_KEY_NAME}.")
    expires_at = key.get("expires_at")
    if not key["active"] or (
        expires_at and datetime.fromisoformat(expires_at) <= datetime.now(UTC)
    ):
        raise SetupError("The existing code-flow server key is inactive or expired.")
    return key["key"]


def ensure_warehouse(client: AdminClient, environment: Record, dry_run: bool) -> None:
    path = f"environments/{environment['api_key']}/warehouse-connections/"
    try:
        connections = client.list(f"{path}?exclude_event_stats=true")
        for connection in connections:
            if (
                connection["warehouse_type"] == "postgres"
                and (connection.get("config") or {}).get("source") == "flagsmith_database"
            ):
                print("Flagsmith database warehouse unchanged.")
                return
        if connections:
            print("The selected environment already has a different warehouse connection.")
            return
        if dry_run:
            print("Would enable the Flagsmith database warehouse.")
            return
        client.request(
            "POST",
            path,
            {"warehouse_type": "postgres", "config": {"source": "flagsmith_database"}},
        )
        print("Enabled the Flagsmith database warehouse.")
        return
    except AdminError as error:
        if error.status not in (400, 403, 404, 405, 501):
            raise
        print(f"Flagsmith database warehouse unavailable through the API (HTTP {error.status}).")
    print(MANUAL_WAREHOUSE_STEP)


ENV_ASSIGNMENT = re.compile(
    rb"(?P<prefix>[ \t]*(?:export[ \t]+)?(?P<name>[a-zA-Z_][a-zA-Z0-9_]*)[ \t]*=)"
    rb"(?P<value>[^\r\n]*)(?P<newline>\r\n|\n|\r)?"
)
INLINE_COMMENT = re.compile(rb"[ \t]+#")
QUOTED_ENV_VALUE = re.compile(rb"""(?:'[^']*'|"(?:\\.|[^"\\])*")""")


def split_env_value(raw: bytes) -> tuple[bytes, bytes, bytes]:
    """Split an assignment value from its whitespace and inline comment."""
    rest = raw.lstrip(b" \t")
    prefix = raw[: len(raw) - len(rest)]
    if rest.startswith(b"#") and prefix:
        return b"", b"", raw
    if quoted := QUOTED_ENV_VALUE.match(rest):
        return prefix, quoted[0], rest[quoted.end() :]
    comment = INLINE_COMMENT.search(rest)
    value = (rest[: comment.start()] if comment else rest).rstrip(b" \t")
    return prefix, value, rest[len(value) :]


def unquote(value: bytes) -> bytes:
    if len(value) < 2:
        return value
    if value.startswith(b'"') and value.endswith(b'"'):
        return re.sub(rb'\\([\\$`"])', rb"\1", value[1:-1])
    if value.startswith(b"'") and value.endswith(b"'"):
        return value[1:-1]
    return value


def read_env(path: Path) -> dict[str, str]:
    settings = {}
    for line in path.read_bytes().splitlines(keepends=True):
        if match := ENV_ASSIGNMENT.fullmatch(line):
            _, value, _ = split_env_value(match["value"])
            settings[match["name"].decode()] = unquote(value).decode("utf-8", "surrogateescape")
    return settings


def replace_file(path: Path, content: bytes) -> None:
    """Write a complete file before replacing its destination."""
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
    try:
        temporary.write_bytes(content)
        if path.exists():
            temporary.chmod(path.stat().st_mode & 0o777)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def update_env_file(path: Path, values: dict[str, str | None], dry_run: bool = False) -> list[str]:
    """Update only the requested assignments and preserve all other bytes."""
    path = path.resolve()
    original = path.read_bytes()
    encoded = {}
    for name, value in values.items():
        if value is None and dry_run:
            encoded[name.encode()] = None
        elif value is not None and re.fullmatch(r"[a-zA-Z0-9_.-]+", value):
            encoded[name.encode()] = value.encode()
        elif name == SIM_ENVIRONMENT_SETTING:
            if not value or value != value.strip() or not value.isprintable():
                raise SetupError(
                    "The simulation environment name cannot be stored in the .env file."
                )
            escaped = re.sub(rb'([\\$`"])', rb"\\\1", value.encode())
            encoded[name.encode()] = b'"' + escaped + b'"'
        else:
            raise SetupError("Flagsmith returned an invalid SDK key.")
    changed = set()
    seen = set()
    lines = []
    newline = re.search(rb"\r\n|\n|\r", original)
    separator = newline.group() if newline else b"\n"
    for line in original.splitlines(keepends=True):
        match = ENV_ASSIGNMENT.fullmatch(line)
        if not match or (name := match["name"]) not in encoded:
            lines.append(line)
            continue
        prefix, old_value, suffix = split_env_value(match["value"])
        value = encoded[name]
        old_unquoted = unquote(old_value)
        unquoted = unquote(value) if value is not None else None
        if old_unquoted == unquoted:
            lines.append(line)
        elif not dry_run:
            if old_value != old_unquoted and value == unquoted:
                value = old_value[:1] + value + old_value[-1:]
            lines.append(match["prefix"] + prefix + value + suffix + (match["newline"] or b""))
            changed.add(name)
        else:
            changed.add(name)
        seen.add(name)

    missing = [name for name in encoded if name not in seen]
    changed.update(missing)
    if not dry_run and changed:
        if missing and lines and not lines[-1].endswith((b"\n", b"\r")):
            lines.append(separator)
        lines.extend(name + b"=" + encoded[name] + separator for name in missing)
        replace_file(path, b"".join(lines))
    return [name for name in values if name.encode() in changed]


def write_scopes(
    path: Path,
    environment_name: str,
    flag_names_by_tag: dict[str, set[str]],
    dry_run: bool,
) -> None:
    repos: dict[str, set[str]] = {}
    for label, names in flag_names_by_tag.items():
        prefix, _, repo_name = label.partition(":")
        if prefix == "repo" and repo_name and names:
            repo_id = REPO_ID_BY_TAG.get(label, repo_name)
            repos.setdefault(repo_id, set()).update(names)
    scopes = {
        "schema": "code-flow/flagsmith-scopes@1",
        "project": PROJECT_NAME,
        "environment": environment_name,
        "repos": {repo_id: sorted(repos[repo_id]) for repo_id in sorted(repos)},
        "code_flow_flags": sorted(flag_names_by_tag[CODE_FLOW_TAG]),
    }
    content = (json.dumps(scopes, indent=2) + "\n").encode()
    if path.exists() and path.read_bytes() == content:
        return
    if dry_run:
        print("Would write the Flagsmith scope file from project tags.")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        replace_file(path, content)
        print("Wrote the Flagsmith scope file from project tags.")


def setup(
    client: AdminClient,
    env_file: Path,
    dry_run: bool,
    *,
    environment_name: str = PRODUCTION_ENVIRONMENT,
    scope_file: Path = DEFAULT_SCOPE_FILE,
) -> None:
    app_environment = environment_name == PRODUCTION_ENVIRONMENT
    app_flags = [
        FLOW_VIEW_FLAG,
        FLOW_DIRECTION_FLAG,
        GITHUB_SIGNIN_FLAG,
        BRANCH_COMMIT_COUNT_FLAG,
        Flag("flagsmith_mode", True),
        Flag("ai_summary", False),
        Flag("live_flag_panel", False),
        Flag(VARIANT_PREVIEW, not app_environment),
    ]
    scope_file = scope_file.resolve()
    if scope_file == env_file.resolve():
        raise SetupError("Use different paths for the environment and scope files.")

    organisations = client.list("organisations/")
    if len(organisations) != 1:
        raise SetupError("The admin API key must identify exactly one Flagsmith organisation.")
    organisation = organisations[0]["id"]
    projects = client.list(f"projects/?organisation={organisation}")
    project = find_record(projects, "name", PROJECT_NAME, "project")
    if project is None:
        raise SetupError("Create a project named code-flow in the Flagsmith dashboard first.")
    project_path = f"projects/{project['id']}/"
    environments = client.list(f"{project_path}environments/")
    environment = select_environment(environments, environment_name)
    print(f"Using Flagsmith environment {PROJECT_NAME}/{environment['name']}.")

    tags_path = f"{project_path}tags/"
    project_tags = client.list(tags_path)
    feature_path = f"{project_path}features/"
    features = {feature["name"].casefold(): feature for feature in client.list(feature_path)}
    active_experiments = {}
    if not app_environment and features:
        experiments_path = f"environments/{environment['api_key']}/experiments/"
        active_experiments = {
            experiment["feature"]["id"]: experiment
            for experiment in client.list(experiments_path)
            if experiment["status"] not in ("completed", "created", "draft")
        }
    tag_id = ensure_tag(client, tags_path, project_tags, CODE_FLOW_TAG, dry_run)
    for flag in app_flags:
        name = flag.name.casefold()
        if feature := features.get(name):
            configure_existing_flag(
                client,
                environment,
                feature,
                flag,
                active_experiment=active_experiments.get(feature["id"]),
                simulation_environment=not app_environment,
                dry_run=dry_run,
            )
            add_tag_to_flag(client, feature_path, feature, CODE_FLOW_TAG, tag_id, dry_run)
        else:
            verb = "Would create" if dry_run else "Created"
            if tag_id is not None and not dry_run:
                environment_defaults = [(environment, flag)]
                if name == VARIANT_PREVIEW:
                    environment_defaults = [
                        (env, replace(flag, enabled=env["name"] != PRODUCTION_ENVIRONMENT))
                        for env in environments
                    ]
                create_flag(client, feature_path, flag, tag_id, environment_defaults)
            print(
                f"{verb} flag {flag.name} with tag {CODE_FLOW_TAG} "
                f"({show_state(flag.enabled, flag.value, flag.variants)})."
            )

    if app_environment:
        keys = {
            "CODEFLOW_FLAGSMITH_ENV_KEY": environment["api_key"],
            "VITE_CODEFLOW_FLAGSMITH_ENV_KEY": environment["api_key"],
            "CODEFLOW_FLAGSMITH_SERVER_KEY": ensure_server_key(client, environment, dry_run),
        }
    else:
        keys = {
            "CODEFLOW_SIM_FLAGSMITH_ENV_KEY": environment["api_key"],
            SIM_ENVIRONMENT_SETTING: environment_name,
        }
    ensure_warehouse(client, environment, dry_run)

    if app_environment:
        # Use the actual tag memberships, including planned attachments in a preview.
        tagged_features = features.values() if dry_run else client.list(feature_path)
        labels_by_id = {tag["id"]: tag["label"] for tag in project_tags}
        if tag_id is not None:
            labels_by_id[tag_id] = CODE_FLOW_TAG
        flag_names_by_tag: dict[str, set[str]] = {CODE_FLOW_TAG: set()}
        for feature in tagged_features:
            for feature_tag in feature["tags"]:
                if label := labels_by_id.get(feature_tag):
                    flag_names_by_tag.setdefault(label, set()).add(feature["name"])
        if dry_run:
            for flag in app_flags:
                feature = features.get(flag.name.casefold())
                flag_names_by_tag[CODE_FLOW_TAG].add(feature["name"] if feature else flag.name)

    for variable in update_env_file(env_file, keys, dry_run):
        verb = "Would write" if dry_run else "Wrote"
        print(f"{verb} {variable} to the environment file.")
    if app_environment:
        write_scopes(scope_file, environment_name, flag_names_by_tag, dry_run)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run", action="store_true", help="Preview changes using only GET requests."
    )
    parser.add_argument(
        "--env-file", type=Path, default=Path(".env"), help="Environment file (default .env)."
    )
    parser.add_argument(
        "--environment",
        metavar="NAME",
        default=PRODUCTION_ENVIRONMENT,
        help="Choose an existing environment (default Production).",
    )
    parser.add_argument(
        "--scope-file",
        type=Path,
        default=DEFAULT_SCOPE_FILE,
        help="Scope file to generate (default data/flagsmith_scopes.json).",
    )
    args = parser.parse_args()
    try:
        settings = read_env(args.env_file)
        admin_key = settings.get("FLAGSMITH_ADMIN_API_KEY")
        if not admin_key:
            raise SetupError("Set FLAGSMITH_ADMIN_API_KEY in the environment file.")
        client = AdminClient(settings.get("FLAGSMITH_API_URL") or DEFAULT_API_URL, admin_key)
        options = {"environment_name": args.environment, "scope_file": args.scope_file}
        if args.dry_run:
            print("Dry run.")
            setup(client, args.env_file, dry_run=True, **options)
        else:
            # Serialise setup in this checkout. Flagsmith does not enforce unique key names.
            directory = os.open(Path(__file__).resolve().parent, os.O_RDONLY)
            try:
                fcntl.flock(directory, fcntl.LOCK_EX)
                setup(client, args.env_file, dry_run=False, **options)
            finally:
                os.close(directory)
    except SetupError as error:
        print(f"Flagsmith setup failed. {error}", file=sys.stderr)
        return 1
    except OSError:
        print("Flagsmith setup failed. Could not read or write a setup file.", file=sys.stderr)
        return 1
    except (KeyError, TypeError, ValueError):
        print("Flagsmith setup failed. The Admin API URL or response was invalid.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
