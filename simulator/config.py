"""Read and validate common simulator configuration fields."""

import math
import os
import re
from pathlib import Path

import yaml

PRODUCTION_ENVIRONMENT = "Production"
DEFAULT_SIM_ENVIRONMENT = "Development"
PRODUCTION_KEY = "CODEFLOW_FLAGSMITH_ENV_KEY"
SIMULATION_KEY = "CODEFLOW_SIM_FLAGSMITH_ENV_KEY"
QUOTED_ENV_VALUE = re.compile(r"""(?:'[^']*'|"(?:\\.|[^"\\])*")""")


def read_settings(path: Path, *names: str) -> dict[str, str]:
    """Read only the requested settings, with the shell overriding the file."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        lines = []

    values = {}
    for line in lines:
        name, separator, value = line.strip().removeprefix("export ").partition("=")
        name = name.strip()
        if not separator or name not in names:
            continue
        value = value.strip()
        if quoted := QUOTED_ENV_VALUE.match(value):
            value = quoted[0][1:-1]
            if quoted[0].startswith('"'):
                value = re.sub(r'\\([\\$`"])', r"\1", value)
        else:
            value = "" if value.startswith("#") else value.partition(" #")[0].strip()
        values[name] = value
    values.update({name: os.environ[name] for name in names if name in os.environ})
    return values


def named_path(directory: Path, name: str, suffix: str) -> Path:
    if not re.fullmatch(r"[\w-]+", name):
        raise ValueError(f"Invalid {directory.name} name {name!r}. Use letters, numbers, _ or -.")
    return directory / f"{name}{suffix}"


def read_yaml(path: Path) -> object:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise ValueError(f"Invalid YAML in {path.name}: {exc}") from exc


def section(
    value: object, name: str, *required: str, optional: tuple[str, ...] = ()
) -> dict[str, object]:
    keys = set(required)
    if not isinstance(value, dict) or not keys <= value.keys() <= keys.union(optional):
        if not required:
            raise ValueError(
                f"{name} must be a mapping using only these fields: {', '.join(optional)}."
            )
        allowed = f" Optional fields: {', '.join(optional)}." if optional else ""
        raise ValueError(f"{name} must contain these fields: {', '.join(required)}.{allowed}")
    return value


def number(fields: dict[str, object], key: str, name: str) -> float:
    value = fields[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name}.{key} must be a finite number.")
    return float(value)


def name_value(value: object, name: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"{name} must be a nonempty string without surrounding whitespace.")
    return value
