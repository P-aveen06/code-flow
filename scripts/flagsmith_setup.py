"""Provision the code-flow demo projects on a self-hosted Flagsmith instance."""

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from http.client import HTTPException
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

DEFAULT_API_URL = "http://localhost:8000/api/v1/"
DEFAULT_CLONE = Path(__file__).resolve().parents[1] / "data/repos/Flagsmith__flagsmith"
ENVIRONMENT_EXPORT = "api/integrations/flagsmith/data/environment.json"
ENVIRONMENT_NAME = "Development"
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
    """Send JSON requests using organisation admin authentication."""

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

    def request(self, method: str, path: str, data: Record | None = None) -> Any:
        url = urljoin(self.base_url, path)
        target = urlsplit(url)
        if (target.scheme, target.netloc) != (
            self.base.scheme,
            self.base.netloc,
        ) or not target.path.startswith(self.base.path):
            raise SetupError("Flagsmith returned a pagination link outside the API base URL.")
        headers = {"Authorization": f"Api-Key {self.admin_key}", "Accept": "application/json"}
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


def same_value(left: FlagValue, right: FlagValue) -> bool:
    return type(left) is type(right) and left == right


def value_fields(value: FlagValue) -> Record:
    """Encode Flagsmith's typed value fields, including an explicit null."""
    if isinstance(value, bool):
        return {"type": "bool", "boolean_value": value}
    if isinstance(value, int):
        return {"type": "int", "integer_value": value}
    return {"type": "unicode", "string_value": value}


def load_flagsmith_api_defaults(path: Path) -> list[Flag]:
    """Read a local export file or the committed export in a local checkout."""
    try:
        if path.is_dir():
            content = subprocess.check_output(
                ["git", "-C", str(path), "show", f"HEAD:{ENVIRONMENT_EXPORT}"],
                stderr=subprocess.DEVNULL,
                env={**os.environ, "GIT_NO_LAZY_FETCH": "1", "GIT_TERMINAL_PROMPT": "0"},
            )
        else:
            content = path.read_bytes()
        states = json.loads(content)["feature_states"]
        flags = []
        for state in states:
            feature = state["feature"]
            name, kind = feature["name"], feature["type"]
            enabled, value = state["enabled"], state["feature_state_value"]
            variants = tuple(
                Variant(
                    entry["multivariate_feature_option"]["value"],
                    entry["percentage_allocation"],
                    entry["multivariate_feature_option"].get("key"),
                )
                for entry in state.get("multivariate_feature_state_values", [])
            )
            if (
                not re.fullmatch(r"[a-zA-Z0-9_.-]+", name)
                or kind not in ("STANDARD", "MULTIVARIATE")
                or type(enabled) is not bool
                or type(value) not in (str, int, bool, type(None))
                or any(
                    type(variant.value) not in (str, int, bool, type(None)) for variant in variants
                )
                or any(
                    type(variant.allocation) not in (float, int)
                    or not 0 <= variant.allocation <= 100
                    for variant in variants
                )
            ):
                raise ValueError
            if any(flag.name == name for flag in flags):
                raise SetupError("The local Flagsmith environment export contains duplicate flags.")
            if sum(variant.allocation for variant in variants) > 100:
                raise ValueError
            flags.append(Flag(name, enabled, value, kind, variants))
        return flags
    except (OSError, subprocess.CalledProcessError, ValueError, KeyError, TypeError):
        raise SetupError(
            "Could not load flag defaults from the local Flagsmith environment export."
        ) from None


def find_by_name(
    records: list[Record], name: str, resource: str, *, ignore_case: bool = False
) -> Record | None:
    if ignore_case:
        matches = [record for record in records if record["name"].casefold() == name.casefold()]
    else:
        matches = [record for record in records if record["name"] == name]
    if len(matches) > 1:
        raise SetupError(f"Flagsmith has multiple matching {resource} records.")
    return matches[0] if matches else None


def ensure_project(
    client: AdminClient, projects: list[Record], organisation: int, name: str, dry_run: bool
) -> tuple[Record | None, str]:
    project = find_by_name(projects, name, "project")
    if project is not None:
        return project, "unchanged"
    if not dry_run:
        project = client.request("POST", "projects/", {"name": name, "organisation": organisation})
    return project, "created"


