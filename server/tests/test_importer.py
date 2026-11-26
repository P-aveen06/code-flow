"""Exercise import validation, progress, and reuse through the HTTP API."""

import json
import os
import subprocess
from collections.abc import Callable
from concurrent.futures import Executor, Future
from pathlib import Path
from time import monotonic, sleep
from unittest.mock import Mock

import pytest
from codeflow import analyze
from fastapi.testclient import TestClient

from app import importer
from app.config import Settings
from app.main import create_app

URL = "https://github.com/Demo/shop"
REPOS = "/api/repos"
REPO_ID = "Demo__shop"
REPO = f"{REPOS}/{REPO_ID}"
ORIGIN = "http://example.test"


class InlineExecutor(Executor):
    """Run each queued import on the calling thread for deterministic tests."""

    before_run: Callable[[], None] | None = None

    def submit(self, fn, /, *args, **kwargs):
        if self.before_run is not None:
            self.before_run()
        future = Future()
        future.set_result(fn(*args, **kwargs))
        return future


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(
        [
            "git",
            "-C",
            str(repo),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            *args,
        ],
        env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull},
        text=True,
    ).strip()


def commit(repo: Path, path: str, contents: str, message: str) -> str:
    file = repo / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(contents, encoding="utf-8")
    git(repo, "add", "--", path)
    git(repo, "commit", "-qm", message)
    return git(repo, "rev-parse", "HEAD")


@pytest.fixture
def local_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "remote"
    repo.mkdir()
    git(repo, "init", "--quiet", "--initial-branch=main", "--template=")
    commit(repo, "shop/cart.py", "def cart(): pass\n", "Add cart")
    commit(repo, "docs/readme.md", "Initial docs\n", "Add docs")
    commit(repo, "shop/price.py", "def price(): return 2\n", "Add price")
    commit(repo, "docs/readme.md", "Updated docs\n", "Update docs")
    commit(repo, "shop/price.py", "def price(): return 3\n", "Update price")
    commit(repo, "docs/readme.md", "Latest docs\n", "Polish docs")
    return repo


@pytest.mark.parametrize("suffix", ["", ".git", "/", ".git/"])
def test_validate_public_github_url(suffix: str):
    source = importer.validate_import({"url": URL + suffix})
    assert (source.url, source.id, source.name, source.subdir, source.max_commits) == (
        URL,
        REPO_ID,
        "Demo/shop",
        "",
        30,
    )


@pytest.mark.parametrize(
    "url",
    [
        None,
        "",
        "http://github.com/o/r",
        "https://gitlab.com/o/r",
        "https://github.com.evil/o/r",
        "https://github.com/o/..",
        "https://github.com/../r",
        "https://github.com/o/a..b",
        "https://github.com/./r",
        "https://github.com/o/.git",
        "https://github.com/o/r?token=secret",
        "https://github.com/o/r#main",
        "https://x:secret@github.com/o/r",
        "git@github.com:o/r.git",
        "https://github.com:443/o/r",
        "https://github.com/o/r/issues",
        "https://github.com/o/%2e%2e",
        "https://github.com/o/r\n",
    ],
)
def test_reject_invalid_urls(url):
    with pytest.raises(importer.BadRequest, match="GitHub"):
        importer.validate_import({"url": url})


@pytest.mark.parametrize(
    "subdir", ["..", "../shop", "shop/../docs", "/shop", "C:/shop", "shop\\api", "x\0", None]
)
def test_reject_invalid_subdirs(subdir):
    with pytest.raises(importer.BadRequest, match="Subfolder"):
        importer.validate_import({"url": URL, "subdir": subdir})


@pytest.mark.parametrize("limit", [0, -1, 201, 1.5, "30", True, None])
def test_reject_invalid_commit_limits(limit):
    with pytest.raises(importer.BadRequest, match="1 to 200"):
        importer.validate_import({"url": URL, "max_commits": limit})


