"""Load fixed reviewer populations, generate fresh reviewers, and count profiles."""

import csv
from collections import Counter
from pathlib import Path
from random import Random

from config import named_path
from personas import Persona, PersonaModel

COLUMNS = ("identity", "role", "experience_years", "codebase_familiarity", "reading_style")
EXPERIENCE_BANDS = (("0–2", 3), ("3–7", 8), ("8–14", 15), ("15+", float("inf")))
Panel = dict[str, Persona]


def _parse_persona(row: dict[str, str], definitions: PersonaModel) -> Persona:
    role = row["role"]
    if role not in definitions.roles:
        raise ValueError(f"unknown role {role!r}.")
    low, high = definitions.roles[role].experience_years
    years = row["experience_years"]
    try:
        experience = float(years)
    except ValueError:
        raise ValueError(f"experience_years must be a number, got {years!r}.") from None
    if not low <= experience <= high:
        raise ValueError(
            f"experience_years must be between {low} and {high} for {role}, got {years!r}."
        )
    familiarity = row["codebase_familiarity"]
    if familiarity not in definitions.familiarity:
        raise ValueError(f"unknown codebase_familiarity {familiarity!r}.")
    style = row["reading_style"]
    if style not in definitions.reading_styles:
        raise ValueError(f"unknown reading_style {style!r}.")
    return Persona(role, experience, familiarity, style)


def load_panel(name: str, definitions: PersonaModel, directory: Path) -> Panel:
    path = named_path(directory, name, ".csv")
    panel: Panel = {}
    with path.open(encoding="utf-8", newline="") as file:
        reader = csv.DictReader(file, strict=True)
        try:
            if sorted(reader.fieldnames or []) != sorted(COLUMNS):
                raise ValueError(f"{path.name} must have these columns: {', '.join(COLUMNS)}.")
            for row in reader:
                try:
                    if None in row or None in row.values():
                        raise ValueError("expected one value per column.")
                    identity = row["identity"]
                    if not identity or identity != identity.strip():
                        raise ValueError(
                            "identity must be nonempty without surrounding whitespace."
                        )
                    if identity in panel:
                        raise ValueError(f"duplicate identity {identity!r}.")
                    panel[identity] = _parse_persona(row, definitions)
                except ValueError as exc:
                    raise ValueError(f"{path.name}, line {reader.line_num}: {exc}") from exc
        except csv.Error as exc:
            raise ValueError(f"{path.name}, line {reader.line_num}: invalid CSV: {exc}") from exc
    if not panel:
        raise ValueError(f"{path.name} must contain at least one reviewer.")
    return panel


def generate_panel(definitions: PersonaModel, *, n: int, prefix: str, seed: int) -> Panel:
    identities = (f"{prefix}-{index:04d}" for index in range(1, n + 1))
    return {identity: definitions.sample(Random(f"{seed}:{identity}")) for identity in identities}


def select_panel(panel: Panel, *, offset: int, limit: int | None) -> Panel:
    if offset < 0 or (limit is not None and limit < 1):
        raise ValueError("Panel offset must be nonnegative and limit must be positive.")
    if offset >= len(panel):
        raise ValueError(f"Panel offset {offset} leaves no reviewers in a panel of {len(panel)}.")
    end = None if limit is None else offset + limit
    return dict(list(panel.items())[offset:end])


def profile_counts(panel: Panel) -> dict[str, Counter[str]]:
    return {
        "role": Counter(persona.role for persona in panel.values()),
        "experience_years": Counter(
            next(label for label, upper in EXPERIENCE_BANDS if persona.experience_years < upper)
            for persona in panel.values()
        ),
        "codebase_familiarity": Counter(persona.codebase_familiarity for persona in panel.values()),
        "reading_style": Counter(persona.reading_style for persona in panel.values()),
    }
