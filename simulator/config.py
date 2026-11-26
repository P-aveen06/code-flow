"""Read and validate common simulator configuration fields."""

import math
import re
from pathlib import Path

import yaml


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
