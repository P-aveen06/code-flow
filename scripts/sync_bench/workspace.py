"""Prepare private Git upstreams and copy published importer output."""

import json
import os
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SIZES = ("small", "medium", "large")
UPSTREAM_URL = "https://github.com/Flagsmith/flagsmith.git"
FORBIDDEN_PORTS = {5173, 8787}


def validate_workdir(path: Path, *, repo: Path = ROOT) -> Path:
    path = path.expanduser().resolve()
    if (
        path.is_relative_to(repo / "data")
        or path.is_relative_to((repo / "data").resolve())
        or repo.is_relative_to(path)
        or any(
            path.is_relative_to(repo / part)
            for part in (".git", "server", "web", "analyzer")
        )
    ):
        raise ValueError(
            "Choose a dedicated benchmark workdir outside the app's data and code."
        )
    if path.exists() and not path.is_dir():
        raise ValueError("The benchmark workdir must be a directory.")
    return path


def safe_port(port: int) -> int:
    if port in FORBIDDEN_PORTS or not 0 <= port <= 65535:
        raise ValueError("Use an ephemeral port. Ports 5173 and 8787 are reserved.")
    return port


def git_env() -> dict[str, str]:
    env = {
        name: value for name, value in os.environ.items() if not name.startswith("GIT_")
    }
    return {
        **env,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
    }


def git(
    *args: str, repo: Path | None = None, extra_env: dict[str, str] | None = None
) -> str:
    command = ["git", *(("-C", str(repo)) if repo else ()), *args]
    result = subprocess.run(
        command,
        check=False,
        env={**git_env(), **(extra_env or {})},
        capture_output=True,
        text=True,
        timeout=600,
    )
    if result.returncode:
        raise RuntimeError(
            f"Benchmark Git command failed: {args[0]}. {result.stderr.strip()}"
        )
    return result.stdout.strip()


@dataclass(frozen=True)
class History:
    source: Path
    name: str
    subdir: str
    limit: int
    start: str
    advances: tuple[str, ...]


def _api_history(cache: Path, needed: int) -> list[str]:
    return git(
        "rev-list",
        "--first-parent",
        f"--max-count={needed}",
        "HEAD",
        "--",
        "api",
        repo=cache,
    ).splitlines()


def flagsmith_cache(workdir: Path, advances: int, *, offline: bool) -> Path:
    # Include an extra commit for the large template's oldest diff base.
    needed = 201 + advances
    path = workdir / "cache" / "flagsmith.git"
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("The Flagsmith cache must be inside the benchmark workdir.")
    path.parent.mkdir(exist_ok=True)
    if not path.exists():
        if offline:
            raise ValueError("Flagsmith cache is missing. Run once without --offline.")
        git(
            "clone", "--bare", "--single-branch", "--depth=800", UPSTREAM_URL, str(path)
        )
    while len(_api_history(path, needed)) < needed:
        if git("rev-parse", "--is-shallow-repository", repo=path) == "false" or offline:
            raise ValueError(
                f"Flagsmith cache needs {needed} first-parent commits touching api/."
            )
        tip = git("rev-parse", "HEAD", repo=path)
        # Deepen the pinned commit so repeat runs keep the same source history.
        git("fetch", "--deepen=800", UPSTREAM_URL, tip, repo=path)
    return path


def build_history(
    size: str, directory: Path, advances: int, cache: Path | None
) -> History:
    if size == "small":
        source = directory / "shop-demo"
        subprocess.run(
            ["bash", str(ROOT / "examples/make_shop_demo.sh"), str(source)],
            env=git_env(),
            stdout=subprocess.DEVNULL,
            check=True,
        )
        start = git("rev-parse", "HEAD", repo=source)
        limit = int(git("rev-list", "--count", "HEAD", repo=source))
        commits = []
        identity = {
            "GIT_AUTHOR_NAME": "code-flow benchmark",
            "GIT_AUTHOR_EMAIL": "benchmark@example.invalid",
            "GIT_COMMITTER_NAME": "code-flow benchmark",
            "GIT_COMMITTER_EMAIL": "benchmark@example.invalid",
        }
        for number in range(1, advances + 1):
            (source / "shop" / "benchmark.py").write_text(
                f'"""Exercise incremental analysis."""\n\n\ndef score():\n    return {number}\n'
                "\n\ndef review():\n    return score()\n",
                encoding="utf-8",
            )
            git("add", "shop/benchmark.py", repo=source)
            date = f"{1795737600 + number * 60} +0000"
            git(
                "commit",
                "-m",
                f"Adjust benchmark score {number}",
                repo=source,
                extra_env={
                    **identity,
                    "GIT_AUTHOR_DATE": date,
                    "GIT_COMMITTER_DATE": date,
                },
            )
            commits.append(git("rev-parse", "HEAD", repo=source))
        return History(source / ".git", "shop-demo", "", limit, start, tuple(commits))
    if cache is None:
        raise ValueError("Flagsmith cache is required for medium and large histories.")
    commits = _api_history(cache, advances + 1)
    return History(
        cache,
        "flagsmith",
        "api",
        50 if size == "medium" else 200,
        commits[-1],
        tuple(reversed(commits[:-1])),
    )


