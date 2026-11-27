"""Read API settings and the repo's Flagsmith scope from local configuration."""

import base64
import binascii
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from codeflow.diff import LONG_FLOW_MIN_DEPTH

DEFAULT_FLAGSMITH_API_URL = "http://localhost:8000/api/v1/"
MAX_IMPORT_COMMITS = 200
DEFAULT_SNAPSHOT_CACHE_SIZE = 16
DEFAULT_MAX_PRIVATE_IMPORTS = 3
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")


def _read_dotenv(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return {}

    values = {}
    for line in lines:
        line = line.strip().removeprefix("export ")
        name, separator, value = line.partition("=")
        name = name.strip()
        if not separator or not name or name.startswith("#"):
            continue
        value = value.strip()
        if value and value[0] in "\"'" and value[0] in value[1:]:
            value = value[1:].split(value[0], 1)[0]
        else:
            value = "" if value.startswith("#") else value.partition(" #")[0].strip()
        values[name] = value
    return values


def is_local_origin(origin: str) -> bool:
    """Return whether the web origin points at this machine."""
    return urlparse(origin).hostname in LOCAL_HOSTS


@dataclass(frozen=True)
class GitHubAppSettings:
    """Credentials of the GitHub App used for sign-in and private clones."""

    app_id: str
    slug: str
    client_id: str
    client_secret: str = field(repr=False)
    private_key: str = field(repr=False)


def _read_private_key(values: dict[str, str]) -> str:
    """Read the app's PEM key from a file path, raw PEM text, or base64 of the PEM."""
    path = values.get("GITHUB_APP_PRIVATE_KEY_PATH")
    if path:
        return Path(path).expanduser().read_text(encoding="utf-8")
    value = values.get("GITHUB_APP_PRIVATE_KEY", "").strip()
    if value.startswith("-----BEGIN"):
        return value.replace("\\n", "\n")
    try:
        return base64.b64decode(value, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        raise ValueError(
            "GITHUB_APP_PRIVATE_KEY must be the PEM text or base64 of the PEM file."
        ) from None


def _github_app(values: dict[str, str]) -> GitHubAppSettings | None:
    names = ("GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET")
    has_key = bool(
        values.get("GITHUB_APP_PRIVATE_KEY") or values.get("GITHUB_APP_PRIVATE_KEY_PATH")
    )
    present = [name for name in names if values.get(name)]
    if not present and not has_key:
        return None
    missing = [name for name in names if not values.get(name)]
    if not has_key:
        missing.append("GITHUB_APP_PRIVATE_KEY")
    if missing:
        raise ValueError(f"GitHub sign-in is half configured. Missing: {', '.join(missing)}.")
    return GitHubAppSettings(
        app_id=values["GITHUB_APP_ID"],
        slug=values["GITHUB_APP_SLUG"],
        client_id=values["GITHUB_CLIENT_ID"],
        client_secret=values["GITHUB_CLIENT_SECRET"],
        private_key=_read_private_key(values),
    )


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    web_origin: str
    flagsmith_api_url: str = DEFAULT_FLAGSMITH_API_URL
    flagsmith_server_key: str | None = field(default=None, repr=False)
    scopes_path: Path | None = None
    long_flow_min_depth: int = LONG_FLOW_MIN_DEPTH
    max_import_commits: int = MAX_IMPORT_COMMITS
    snapshot_cache_size: int = DEFAULT_SNAPSHOT_CACHE_SIZE
    # A personal read-only token for private clones on a local machine only.
    github_token: str | None = field(default=None, repr=False)
    github_app: GitHubAppSettings | None = None
    max_private_imports: int = DEFAULT_MAX_PRIVATE_IMPORTS

    def __post_init__(self) -> None:
        if self.github_token and not is_local_origin(self.web_origin):
            raise ValueError(
                "CODEFLOW_GITHUB_TOKEN is for local use only. Unset it when "
                "CODEFLOW_WEB_ORIGIN is not a localhost origin."
            )

    @property
    def secure_cookies(self) -> bool:
        """Mark cookies Secure whenever the site is served over HTTPS."""
        return self.web_origin.startswith("https://")

    @classmethod
    def from_env(cls) -> "Settings":
        repo_root = Path(__file__).resolve().parents[2]
        values = {**_read_dotenv(repo_root / ".env"), **os.environ}

        def config_path(name: str, default: Path) -> Path:
            value = values.get(name)
            if not value:
                return default
            base = Path.cwd() if name in os.environ else repo_root
            return (base / value).resolve()

        data_dir = config_path("CODEFLOW_DATA_DIR", repo_root / "data")
        try:
            min_depth = int(values.get("CODEFLOW_LONG_FLOW_MIN_DEPTH") or LONG_FLOW_MIN_DEPTH)
            if min_depth < 1:
                raise ValueError
        except ValueError:
            raise ValueError("CODEFLOW_LONG_FLOW_MIN_DEPTH must be a positive integer.") from None
        try:
            max_commits = int(values.get("CODEFLOW_MAX_IMPORT_COMMITS") or MAX_IMPORT_COMMITS)
            if not 1 <= max_commits <= MAX_IMPORT_COMMITS:
                raise ValueError
        except ValueError:
            raise ValueError(
                f"CODEFLOW_MAX_IMPORT_COMMITS must be an integer from 1 to {MAX_IMPORT_COMMITS}."
            ) from None
        try:
            cache_size = int(
                values.get("CODEFLOW_SNAPSHOT_CACHE_SIZE") or DEFAULT_SNAPSHOT_CACHE_SIZE
            )
            if cache_size < 1:
                raise ValueError
        except ValueError:
            raise ValueError("CODEFLOW_SNAPSHOT_CACHE_SIZE must be a positive integer.") from None
        try:
            max_private = int(
                values.get("CODEFLOW_MAX_PRIVATE_IMPORTS") or DEFAULT_MAX_PRIVATE_IMPORTS
            )
            if max_private < 0:
                raise ValueError
        except ValueError:
            raise ValueError("CODEFLOW_MAX_PRIVATE_IMPORTS must be zero or more.") from None
        return cls(
            data_dir=data_dir,
            web_origin=values.get("CODEFLOW_WEB_ORIGIN", "http://localhost:5173"),
            flagsmith_api_url=values.get("FLAGSMITH_API_URL") or DEFAULT_FLAGSMITH_API_URL,
            flagsmith_server_key=values.get("CODEFLOW_FLAGSMITH_SERVER_KEY") or None,
            scopes_path=config_path(
                "CODEFLOW_FLAGSMITH_SCOPES_PATH", data_dir / "flagsmith_scopes.json"
            ),
            long_flow_min_depth=min_depth,
            max_import_commits=max_commits,
            snapshot_cache_size=cache_size,
            github_token=values.get("CODEFLOW_GITHUB_TOKEN") or None,
            github_app=_github_app(values),
            max_private_imports=max_private,
        )

    def flag_scope(self, repo: str) -> tuple[str, set[str]]:
        """Return the environment label and the flag names assigned to this repo."""
        path = self.scopes_path or self.data_dir / "flagsmith_scopes.json"
        try:
            scopes = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return "Production", set()
        names = set(scopes["repos"].get(repo, [])) - set(scopes.get("code_flow_flags", []))
        return scopes["environment"], names
