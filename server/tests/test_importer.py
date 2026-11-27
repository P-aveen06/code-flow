"""Exercise import validation, progress, and reuse through the HTTP API."""

import json
import os
import signal
import subprocess
from collections.abc import Callable
from concurrent.futures import Executor, Future
from multiprocessing import active_children
from multiprocessing.connection import Connection
from pathlib import Path
from threading import Event, Timer, current_thread
from time import monotonic, sleep
from unittest.mock import Mock

import pytest
from codeflow import analyze
from fastapi.testclient import TestClient

from app import import_worker, importer
from app.auto_sync import AutoSync
from app.config import Settings
from app.main import create_app
from app.store import Store

URL = "https://github.com/Demo/shop"
REPOS = "/api/repos"
REPO_ID = "Demo__shop"
REPO = f"{REPOS}/{REPO_ID}"
ORIGIN = "http://example.test"
AUTO_SYNC = "/api/auto-sync"


class InlineExecutor(Executor):
    """Run each queued import on the calling thread for deterministic tests."""

    before_run: Callable[[], None] | None = None

    def submit(self, fn, /, *args, **kwargs):
        if self.before_run is not None:
            self.before_run()
        future = Future()
        future.set_result(fn(*args, **kwargs))
        return future


class HeldExecutor(Executor):
    """Hold submitted jobs until the test runs them."""

    def __init__(self):
        self.pending = []

    def submit(self, fn, /, *args, **kwargs):
        future = Future()
        self.pending.append((future, fn, args, kwargs))
        return future

    def run_next(self):
        future, fn, args, kwargs = self.pending.pop(0)
        future.set_result(fn(*args, **kwargs))


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


def test_configured_cap_rejects_imports_and_bounds_refreshes(tmp_path: Path, local_repo: Path):
    settings = Settings(tmp_path / "data", ORIGIN, max_import_commits=2)
    app = create_app(
        settings, git_url_builder=lambda _: local_repo.as_uri(), executor=InlineExecutor()
    )
    url = {"url": URL, "subdir": "shop"}

    with TestClient(app) as client:
        response = client.post(REPOS, json={**url, "max_commits": 3})
        assert response.status_code == 400
        assert response.json()["detail"] == "max_commits must be an integer from 1 to 2"
        assert client.get(REPOS).json() == []

        # An omitted count defaults to the service limit when it is below 30.
        assert client.post(REPOS, json=url).status_code == 202
        old = client.get(f"{REPO}/commits").json()["commits"]
        assert len(old) == 2
        fresh = commit(local_repo, "shop/new.py", "def new(): pass\n", "Add new function")
        assert client.post(f"{REPO}/refresh").status_code == 202
        assert client.get(f"{REPO}/status").json()["new_commits"] == 1
        assert [entry["sha"] for entry in client.get(f"{REPO}/commits").json()["commits"]] == [
            old[-1]["sha"],
            fresh,
        ]


def test_full_import_and_reimport(tmp_path: Path, local_repo: Path, monkeypatch):
    settings = Settings(tmp_path / "data", ORIGIN)
    executor = InlineExecutor()
    app = create_app(settings, git_url_builder=lambda _: local_repo.as_uri(), executor=executor)
    statuses = []
    git_command = import_worker._git
    analyze_repo = import_worker.analyze_repo
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
        monkeypatch.setattr(import_worker, "_git", observe_git)
        monkeypatch.setattr(import_worker, "analyze_repo", observe_analysis)
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
    git_command = import_worker._git

    def observe_fetch(*args, **kwargs):
        if args[0] == "ls-remote":
            active = client.get(f"{REPO}/status").json()
            assert active["status"] == "cloning"
            assert active["new_commits"] is None
            duplicate = client.post(f"{REPO}/refresh")
            assert duplicate.status_code == 202
            assert duplicate.json() == {"id": REPO_ID, "status": "cloning"}
        return git_command(*args, **kwargs)

    monkeypatch.setattr(import_worker, "_git", observe_fetch)
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
    git_command = import_worker._git

    def fail_fetch(*args, **kwargs):
        if "fetch" in args:
            assert client.get(f"{REPO}/commits").json() == previous
            raise import_worker.ImportFailure(import_worker.UNAVAILABLE)
        return git_command(*args, **kwargs)

    monkeypatch.setattr(import_worker, "_git", fail_fetch)
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