def ensure_environment(
    client: AdminClient, project: Record | None, dry_run: bool
) -> tuple[Record | None, str]:
    if project is None:
        return None, "created"
    project_id = project["id"]
    environments = client.list(f"projects/{project_id}/environments/")
    environment = find_by_name(environments, ENVIRONMENT_NAME, "environment")
    if environment is not None:
        return environment, "unchanged"
    if not dry_run:
        environment = client.request(
            "POST", "environments/", {"name": ENVIRONMENT_NAME, "project": project_id}
        )
    return environment, "created"


def matching_variant(
    options: list[Record], variant: Variant, desired_keys: set[str]
) -> Record | None:
    for option in options:
        if variant.key is not None and option.get("key") == variant.key:
            return option
    fields = value_fields(variant.value)
    value_field = next(field for field in fields if field != "type")
    return next(
        (
            option
            for option in options
            if option.get("key") not in desired_keys
            and option["type"] == fields["type"]
            and same_value(option[value_field], variant.value)
        ),
        None,
    )


def ensure_multivariate(
    client: AdminClient,
    feature_path: str,
    feature: Record,
    variants: tuple[Variant, ...],
    dry_run: bool,
) -> tuple[dict[int, float], bool]:
    """Find or add options and return the desired weights for Development."""
    path = f"{feature_path}{feature['id']}/mv-options/"
    options = list(feature["multivariate_options"])
    desired_keys = {variant.key for variant in variants if variant.key is not None}
    weights = {}
    changed = False
    for variant in variants:
        option = matching_variant(options, variant, desired_keys)
        fields = value_fields(variant.value)
        if option is None:
            changed = True
            if dry_run:
                continue
            # Adding an option adds a weight to every environment in this project.
            # Set Development's weight separately so other environments keep their split.
            data = {"feature": feature["id"], "default_percentage_allocation": 0, **fields}
            if variant.key is not None:
                data["key"] = variant.key
            option = client.request("POST", path, data)
        elif any(not same_value(option[field], value) for field, value in fields.items()):
            changed = True
            if not dry_run:
                option = client.request(
                    "PUT",
                    f"{path}{option['id']}/",
                    {
                        "feature": feature["id"],
                        "key": option.get("key"),
                        "default_percentage_allocation": option["default_percentage_allocation"],
                        **fields,
                    },
                )
        options = [entry for entry in options if entry["id"] != option["id"]]
        weights[option["id"]] = variant.allocation
    return weights, changed


