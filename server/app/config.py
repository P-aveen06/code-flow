"""Read API settings and the repo's Flagsmith scope from local configuration."""

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from codeflow.diff import LONG_FLOW_MIN_DEPTH

DEFAULT_FLAGSMITH_API_URL = "http://localhost:8000/api/v1/"


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


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    web_origin: str
    flagsmith_api_url: str = DEFAULT_FLAGSMITH_API_URL
    flagsmith_server_key: str | None = field(default=None, repr=False)
    scopes_path: Path | None = None
    long_flow_min_depth: int = LONG_FLOW_MIN_DEPTH

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
        return cls(
            data_dir=data_dir,
            web_origin=values.get("CODEFLOW_WEB_ORIGIN", "http://localhost:5173"),
            flagsmith_api_url=values.get("FLAGSMITH_API_URL") or DEFAULT_FLAGSMITH_API_URL,
            flagsmith_server_key=values.get("CODEFLOW_FLAGSMITH_SERVER_KEY") or None,
            scopes_path=config_path(
                "CODEFLOW_FLAGSMITH_SCOPES_PATH", data_dir / "flagsmith_scopes.json"
            ),
            long_flow_min_depth=min_depth,
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