def test_auto_sync_api_persists_valid_updates_and_loads_once(tmp_path, local_repo):
    data_dir = tmp_path / "data"
    settings = Settings(data_dir, ORIGIN)
    path = data_dir / "auto_sync.json"
    analyze.analyze_repo(local_repo, data_dir / "local", max_commits=1)
    executor = HeldExecutor()

    def app():
        return create_app(
            settings,
            git_url_builder=lambda _: local_repo.as_uri(),
            executor=executor,
            auto_sync_interval=12,
        )

    with TestClient(app()) as client:
        assert client.get(AUTO_SYNC).json() == {
            "interval_seconds": 12,
            "all": False,
            "repos": {},
            "status": {},
        }
        assert client.post(REPOS, json={"url": URL, "max_commits": 1}).status_code == 202
        executor.run_next()
        response = client.put(AUTO_SYNC, json={"repos": {REPO_ID: True}})
        assert response.status_code == 200
        assert response.json()["repos"] == {REPO_ID: True}
        response = client.put(AUTO_SYNC, json={"all": True})
        assert response.json()["all"] is True
        assert response.json()["repos"] == {REPO_ID: True}
        persisted = path.read_text()
        assert json.loads(persisted) == {
            "schema": "code-flow/auto-sync@1",
            "all": True,
            "repos": {REPO_ID: True},
        }

        for payload, code in [
            ({"all": False, "repos": {"missing": True}}, 404),
            ({"repos": {"local": True}}, 409),
            ({"all": 1}, 400),
            ({"repos": {REPO_ID: "false"}}, 400),
            ({"extra": True}, 400),
            ({"repos": []}, 400),
            (None, 400),
        ]:
            assert client.put(AUTO_SYNC, json=payload).status_code == code
        invalid_json = client.put(
            AUTO_SYNC, content="{", headers={"Content-Type": "application/json"}
        )
        assert invalid_json.status_code == 400
        assert path.read_text() == persisted
        cors = client.options(
            AUTO_SYNC, headers={"Origin": ORIGIN, "Access-Control-Request-Method": "PUT"}
        )
        assert cors.status_code == 200

        path.write_text("broken")
        assert client.get(AUTO_SYNC).json()["all"] is True
        path.write_text(persisted)

    with TestClient(app()) as client:
        state = client.get(AUTO_SYNC).json()
        assert state["all"] is True
        assert state["repos"] == {REPO_ID: True}
        assert "local" not in state["status"]


@pytest.mark.parametrize(
    "contents",
    [
        "broken",
        '{"schema":"code-flow/auto-sync@2","all":true,"repos":{}}',
        '{"schema":"code-flow/auto-sync@1","all":true,"repos":{"a":1}}',
        '{"schema":"code-flow/auto-sync@1","all":true}',
    ],
)
def test_invalid_auto_sync_file_defaults_to_off(tmp_path, contents):
    (tmp_path / "auto_sync.json").write_text(contents)
    with TestClient(create_app(Settings(tmp_path, ORIGIN))) as client:
        state = client.get(AUTO_SYNC).json()
        assert state["all"] is False
        assert state["repos"] == {}