def reconcile_flag_state(
    client: AdminClient,
    environment: Record,
    feature_id: int,
    flag: Flag,
    weights: dict[int, float],
    dry_run: bool,
) -> bool:
    path = f"environments/{environment['api_key']}/featurestates/?feature={feature_id}"
    states = client.list(path)
    if len(states) != 1:
        raise SetupError("Flagsmith did not return exactly one live environment flag state.")
    state = states[0]
    weight_rows = {
        row["multivariate_feature_option"]: row
        for row in state["multivariate_feature_state_values"]
    }
    actual_weights = {option: row["percentage_allocation"] for option, row in weight_rows.items()}
    # Keep unused options in the project and leave their Development allocation at zero.
    desired_weights = dict.fromkeys(weight_rows, 0) | weights
    if (
        state["enabled"] == flag.enabled
        and same_value(state["feature_state_value"], flag.value)
        and actual_weights == desired_weights
    ):
        return False
    if dry_run:
        return True

    data = {"enabled": flag.enabled, "feature_state_value": value_fields(flag.value)}
    if actual_weights != desired_weights:
        data["multivariate_feature_state_values"] = [
            {
                **({"id": weight_rows[option]["id"]} if option in weight_rows else {}),
                "multivariate_feature_option": option,
                "percentage_allocation": allocation,
            }
            for option, allocation in desired_weights.items()
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
    return True


def ensure_flag(
    client: AdminClient,
    project: Record | None,
    environment: Record | None,
    features: list[Record],
    flag: Flag,
    dry_run: bool,
) -> str:
    feature = find_by_name(features, flag.name, "flag", ignore_case=True)
    created = feature is None
    if created and dry_run:
        return "created"
    path = f"projects/{project['id']}/features/"
    changed = False
    if created:
        feature = client.request(
            "POST",
            path,
            {
                "name": flag.name,
                "type": flag.kind,
                "default_enabled": flag.enabled,
                "initial_value": str(flag.value) if flag.value is not None else None,
            },
        )
    else:
        changes = {}
        if feature["name"] != flag.name:
            raise SetupError(
                "An existing Flagsmith flag uses different casing for the requested name."
            )
        if feature["type"] != flag.kind:
            changes["type"] = flag.kind
        if feature["is_archived"]:
            changes["is_archived"] = False
        if changes:
            changed = True
            if not dry_run:
                # Flagsmith replaces metadata even when PATCH omits it.
                changes["metadata"] = feature.get("metadata", [])
                client.request("PATCH", f"{path}{feature['id']}/", changes)
    weights, options_changed = ensure_multivariate(client, path, feature, flag.variants, dry_run)
    if environment is not None:
        state_changed = reconcile_flag_state(
            client, environment, feature["id"], flag, weights, dry_run
        )
        changed = changed or state_changed
    if created:
        return "created"
    return "updated" if changed or options_changed else "unchanged"


def ensure_server_key(client: AdminClient, environment: Record | None, dry_run: bool) -> str | None:
    if environment is None:
        return None
    path = f"environments/{environment['api_key']}/api-keys/"
    key = find_by_name(client.list(path), SERVER_KEY_NAME, "server key")
    if key is None:
        if dry_run:
            return None
        key = client.request("POST", path, {"name": SERVER_KEY_NAME, "active": True})
    expires_at = key.get("expires_at")
    if not key["active"] or (
        expires_at and datetime.fromisoformat(expires_at) <= datetime.now(UTC)
    ):
        raise SetupError("The existing code-flow server key is inactive or expired.")
    return key["key"]


def ensure_warehouse(client: AdminClient, environment: Record | None, dry_run: bool) -> None:
    if environment is None:
        print(
            "Would check whether the Flagsmith database can be enabled for code-flow/Development."
        )
        return
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
            print("code-flow/Development already has a different warehouse connection.")
        elif dry_run:
            print("Would enable the Flagsmith database warehouse.")
            return
        else:
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


def split_env_value(raw: bytes) -> tuple[bytes, bytes, bytes]:
    """Split an assignment value from its whitespace and inline comment."""
    rest = raw.lstrip(b" \t")
    prefix = raw[: len(raw) - len(rest)]
    if rest.startswith(b"#") and prefix:
        return b"", b"", raw
    if rest.startswith((b'"', b"'")) and (end := rest.find(rest[:1], 1)) >= 0:
        return prefix, rest[: end + 1], rest[end + 1 :]
    comment = INLINE_COMMENT.search(rest)
    value = (rest[: comment.start()] if comment else rest).rstrip(b" \t")
    return prefix, value, rest[len(value) :]


def unquote(value: bytes) -> bytes:
    if len(value) >= 2 and value[:1] in (b'"', b"'") and value[-1:] == value[:1]:
        return value[1:-1]
    return value


def read_env(path: Path) -> dict[str, str]:
    settings = {}
    for line in path.read_bytes().splitlines(keepends=True):
        if match := ENV_ASSIGNMENT.fullmatch(line):
            _, value, _ = split_env_value(match["value"])
            settings[match["name"].decode()] = unquote(value).decode("utf-8", "surrogateescape")
    return settings


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
        if unquote(old_value) == value:
            lines.append(line)
        elif not dry_run:
            if old_value != unquote(old_value):
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
        # Replace in place only after a complete write, preserving file permissions.
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
        try:
            temporary.write_bytes(b"".join(lines))
            temporary.chmod(path.stat().st_mode & 0o777)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return [name for name in values if name.encode() in changed]


def setup(client: AdminClient, defaults: list[Flag], env_file: Path, dry_run: bool) -> None:
    projects_and_flags = {
        "code-flow": [
            Flag(
                "flow_view",
                True,
                "side_by_side",
                "MULTIVARIATE",
                (
                    Variant("overlay", 33, "overlay"),
                    Variant("overlay_summary", 33, "overlay_summary"),
                ),
            ),
            Flag("flagsmith_mode", True),
            Flag("ai_summary", False),
        ],
        "shop-demo": [Flag("new_checkout", True), Flag("holiday_discount", True)],
        "flagsmith-api": defaults,
    }
    organisations = client.list("organisations/")
    if len(organisations) != 1:
        raise SetupError("The admin API key must identify exactly one Flagsmith organisation.")
    organisation = organisations[0]["id"]
    projects = client.list(f"projects/?organisation={organisation}")
    summary = {
        group: {action: [] for action in ("created", "updated", "unchanged")}
        for group in ("Projects", "Environments", "Flags")
    }
    keys = {}
    for name, flags in projects_and_flags.items():
        project, action = ensure_project(client, projects, organisation, name, dry_run)
        summary["Projects"][action].append(name)
        environment, action = ensure_environment(client, project, dry_run)
        location = f"{name}/{ENVIRONMENT_NAME}"
        summary["Environments"][action].append(location)
        features = client.list(f"projects/{project['id']}/features/") if project else []
        for flag in flags:
            action = ensure_flag(client, project, environment, features, flag, dry_run)
            status = "on" if flag.enabled else "off"
            if name == "code-flow" and flag.name == "flow_view":
                status += ", side_by_side 34%, overlay 33%, overlay_summary 33%"
            summary["Flags"][action].append(f"{name}/{flag.name} ({status})")
        if name == "code-flow":
            key = environment["api_key"] if environment is not None else None
            keys["CODEFLOW_FLAGSMITH_ENV_KEY"] = key
            keys["VITE_CODEFLOW_FLAGSMITH_ENV_KEY"] = key
            ensure_warehouse(client, environment, dry_run)
        else:
            variable = (
                "SHOP_DEMO_FLAGSMITH_SERVER_KEY"
                if name == "shop-demo"
                else "FLAGSMITH_API_FLAGSMITH_SERVER_KEY"
            )
            keys[variable] = ensure_server_key(client, environment, dry_run)

    label = ".env" if env_file == Path(".env") else "the environment file"
    for variable in update_env_file(env_file, keys, dry_run):
        verb = "would write" if dry_run else "wrote"
        print(f"{verb} {variable} to {label}")
    for group, actions in summary.items():
        for action, names in actions.items():
            if names:
                print(f"{group} {action} ({len(names)}) — {', '.join(names)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run", action="store_true", help="Preview changes using only GET requests."
    )
    parser.add_argument(
        "--env-file", type=Path, default=Path(".env"), help="Environment file (default .env)."
    )
    parser.add_argument(
        "--environment-json",
        type=Path,
        default=DEFAULT_CLONE,
        help="Local environment export or Flagsmith Git checkout (default data/repos/Flagsmith__flagsmith).",
    )
    args = parser.parse_args()
    try:
        settings = read_env(args.env_file)
        admin_key = settings.get("FLAGSMITH_ADMIN_API_KEY")
        if not admin_key:
            raise SetupError("Set FLAGSMITH_ADMIN_API_KEY in the environment file.")
        defaults = load_flagsmith_api_defaults(args.environment_json)
        client = AdminClient(settings.get("FLAGSMITH_API_URL") or DEFAULT_API_URL, admin_key)
        if args.dry_run:
            print("Dry run. The summary includes proposed changes.")
            setup(client, defaults, args.env_file, dry_run=True)
        else:
            # Serialise setup in this checkout. Flagsmith does not enforce unique key names.
            directory = os.open(Path(__file__).resolve().parent, os.O_RDONLY)
            try:
                fcntl.flock(directory, fcntl.LOCK_EX)
                setup(client, defaults, args.env_file, dry_run=False)
            finally:
                os.close(directory)
    except SetupError as error:
        print(f"Flagsmith setup failed. {error}", file=sys.stderr)
        return 1
    except OSError:
        print(
            "Flagsmith setup failed. Could not read or write the environment file.", file=sys.stderr
        )
        return 1
    except (KeyError, TypeError, ValueError):
        print("Flagsmith setup failed. The Admin API URL or response was invalid.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