@pytest.mark.parametrize("limit", [1, 200])
def test_accept_commit_limit_boundaries(limit):
    source = importer.validate_import({"url": URL, "subdir": "./one//two/", "max_commits": limit})
    assert (source.max_commits, source.subdir) == (limit, "one/two")


def test_import_validation_and_cors(tmp_path: Path):
    with TestClient(create_app(Settings(tmp_path, ORIGIN))) as client:
        for payload in ({}, {"url": URL, "subdir": ".."}, {"url": URL, "max_commits": 201}, []):
            response = client.post(REPOS, json=payload)
            assert response.status_code == 400
            assert isinstance(response.json()["detail"], str)
        invalid_json = client.post(REPOS, content="{", headers={"Content-Type": "application/json"})
        assert invalid_json.status_code == 400
        assert client.get(REPOS).json() == []

        response = client.options(
            REPOS,
            headers={
                "Origin": ORIGIN,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )
        assert response.status_code == 200
        assert response.headers["Access-Control-Allow-Origin"] == ORIGIN
        assert "POST" in response.headers["Access-Control-Allow-Methods"]
        assert "Content-Type" in response.headers["Access-Control-Allow-Headers"]


def test_full_import_and_reimport(tmp_path: Path, local_repo: Path, monkeypatch):
    settings = Settings(tmp_path / "data", ORIGIN)
    executor = InlineExecutor()
    app = create_app(settings, git_url_builder=lambda _: local_repo.as_uri(), executor=executor)
    statuses = []
    git_command = importer._git
    analyze_repo = importer.analyze_repo
    parse = Mock(wraps=analyze.parse_file)
    monkeypatch.setattr(analyze, "parse_file", parse)

    with TestClient(app) as client:
        request = {"url": URL + ".git", "subdir": "shop/", "max_commits": 2}

        def before_run():
            statuses.append(client.get(f"{REPO}/status").json()["status"])
            assert client.get(REPOS).json() == [
                {
                    "id": REPO_ID,
                    "name": "Demo/shop",
                    "url": URL,
                    "subdir": "shop",
                    "branch": "",
                    "commit_count": 0,
                    "status": "queued",
                    "message": "Queued",
                    "warning": None,
                }
            ]
            executor.before_run = None
            duplicate = client.post(REPOS, json=request)
            assert duplicate.status_code == 202
            assert duplicate.json() == {"id": REPO_ID, "status": "queued"}
            refresh = client.post(f"{REPO}/refresh")
            assert refresh.status_code == 202
            assert refresh.json() == duplicate.json()

        def observe_git(*args, **kwargs):
            if args[0] == "clone":
                statuses.append(client.get(f"{REPO}/status").json()["status"])
            return git_command(*args, **kwargs)

        def observe_analysis(*args, **kwargs):
            on_progress = kwargs["on_progress"]

            def observe_progress(current, total, entry):
                on_progress(current, total, entry)
                status = client.get(f"{REPO}/status").json()
                statuses.append(status["status"])
                assert (status["current"], status["total"]) == (current, total)
                assert status["message"] == f"Analyzing commit {current} of {total}"

            return analyze_repo(*args, **{**kwargs, "on_progress": observe_progress})

        executor.before_run = before_run
        monkeypatch.setattr(importer, "_git", observe_git)
        monkeypatch.setattr(importer, "analyze_repo", observe_analysis)
        response = client.post(REPOS, json=request)
        assert response.status_code == 202
        assert response.json() == {"id": REPO_ID, "status": "queued"}
        status = client.get(f"{REPO}/status").json()
        assert statuses + [status["status"]] == [
            "queued",
            "cloning",
            "analyzing",
            "analyzing",
            "ready",
        ]
        assert (status["current"], status["total"], status["warning"], status["error"]) == (
            2,
            2,
            None,
            None,
        )
        assert status["seconds"] >= 0
        listing = client.get(REPOS).json()
        assert listing == [
            {
                "id": REPO_ID,
                "name": "Demo/shop",
                "url": URL,
                "subdir": "shop",
                "branch": "main",
                "commit_count": 2,
                "status": "ready",
                "message": "Ready",
                "warning": None,
            }
        ]

        output = settings.data_dir / REPO_ID
        clone = settings.data_dir / "repos" / REPO_ID
        assert (clone / ".git").is_dir()
        assert not (clone / "shop").exists()
        source = json.loads((output / "source.json").read_text())
        assert source.pop("imported_at")
        assert source == {"url": URL, "name": "Demo/shop", "subdir": "shop", "max_commits": 2}
        index = analyze.load_index(output)
        oldest, newest = index["commits"]
        assert (oldest["message"], newest["message"]) == ("Add price", "Update price")
        assert oldest["base"] == oldest["parents"][0] == git(local_repo, "rev-parse", "HEAD~4")
        assert newest["base"] == oldest["sha"] != newest["parents"][0]
        commits = client.get(f"{REPO}/commits").json()["commits"]
        for entry in commits:
            diff = client.get(f"{REPO}/diff", params={"head": entry["sha"]})
            assert diff.status_code == 200
            assert diff.json()["base"] == entry["base"]
            assert diff.json()["diff"]["stats"] == entry["stats"]
        assert [entry["stats"]["nodes_added"] for entry in commits] == [1, 0]
        assert [entry["stats"]["nodes_changed"] for entry in commits] == [0, 1]

        saved = output / "snapshots" / f"{newest['sha']}.json"
        inode = saved.stat().st_ino
        parse.reset_mock()
        assert client.post(REPOS, json=request).status_code == 202
        assert client.get(f"{REPO}/status").json()["status"] == "ready"
        assert saved.stat().st_ino == inode
        parse.assert_not_called()

        git(local_repo, "branch", "-m", "trunk")
        fresh_sha = commit(local_repo, "shop/price.py", "def price(): return 4\n", "Reset price")
        assert client.post(REPOS, json=request).status_code == 202
        assert client.get(f"{REPO}/status").json()["status"] == "ready"
        assert client.get(REPOS).json()[0]["branch"] == "trunk"
        assert analyze.load_index(output)["commits"][-1]["sha"] == fresh_sha
        assert [call.args[0] for call in parse.call_args_list] == ["shop/price.py"]

    with TestClient(create_app(settings)) as restarted:
        assert restarted.get(REPOS).json() == [{**listing[0], "branch": "trunk"}]
        status = restarted.get(f"{REPO}/status").json()
        assert status["status"] == "ready"
        assert status["new_commits"] is None


@pytest.fixture
def github_import(tmp_path: Path, local_repo: Path):
    settings = Settings(tmp_path / "data", ORIGIN)
    executor = InlineExecutor()
    app = create_app(settings, git_url_builder=lambda _: local_repo.as_uri(), executor=executor)
    with TestClient(app) as client:
        assert (
            client.post(REPOS, json={"url": URL, "subdir": "shop", "max_commits": 2}).status_code
            == 202
        )
        status = client.get(f"{REPO}/status").json()
        assert status["status"] == "ready"
        assert status["new_commits"] is None
        yield client, settings.data_dir / REPO_ID, executor


def test_refresh_keeps_indexed_commits_and_grows_limit(
    github_import, local_repo: Path, monkeypatch
):
    client, output, _ = github_import
    old_commits = client.get(f"{REPO}/commits").json()["commits"]
    first = commit(local_repo, "shop/price.py", "def price(): return 4\n", "Raise price")
    commit(local_repo, "docs/readme.md", "More docs\n", "Document prices")
    second = commit(local_repo, "shop/cart.py", "def cart(): return []\n", "Return cart")
    parse = Mock(wraps=analyze.parse_file)
    monkeypatch.setattr(analyze, "parse_file", parse)

    response = client.post(f"{REPO}/refresh")
    assert response.status_code == 202
    assert response.json() == {"id": REPO_ID, "status": "queued"}
    status = client.get(f"{REPO}/status").json()
    assert status["status"] == "ready"
    assert status["new_commits"] == 2
    refreshed = client.get(f"{REPO}/commits").json()["commits"]
    assert refreshed[:2] == old_commits
    assert [entry["sha"] for entry in refreshed[2:]] == [first, second]
    assert json.loads((output / "source.json").read_text())["max_commits"] == 4
    assert [call.args[0] for call in parse.call_args_list] == ["shop/price.py", "shop/cart.py"]

    third = commit(local_repo, "shop/price.py", "def price(): return 5\n", "Raise price again")
    assert client.post(f"{REPO}/refresh").status_code == 202
    assert client.get(f"{REPO}/status").json()["new_commits"] == 1
    assert [entry["sha"] for entry in analyze.load_index(output)["commits"]] == [
        *[entry["sha"] for entry in refreshed],
        third,
    ]
    assert json.loads((output / "source.json").read_text())["max_commits"] == 5


def test_refresh_up_to_date_reuses_snapshots(github_import, local_repo: Path, monkeypatch):
    client, output, _ = github_import
    previous = client.get(f"{REPO}/commits").json()
    snapshots = {file.name: file.stat().st_ino for file in (output / "snapshots").iterdir()}
    build_graph = Mock(wraps=analyze.build_graph)
    monkeypatch.setattr(analyze, "build_graph", build_graph)
    commit(local_repo, "docs/readme.md", "More docs\n", "Document prices")

    assert client.post(f"{REPO}/refresh").status_code == 202
    status = client.get(f"{REPO}/status").json()
    assert status["status"] == "ready"
    assert status["new_commits"] == 0
    assert client.get(f"{REPO}/commits").json() == previous
    assert {file.name: file.stat().st_ino for file in (output / "snapshots").iterdir()} == snapshots
    assert json.loads((output / "source.json").read_text())["max_commits"] == 2
    build_graph.assert_not_called()


def test_refresh_uses_stored_limit_after_rewrite(github_import, local_repo: Path):
    client, output, _ = github_import
    retained = git(local_repo, "rev-parse", "HEAD~3")
    git(local_repo, "switch", "-c", "rewrite", retained)
    replacement = commit(local_repo, "shop/price.py", "def price(): return 5\n", "Replace price")
    git(local_repo, "branch", "-M", "main")

    assert client.post(f"{REPO}/refresh").status_code == 202
    status = client.get(f"{REPO}/status").json()
    assert status["status"] == "ready"
    assert status["new_commits"] == 1
    assert [entry["sha"] for entry in analyze.load_index(output)["commits"]] == [
        retained,
        replacement,
    ]
    assert json.loads((output / "source.json").read_text())["max_commits"] == 2


def test_refresh_reuses_running_job(github_import, monkeypatch):
    client, _, executor = github_import
    submit = Mock(wraps=executor.submit)
    monkeypatch.setattr(executor, "submit", submit)
    git_command = importer._git

    def observe_fetch(*args, **kwargs):
        if args[0] == "ls-remote":
            active = client.get(f"{REPO}/status").json()
            assert active["status"] == "cloning"
            assert active["new_commits"] is None
            duplicate = client.post(f"{REPO}/refresh")
            assert duplicate.status_code == 202
            assert duplicate.json() == {"id": REPO_ID, "status": "cloning"}
        return git_command(*args, **kwargs)

    monkeypatch.setattr(importer, "_git", observe_fetch)
    assert client.post(f"{REPO}/refresh").status_code == 202
    assert client.get(f"{REPO}/status").json()["status"] == "ready"
    submit.assert_called_once()


@pytest.mark.parametrize("source", [None, {"url": None}, {"url": "https://example.test/shop"}])
def test_refresh_rejects_non_github_and_unknown_repos(tmp_path: Path, local_repo: Path, source):
    output = tmp_path / "shop-demo"
    analyze.analyze_repo(local_repo, output, max_commits=1)
    if source is not None:
        (output / "source.json").write_text(json.dumps(source))
    with TestClient(create_app(Settings(tmp_path, ORIGIN))) as client:
        response = client.post(f"{REPOS}/shop-demo/refresh")
        assert response.status_code == 409
        assert "imported from GitHub" in response.json()["detail"]
        assert client.post(f"{REPOS}/missing/refresh").status_code == 404


def test_failed_refresh_preserves_published_output(github_import, monkeypatch):
    client, output, _ = github_import
    previous = client.get(f"{REPO}/commits").json()
    source = (output / "source.json").read_bytes()
    head = previous["commits"][-1]["sha"]
    snapshot_url = f"{REPO}/snapshots/{head}"
    snapshot = client.get(snapshot_url).json()
    git_command = importer._git

    def fail_fetch(*args, **kwargs):
        if "fetch" in args:
            assert client.get(f"{REPO}/commits").json() == previous
            raise importer.ImportFailure(importer.UNAVAILABLE)
        return git_command(*args, **kwargs)

    monkeypatch.setattr(importer, "_git", fail_fetch)
    assert client.post(f"{REPO}/refresh").status_code == 202
    status = client.get(f"{REPO}/status").json()
    assert status["status"] == "error"
    assert status["error"] == "Repository not found or not public"
    assert status["new_commits"] is None
    assert client.get(f"{REPO}/commits").json() == previous
    assert client.get(snapshot_url).json() == snapshot
    assert (output / "source.json").read_bytes() == source


def test_missing_subdir_and_no_python_warning(tmp_path: Path, local_repo: Path):
    settings = Settings(tmp_path / "data", ORIGIN)
    app = create_app(
        settings, git_url_builder=lambda _: local_repo.as_uri(), executor=InlineExecutor()
    )
    with TestClient(app) as client:
        missing = {"url": URL, "subdir": "missing"}
        assert client.post(REPOS, json=missing).status_code == 202
        status = client.get(f"{REPO}/status").json()
        assert status["status"] == "error"
        assert status["error"] == "Subfolder missing/ does not exist in this repository"
        assert client.get(REPOS).json()[0]["commit_count"] == 0

        assert client.post(REPOS, json={"url": URL}).status_code == 202
        head = git(local_repo, "rev-parse", "HEAD")
        snapshot = f"{REPO}/snapshots/{head}"
        assert client.get(snapshot).json()["nodes"]
        assert client.post(REPOS, json={"url": URL, "subdir": "docs/"}).status_code == 202
        status = client.get(f"{REPO}/status").json()
        warning = "No Python files found in docs/. code-flow analyzes Python only for now."
        assert status["status"] == "ready"
        assert status["warning"] == warning
        assert client.get(REPOS).json()[0]["warning"] == warning
        assert client.get(snapshot).json()["nodes"] == []

    with TestClient(create_app(settings)) as restarted:
        assert restarted.get(f"{REPO}/status").json()["warning"] == warning


def test_unavailable_repo_reports_readable_failure(tmp_path: Path):
    settings = Settings(tmp_path / "data", ORIGIN)
    missing = (tmp_path / "remote").as_uri()
    app = create_app(settings, git_url_builder=lambda _: missing, executor=InlineExecutor())
    with TestClient(app) as client:
        assert client.post(REPOS, json={"url": URL}).status_code == 202
        status = client.get(f"{REPO}/status").json()
        assert status["status"] == "error"
        assert status["error"] == "Repository not found or not public"


@pytest.mark.network
@pytest.mark.skipif(os.getenv("CODEFLOW_RUN_NETWORK_TESTS") != "1", reason="opt-in GitHub test")
def test_import_public_repo(tmp_path: Path):
    with TestClient(create_app(Settings(tmp_path, ORIGIN))) as client:
        response = client.post(
            REPOS, json={"url": "https://github.com/octocat/Hello-World", "max_commits": 1}
        )
        assert response.status_code == 202
        status_url = f"{REPOS}/{response.json()['id']}/status"
        deadline = monotonic() + 120
        while monotonic() < deadline:
            status = client.get(status_url).json()
            if status["status"] in ("ready", "error"):
                break
            sleep(0.1)
        assert status["status"] == "ready", status
        assert client.get(REPOS).json()[0]["commit_count"] == 1