def test_auto_sync_schedule_reuses_worker_and_counts_work(tmp_path, local_repo):
    store = Store(tmp_path / "data")
    executor = HeldExecutor()
    git_url = Mock(return_value=local_repo.as_uri())
    repo_importer = importer.RepoImporter(store, git_url, executor)
    clock = Mock(return_value=100.0)
    sync = AutoSync(repo_importer, 10, clock=clock)
    other_id = "Demo__other"
    for url in (URL, "https://github.com/Demo/other"):
        repo_importer.start(
            importer.validate_import({"url": url, "subdir": "shop", "max_commits": 1})
        )
        executor.run_next()

    sync.update({"repos": {REPO_ID: True}})
    repo_importer.refresh(REPO_ID)
    sync.tick()
    assert len(executor.pending) == 1
    assert sync.response()["status"] == {}

    def tick_during_manual_refresh(_url):
        assert repo_importer.job(REPO_ID).status == "cloning"
        sync.tick()
        assert executor.pending == []
        return local_repo.as_uri()

    git_url.side_effect = tick_during_manual_refresh
    executor.run_next()
    git_url.side_effect = None
    assert sync.response()["status"][REPO_ID]["manual_runs"] == 1
    assert sync.response()["status"][REPO_ID]["runs"] == 0

    commit(local_repo, "shop/cart.py", "def cart(): return 1\n", "Change cart")
    sync.tick()
    assert len(executor.pending) == 1
    assert repo_importer.refresh(REPO_ID)["status"] == "queued"
    assert len(executor.pending) == 1
    executor.run_next()
    status = sync.response()["status"][REPO_ID]
    assert status["last_result"] == "new_commits"
    assert status["new_commits"] == 1
    assert status["runs"] == status["fetches"] == status["analysed_commits"] == 1
    assert status["last_started"] <= status["last_finished"] < status["next_run"]
    assert status["seconds"] > 0
    assert other_id not in sync.response()["status"]

    clock.return_value += 9
    sync.tick()
    assert executor.pending == []
    clock.return_value += 1
    sync.tick()
    executor.run_next()
    second = sync.response()["status"][REPO_ID]
    assert second["last_result"] == "up_to_date"
    assert second["new_commits"] == 0
    assert second["runs"] == second["fetches"] == 2
    assert second["analysed_commits"] == second["manual_runs"] == 1
    assert second["seconds"] > status["seconds"]

    sync.update({"all": True, "repos": {REPO_ID: False}})
    sync.tick()
    assert len(executor.pending) == 1
    assert repo_importer.job(other_id).status == "queued"
    executor.run_next()
    clock.return_value += 10
    git_url.return_value = (tmp_path / "missing").as_uri()
    sync.tick()
    assert len(executor.pending) == 2
    while executor.pending:
        executor.run_next()
    failure = sync.response()["status"][REPO_ID]
    assert failure["runs"] == 3
    assert failure["last_result"] == "error"
    assert failure["error"] == import_worker.UNAVAILABLE
    assert failure["new_commits"] is None
    assert failure["next_run"]

    sync.update({"all": False})
    clock.return_value += 10
    sync.tick()
    assert executor.pending == []
    assert all(status["next_run"] is None for status in sync.response()["status"].values())


def test_auto_sync_ticks_and_joins_thread_on_lifespan_shutdown(tmp_path, monkeypatch):
    ticks = Event()
    threads = []

    def observe_tick(self):
        threads.append(current_thread())
        if len(threads) == 2:
            ticks.set()

    monkeypatch.setattr(AutoSync, "tick", observe_tick)
    app = create_app(Settings(tmp_path, ORIGIN), auto_sync_interval=0.001)
    with TestClient(app):
        assert ticks.wait(1)
        assert threads[0].is_alive()
    assert all(thread is threads[0] for thread in threads)
    assert not threads[0].is_alive()


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


def _gated_worker(connection: Connection) -> None:
    """Pause the real worker after reporting its first commit when the test requests it."""
    analyze_repo = import_worker.analyze_repo

    def gated_analysis(clone, staged, *, on_progress, **kwargs):
        gate = clone.parent.parent / ".hold-worker"

        def gated_progress(current, total, entry):
            on_progress(current, total, entry)
            if current == 1:
                deadline = monotonic() + 15
                while gate.exists():
                    if monotonic() >= deadline:
                        raise RuntimeError("Test did not release the worker")
                    sleep(0.01)

        return analyze_repo(clone, staged, on_progress=gated_progress, **kwargs)

    import_worker.analyze_repo = gated_analysis
    import_worker._worker_main(connection)


@pytest.fixture
def spawned_worker(monkeypatch):
    monkeypatch.setattr(import_worker, "_worker_main", _gated_worker)

    def pids():
        return {child.pid for child in active_children() if child.name == "code-flow-import-worker"}

    before = pids()
    yield lambda: pids() - before
    assert pids() == before


def _wait_for_status(
    client: TestClient, repo: str, *, state: str, current: int | None = None
) -> dict:
    deadline = monotonic() + 10
    while monotonic() < deadline:
        status = client.get(f"{repo}/status").json()
        if status["status"] == state and (current is None or status["current"] == current):
            return status
        assert status["status"] not in {"ready", "error"}, status
        sleep(0.02)
    pytest.fail(f"{repo} never reached {state}: {status}")


