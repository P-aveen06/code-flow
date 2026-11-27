"""Build a disposable repository with guarded calls and source edits for API tests."""

import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest
from codeflow.analyze import analyze_repo, load_commits
from codeflow.graph import Commit

REPO_ID = "review-fixture"
FLAG_COMMIT = "Route requests through the fast path"

PRICING = """\
def quote():
    if client.has_feature("special_rate"):
        return discount()
    return 10


def discount():
    return 5
"""

HANDLERS = """\
from .receipts import store_receipt


def standard_submit():
    result = store_receipt()
    return result


def fast_submit():
    result = store_receipt()
    return result
"""


@pytest.fixture(scope="module")
def fixture_data(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp(REPO_ID)
    repo = root / REPO_ID
    repo.mkdir()

    def git(*args: str, date: str = "") -> None:
        env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
        if date:
            env.update(GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
        subprocess.run(
            [
                "git",
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
                *args,
            ],
            cwd=repo,
            env=env,
            check=True,
            capture_output=True,
        )

    changes = [
        (
            "Add request and pricing functions",
            {
                "billing/api.py": "from .pricing import quote\n\n\ndef submit():\n    return quote()\n",
                "billing/pricing.py": "def quote():\n    return 10\n\n\ndef retired():\n    return 0\n",
            },
        ),
        (
            "Add a guarded rate and receipt storage",
            {
                "billing/pricing.py": PRICING + "\n\ndef retired():\n    return 0\n",
                "billing/receipts.py": 'def store_receipt():\n    return "saved"\n',
            },
        ),
        (
            "Add a request dispatcher",
            {
                "billing/dispatch.py": "from .api import submit\n\n\ndef dispatch():\n    return submit()\n"
            },
        ),
        (
            FLAG_COMMIT,
            {
                "billing/api.py": """\
from .handlers import fast_submit, standard_submit


def submit():
    if client.is_feature_enabled("fast_path"):
        return fast_submit()
    else:
        return standard_submit()
""",
                "billing/handlers.py": HANDLERS,
            },
        ),
        (
            "Validate fast submissions",
            {
                "billing/handlers.py": HANDLERS.replace(
                    "def fast_submit():\n",
                    "\n\ndef fast_submit():\n    if not ready():\n        return None\n",
                ),
            },
        ),
        ("Remove the retired function", {"billing/pricing.py": "\n" + PRICING}),
    ]

    git("init", "--quiet", "--initial-branch=main", "--template=")
    for hour, (message, files) in enumerate(changes, start=9):
        for name, contents in files.items():
            path = repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents, encoding="utf-8")
        git("add", "--all")
        git(
            "commit",
            "--quiet",
            "-m",
            message,
            date=datetime(2026, 11, 20, hour, tzinfo=UTC).isoformat(),
        )

    data_dir = root / "data"
    analyze_repo(repo, data_dir / REPO_ID, branch="main")
    return data_dir


@pytest.fixture
def fast_path_commit(fixture_data: Path) -> Commit:
    return next(
        commit for commit in load_commits(fixture_data / REPO_ID) if commit.message == FLAG_COMMIT
    )
