"""Verify the exported panel, CSV validation, slices, and experience bands."""

import csv
from hashlib import sha256
from pathlib import Path

import pytest

from panels import COLUMNS, load_panel, profile_counts, select_panel
from personas import Persona, PersonaModel, load_personas
from simulate import PANELS_DIR, REPO_ROOT, SIMULATOR_DIR


@pytest.fixture
def definitions() -> PersonaModel:
    return load_personas(SIMULATOR_DIR / "personas.yaml")


def test_default_panel_matches_export(definitions: PersonaModel) -> None:
    path = PANELS_DIR / "default.csv"
    # Pin the five-column projection of the export even on a clean checkout without data/.
    expected = "b785710be371389591064e33c2b6c61707a974f7b59c5ec1c7986be38f6ab7bb"
    assert sha256(path.read_text(encoding="utf-8").encode()).hexdigest() == expected

    panel = load_panel("default", definitions, PANELS_DIR)
    assert list(panel) == [
        f"{prefix}-{index:04d}"
        for prefix, count in (("sim-persona", 100), ("sim-persona-b", 200), ("sim-persona-c", 1000))
        for index in range(1, count + 1)
    ]
    export = REPO_ROOT / "data" / "simulated-reviewers.csv"
    if export.exists():
        with export.open(newline="", encoding="utf-8") as file:
            assert list(panel.items()) == [
                (
                    row["identity"],
                    Persona(
                        row["role"],
                        float(row["experience_years"]),
                        row["codebase_familiarity"],
                        row["reading_style"],
                    ),
                )
                for row in csv.DictReader(file)
            ]


@pytest.mark.parametrize(
    ("lines", "error"),
    [
        ("id,role\n", "must have these columns"),
        ("{header}\n", "at least one reviewer"),
        ("{header}\nreviewer,junior_dev,1,some\n", "line 2.*one value per column"),
        ("{header}\n,junior_dev,1,some,visual\n", "line 2.*identity must be nonempty"),
        ("{header}\nreviewer,intern,1,some,visual\n", "line 2.*unknown role 'intern'"),
        (
            "{header}\nreviewer,junior_dev,abc,some,visual\n",
            "line 2.*experience_years must be a number",
        ),
        (
            "{header}\nreviewer,junior_dev,nan,some,visual\n",
            "line 2.*experience_years must be between",
        ),
        ("{header}\nreviewer,junior_dev,4,some,visual\n", "line 2.*between 0 and 3 for junior_dev"),
        ("{header}\nreviewer,junior_dev,1,low,visual\n", "line 2.*unknown codebase_familiarity"),
        ("{header}\nreviewer,junior_dev,1,some,other\n", "line 2.*unknown reading_style"),
        (
            "{header}\nreviewer,junior_dev,1,some,visual\nreviewer,junior_dev,2,some,textual\n",
            "line 3.*duplicate identity 'reviewer'",
        ),
    ],
)
def test_panel_validation(
    tmp_path: Path, definitions: PersonaModel, lines: str, error: str
) -> None:
    (tmp_path / "test.csv").write_text(lines.format(header=",".join(COLUMNS)))
    with pytest.raises(ValueError, match=error):
        load_panel("test", definitions, tmp_path)


def test_panel_slice_preserves_order_and_traits(definitions: PersonaModel) -> None:
    panel = load_panel("default", definitions, PANELS_DIR)
    reviewers = select_panel(panel, offset=99, limit=3)
    assert list(reviewers) == ["sim-persona-0100", "sim-persona-b-0001", "sim-persona-b-0002"]
    assert list(reviewers.values()) == list(panel.values())[99:102]
    assert list(select_panel(panel, offset=1299, limit=None)) == ["sim-persona-c-1000"]
    assert select_panel(panel, offset=1299, limit=5) == select_panel(panel, offset=1299, limit=None)
    with pytest.raises(ValueError, match="offset 1300 leaves no reviewers"):
        select_panel(panel, offset=1300, limit=1)


def test_profiles_count_fractional_experience_by_completed_year(definitions: PersonaModel) -> None:
    panel = load_panel("default", definitions, PANELS_DIR)
    assert profile_counts(panel) == {
        "role": {
            "junior_dev": 356,
            "senior_dev": 363,
            "pr_reviewer": 260,
            "solution_architect": 141,
            "new_joiner": 180,
        },
        "experience_years": {"0–2": 403, "3–7": 253, "8–14": 480, "15+": 164},
        "codebase_familiarity": {"none": 332, "some": 565, "high": 403},
        "reading_style": {"visual": 720, "textual": 580},
    }
