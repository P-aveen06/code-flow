"""Build disposable Git repositories with repeatable commit metadata."""

import os
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from codeflow.analyze import analyze_repo, load_snapshot
from codeflow.graph import Graph

Changes = dict[str, str | bytes | None]


@dataclass
class FixtureRepo:
    path: Path
    commit_count: int = 0

    def git(self, *args: str) -> str:
        start = datetime(2026, 11, 20, 9, tzinfo=timezone(timedelta(hours=5, minutes=30)))
        date = (start + timedelta(hours=self.commit_count)).isoformat()
        env = {
            **os.environ,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_AUTHOR_NAME": "Fixture Author",
            "GIT_AUTHOR_EMAIL": "author@example.com",
            "GIT_AUTHOR_DATE": date,
            "GIT_COMMITTER_NAME": "Fixture Committer",
            "GIT_COMMITTER_EMAIL": "committer@example.com",
            "GIT_COMMITTER_DATE": date,
        }
        result = subprocess.run(
            ["git", "-c", "commit.gpgsign=false", *args],
            cwd=self.path,
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()

    def commit(self, changes: Changes, message: str | None = None) -> str:
        for name, content in changes.items():
            path = self.path / name
            if content is None:
                path.unlink()
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content.encode() if isinstance(content, str) else content)
        self.git("add", "--all")
        self.git("commit", "--quiet", "-m", message or f"Commit {self.commit_count + 1}")
        self.commit_count += 1
        return self.git("rev-parse", "HEAD")


@pytest.fixture
def git_available() -> None:
    if shutil.which("git") is None:
        pytest.skip("git is required")


@pytest.fixture
def make_repo(git_available: None, tmp_path: Path) -> Callable[[list[Changes]], FixtureRepo]:
    def make(commits: list[Changes]) -> FixtureRepo:
        path = tmp_path / "repo"
        path.mkdir()
        repo = FixtureRepo(path)
        repo.git("init", "--quiet", "--initial-branch=main", "--object-format=sha1", "--template=")
        for changes in commits:
            repo.commit(changes)
        return repo

    return make


@pytest.fixture
def make_shop_demo(git_available: None, tmp_path: Path) -> Callable[[], tuple[Path, str]]:
    def generate() -> tuple[Path, str]:
        script = Path(__file__).resolve().parents[2] / "examples" / "make_shop_demo.sh"
        repo = tmp_path / "shop demo"
        result = subprocess.run(
            ["bash", str(script), repo.name],
            cwd=tmp_path,
            check=True,
            capture_output=True,
            text=True,
        )
        return repo, result.stdout

    return generate


@pytest.fixture
def compare_sources(
    make_repo: Callable[[list[Changes]], FixtureRepo], tmp_path: Path
) -> Callable[[Changes, Changes], tuple[Graph, Graph]]:
    def compare(base: Changes, head: Changes) -> tuple[Graph, Graph]:
        repo = make_repo([base, head])
        out = tmp_path / "output"
        first, second = analyze_repo(repo.path, out)
        return load_snapshot(out, first.commit.sha), load_snapshot(out, second.commit.sha)

    return compare