def test_worker_imports_reports_progress_and_refreshes(tmp_path, local_repo, spawned_worker):
    settings = Settings(tmp_path / "published", ORIGIN)
    gate = settings.data_dir / ".hold-worker"
    settings.data_dir.mkdir()
    gate.touch()
    upstream = Mock(return_value=local_repo.as_uri())
    app = create_app(settings, git_url_builder=upstream, auto_sync_interval=300)
    payload = {"url": URL, "subdir": "shop", "max_commits": 2}
    other = f"{REPOS}/Demo__other"

    with TestClient(app) as client:
        (pid,) = spawned_worker()
        try:
            assert client.post(REPOS, json=payload).json()["status"] == "queued"
            progress = _wait_for_status(client, REPO, state="analyzing", current=1)
            assert (progress["total"], progress["message"]) == (2, "Analyzing commit 1 of 2")
            assert client.get("/api/health").status_code == 200
            assert client.post(REPOS, json=payload).json()["status"] == "analyzing"
            assert client.post(f"{REPO}/refresh").json()["status"] == "analyzing"
            assert (
                client.post(
                    REPOS, json={**payload, "url": "https://github.com/Demo/other"}
                ).status_code
                == 202
            )
            assert client.get(f"{other}/status").json()["status"] == "queued"
        finally:
            gate.unlink(missing_ok=True)
        _wait_for_status(client, REPO, state="ready", current=2)
        _wait_for_status(client, other, state="ready", current=2)
        assert upstream.call_count == 2

        fresh = commit(local_repo, "shop/price.py", "def price(): return 7\n", "New price")
        response = client.put(AUTO_SYNC, json={"repos": {REPO_ID: True}})
        assert response.status_code == 200
        deadline = monotonic() + 10
        while monotonic() < deadline:
            stats = client.get(AUTO_SYNC).json()["status"].get(REPO_ID, {})
            if stats.get("last_result") == "new_commits":
                break
            sleep(0.02)
        else:
            pytest.fail(f"Automatic worker refresh did not finish: {stats}")
        assert stats["runs"] == stats["fetches"] == stats["analysed_commits"] == 1
        assert stats["seconds"] > 0
        assert client.get(f"{REPO}/status").json()["new_commits"] == 1
        assert client.get(f"{REPO}/diff", params={"head": fresh}).status_code == 200
        assert spawned_worker() == {pid}

    assert not spawned_worker()


def test_worker_crash_preserves_output_and_restarts(tmp_path, local_repo, spawned_worker):
    settings = Settings(tmp_path / "published", ORIGIN)
    app = create_app(settings, git_url_builder=lambda _: local_repo.as_uri())
    with TestClient(app) as client:
        assert client.post(REPOS, json={"url": URL, "subdir": "shop"}).status_code == 202
        _wait_for_status(client, REPO, state="ready")
        old_commits = client.get(f"{REPO}/commits").json()
        fresh = commit(local_repo, "shop/price.py", "def price(): return 8\n", "New price")
        gate = settings.data_dir / ".hold-worker"
        gate.touch()
        try:
            (pid,) = spawned_worker()
            assert client.put(AUTO_SYNC, json={"repos": {REPO_ID: True}}).status_code == 200
            _wait_for_status(client, REPO, state="analyzing", current=1)
            os.kill(pid, signal.SIGKILL)
            failed = _wait_for_status(client, REPO, state="error")
            assert failed["error"] == failed["message"] == "Could not analyze repository"
            assert client.get(f"{REPO}/commits").json() == old_commits
            assert client.get("/api/health").status_code == 200
            stats = client.get(AUTO_SYNC).json()["status"][REPO_ID]
            assert (stats["last_result"], stats["runs"], stats["fetches"]) == ("error", 1, 1)
            assert stats["analysed_commits"] == 0
            assert client.put(AUTO_SYNC, json={"repos": {REPO_ID: False}}).status_code == 200
            assert not spawned_worker()
            assert sorted(path.name for path in (settings.data_dir / "repos").iterdir()) == [
                REPO_ID
            ]
        finally:
            gate.unlink(missing_ok=True)

        assert client.post(f"{REPO}/refresh").json()["status"] == "queued"
        assert _wait_for_status(client, REPO, state="ready")["new_commits"] == 1
        assert client.get(f"{REPO}/diff", params={"head": fresh}).status_code == 200
        (replacement,) = spawned_worker()
        assert replacement != pid

    assert not spawned_worker()


def test_worker_shutdown_drains_running_import(tmp_path, local_repo, spawned_worker):
    settings = Settings(tmp_path / "published", ORIGIN)
    settings.data_dir.mkdir()
    gate = settings.data_dir / ".hold-worker"
    gate.touch()
    release = Timer(0.1, gate.unlink)
    app = create_app(settings, git_url_builder=lambda _: local_repo.as_uri())
    with TestClient(app) as client:
        try:
            assert client.post(REPOS, json={"url": URL, "subdir": "shop"}).status_code == 202
            _wait_for_status(client, REPO, state="analyzing", current=1)
            assert spawned_worker()
        finally:
            release.start()

    release.join()
    assert (settings.data_dir / REPO_ID / "commits.json").is_file()
    assert not spawned_worker()
