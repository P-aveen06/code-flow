"""Exercise the API with snapshots and source from the shop demo's Git history."""

import json
import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest
from codeflow.analyze import load_commits, load_snapshot
from codeflow.graph import Commit
from fastapi.testclient import TestClient

from app import config
from app.config import Settings
from app.main import create_app

REPO_URL = "/api/repos/shop-demo"


@pytest.fixture
def client(demo_data: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("CODEFLOW_DATA_DIR", str(demo_data))
    monkeypatch.setenv("CODEFLOW_LONG_FLOW_MIN_DEPTH", "")
    with TestClient(create_app()) as test_client:
        yield test_client


def test_list_repos(client: TestClient) -> None:
    response = client.get("/api/repos")

    assert response.status_code == 200
    assert response.json() == [
        {
            "id": "shop-demo",
            "name": "shop-demo",
            "url": None,
            "subdir": "",
            "branch": "main",
            "commit_count": 8,
            "status": "ready",
            "message": "Ready",
            "warning": None,
        }
    ]


def test_ready_status_for_local_repo(client: TestClient) -> None:
    response = client.get(f"{REPO_URL}/status")
    assert response.status_code == 200
    assert response.json() == {
        "id": "shop-demo",
        "name": "shop-demo",
        "status": "ready",
        "message": "Ready",
        "current": 8,
        "total": 8,
        "warning": None,
        "error": None,
        "seconds": 0,
    }
    assert client.get("/api/repos/missing/status").status_code == 404


def test_legacy_index_uses_first_parent(demo_data: Path, tmp_path: Path, checkout_commit: Commit):
    repo = tmp_path / "shop-demo"
    shutil.copytree(demo_data / "shop-demo", repo)
    index_file = repo / "commits.json"
    index = json.loads(index_file.read_text())
    for commit in index["commits"]:
        del commit["base"]
    index_file.write_text(json.dumps(index))

    with TestClient(create_app(Settings(tmp_path, "http://example.test"))) as client:
        response = client.get(f"{REPO_URL}/diff", params={"head": checkout_commit.sha})
        assert response.status_code == 200
        assert response.json()["base"] == checkout_commit.parents[0]
        commits = client.get(f"{REPO_URL}/commits").json()["commits"]
        assert commits[4]["stats"] == response.json()["diff"]["stats"]


def test_commits(client: TestClient, checkout_commit: Commit) -> None:
    response = client.get(f"{REPO_URL}/commits")

    assert response.status_code == 200
    data = response.json()
    assert data["repo"] == "shop-demo"
    assert data["branch"] == "main"
    commits = data["commits"]
    assert len(commits) == 8
    assert [commit["date"] for commit in commits] == [
        f"2026-11-20T{hour:02}:00:00Z" for hour in range(9, 17)
    ]
    assert commits[0]["message"] == "Add cart"
    assert commits[0]["stats"] == {
        "nodes_added": 5,
        "nodes_removed": 0,
        "nodes_changed": 0,
        "edges_added": 1,
        "edges_removed": 0,
    }
    checkout = commits[4]
    assert checkout["sha"] == checkout_commit.sha
    assert checkout["parents"] == [commits[3]["sha"]]
    assert checkout["stats"]["nodes_added"] == 2
    assert checkout["stats"]["nodes_changed"] == 1
    assert "new_checkout" in checkout["summary"]


def test_snapshot(client: TestClient, demo_data: Path, checkout_commit: Commit) -> None:
    response = client.get(f"{REPO_URL}/snapshots/{checkout_commit.sha[:8]}")

    assert response.status_code == 200
    graph = response.json()
    assert graph["schema"] == "code-flow/graph@1"
    assert graph == load_snapshot(demo_data / "shop-demo", checkout_commit.sha).to_json()
    assert client.get(f"{REPO_URL}/snapshots/unknown").status_code == 404


def test_diff(client: TestClient, demo_data: Path, checkout_commit: Commit) -> None:
    url = f"{REPO_URL}/diff"
    params = {"head": checkout_commit.sha[:8]}
    response = client.get(url, params=params)

    assert response.status_code == 200
    overlay = response.json()
    assert overlay["base"] == checkout_commit.parents[0]
    assert overlay["head"] == checkout_commit.sha
    assert "new_checkout" in overlay["summary"]
    assert overlay["diff"]["schema"] == "code-flow/diff@1"
    assert overlay["flow_depth"] == 4
    assert overlay["long_flow"] is True
    nodes = {node["id"]: node for node in overlay["nodes"]}
    assert list(nodes) == sorted(nodes)
    checkout = nodes["shop.api:checkout"]
    assert (checkout["status"], checkout["in_base"], checkout["in_head"]) == ("changed", True, True)
    for name in ("new_checkout", "legacy_checkout"):
        node = nodes[f"shop.checkout:{name}"]
        assert (node["status"], node["in_base"], node["in_head"]) == ("added", False, True)
        assert node["file"] == "shop/checkout.py"
        assert node["qualname"] == name

    edges = {(edge["source"], edge["target"]): edge for edge in overlay["edges"]}
    assert list(edges) == sorted(edges)
    new_edge = edges[("shop.api:checkout", "shop.checkout:new_checkout")]
    assert new_edge["guard"] == {"flag": "new_checkout", "when": "on"}
    assert (new_edge["status"], new_edge["in_base"], new_edge["in_head"]) == ("added", False, True)
    removed = [edge for edge in edges.values() if edge["status"] == "removed"]
    assert removed and all(edge["in_base"] and not edge["in_head"] for edge in removed)

    smaller = client.get(url, params={**params, "hops": 0})
    assert smaller.status_code == 200
    assert len(smaller.json()["nodes"]) < len(nodes)
    assert smaller.json()["flow_depth"] == 3
    assert smaller.json()["long_flow"] is False
    assert client.get(url, params={**params, "hops": 9}).status_code in (400, 422)

    root = load_commits(demo_data / "shop-demo")[0]
    explicit = client.get(url, params={**params, "base": root.sha[:8]})
    assert explicit.status_code == 200
    assert explicit.json()["base"] == root.sha
    assert explicit.json()["diff"]["stats"]["nodes_added"] > overlay["diff"]["stats"]["nodes_added"]


def test_diff_from_root(client: TestClient, demo_data: Path) -> None:
    root = load_commits(demo_data / "shop-demo")[0]
    response = client.get(f"{REPO_URL}/diff", params={"head": root.sha})

    assert response.status_code == 200
    overlay = response.json()
    assert overlay["base"] == overlay["diff"]["base"] == ""
    assert overlay["diff"]["stats"]["nodes_added"] == 5
    assert overlay["flow_depth"] == 2
    assert overlay["long_flow"] is False
    assert all(node["status"] == "added" and not node["in_base"] for node in overlay["nodes"])


def test_diff_long_flow_threshold_override(
    demo_data: Path, checkout_commit: Commit, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CODEFLOW_DATA_DIR", str(demo_data))
    monkeypatch.setenv("CODEFLOW_LONG_FLOW_MIN_DEPTH", "5")
    with TestClient(create_app()) as client:
        response = client.get(f"{REPO_URL}/diff", params={"head": checkout_commit.sha})

    assert response.status_code == 200
    assert response.json()["flow_depth"] == 4
    assert response.json()["long_flow"] is False


@pytest.mark.parametrize("threshold", ["0", "-1", "four"])
def test_invalid_long_flow_threshold(threshold: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CODEFLOW_LONG_FLOW_MIN_DEPTH", threshold)
    with pytest.raises(ValueError, match="CODEFLOW_LONG_FLOW_MIN_DEPTH"):
        Settings.from_env()


def test_code(client: TestClient, checkout_commit: Commit) -> None:
    url = f"{REPO_URL}/code"
    params = {"sha": checkout_commit.sha[:8], "file": "shop/checkout.py"}
    snippet = client.get(url, params={**params, "start": 15, "end": 19})

    assert snippet.status_code == 200
    data = snippet.json()
    assert (data["sha"], data["file"], data["start"], data["end"]) == (
        checkout_commit.sha,
        "shop/checkout.py",
        15,
        19,
    )
    assert [line["number"] for line in data["lines"]] == list(range(15, 20))
    assert data["lines"][0]["text"].startswith("def new_checkout(")
    assert data["lines"][-1]["text"] == "    return create_order(cart, receipt, amount)"

    full = client.get(url, params=params)
    assert full.status_code == 200
    assert (full.json()["start"], full.json()["end"]) == (1, 19)
    assert full.json()["lines"][14:19] == data["lines"]
    assert client.get(url, params={**params, "start": -5, "end": 100}).json() == full.json()
    assert client.get(url, params={**params, "file": "../etc/passwd"}).status_code in (400, 404)
    assert client.get(url, params={**params, "file": "unknown.py"}).status_code == 404
    assert client.get(url, params={**params, "file": "shop"}).status_code == 404


def test_unknown_and_invalid_repos(client: TestClient) -> None:
    response = client.get("/api/repos/missing/commits")
    assert response.status_code == 404
    assert "detail" in response.json()
    for name in ("shop%2E%2Edemo", "shop%5Cdemo", "shop%2Fdemo"):
        assert client.get(f"/api/repos/{name}/commits").status_code in (400, 404)


def test_data_dir_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(config, "_read_dotenv", lambda _: {})
    monkeypatch.delenv("CODEFLOW_DATA_DIR", raising=False)
    assert Settings.from_env().data_dir == Path(__file__).resolve().parents[2] / "data"
    monkeypatch.setenv("CODEFLOW_DATA_DIR", "./data")
    assert Settings.from_env().data_dir == tmp_path / "data"