def advance_upstream(path: Path, sha: str, previous: str | None = None) -> None:
    """Move the advertised main ref, checking the prior SHA during a run."""
    git(
        "update-ref",
        "refs/heads/main",
        sha,
        *([previous] if previous else []),
        repo=path,
    )


def make_upstreams(directory: Path, history: History, count: int) -> dict[str, Path]:
    directory.mkdir()
    upstreams = {}
    for number in range(1, count + 1):
        repo_id = f"bench{number}__{history.name}"
        path = directory / f"{repo_id}.git"
        git("init", "--bare", "--initial-branch=main", "--template=", str(path))
        (path / "objects" / "info" / "alternates").write_text(
            str(history.source / "objects") + "\n", encoding="utf-8"
        )
        shallow = history.source / "shallow"
        if shallow.exists():
            shutil.copyfile(shallow, path / "shallow")
        advance_upstream(path, history.start)
        upstreams[repo_id] = path
    return upstreams


def fake_url(repo_id: str) -> str:
    return "https://github.com/" + repo_id.replace("__", "/", 1)


def _copy_directory(
    source: Path,
    destination: Path,
    fallback: Callable[[str, str], object] = shutil.copy2,
) -> None:
    # A directory clone on APFS is copy-on-write. Other filesystems use copytree.
    if os.uname().sysname == "Darwin":
        result = subprocess.run(
            ["cp", "-cR", str(source), str(destination)],
            check=False,
            capture_output=True,
        )
        if result.returncode == 0:
            return
        if destination.exists():
            shutil.rmtree(destination)
    shutil.copytree(source, destination, copy_function=fallback)


def _link_snapshot(source: str, destination: str) -> None:
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def copy_template(template: Path, data: Path, upstreams: dict[str, Path]) -> None:
    data.mkdir()
    (data / "repos").mkdir()
    original_id = next(iter(upstreams))
    for repo_id, upstream in upstreams.items():
        clone = data / "repos" / repo_id
        output = data / repo_id
        _copy_directory(template / "repos" / original_id, clone)
        output.mkdir()
        _copy_directory(
            template / original_id / "snapshots", output / "snapshots", _link_snapshot
        )
        for filename, changes in (
            ("commits.json", {"repo_path": str(clone), "repo": repo_id}),
            (
                "source.json",
                {"url": fake_url(repo_id), "name": repo_id.replace("__", "/", 1)},
            ),
        ):
            metadata = json.loads(
                (template / original_id / filename).read_text(encoding="utf-8")
            )
            (output / filename).write_text(
                json.dumps({**metadata, **changes}), encoding="utf-8"
            )
        git("remote", "set-url", "origin", upstream.as_uri(), repo=clone)


def disk_bytes(directory: Path) -> int:
    """Report logical file bytes, counting a hardlink once within the data directory."""
    size = 0
    inodes = set()
    for path in directory.rglob("*"):
        stat = path.stat()
        if (
            not path.is_symlink()
            and path.is_file()
            and (stat.st_dev, stat.st_ino) not in inodes
        ):
            size += stat.st_size
            inodes.add((stat.st_dev, stat.st_ino))
    return size


def snapshot_names(data: Path, repos: list[str]) -> set[tuple[str, str]]:
    return {
        (repo, path.stem)
        for repo in repos
        for path in (data / repo / "snapshots").glob("*.json")
    }
