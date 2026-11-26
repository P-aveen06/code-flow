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
from app.store import NotFound, Store

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
    assert (checkout["lines_added"], checkout["lines_removed"]) == (5, 4)
    context = nodes["shop.orders:create_order"]
    assert (context["status"], context["lines_added"], context["lines_removed"]) == (
        "context",
        0,
        0,
    )
    for name in ("new_checkout", "legacy_checkout"):
        node = nodes[f"shop.checkout:{name}"]
        assert (node["status"], node["in_base"], node["in_head"]) == ("added", False, True)
        assert node["file"] == "shop/checkout.py"
        assert node["qualname"] == name
        assert (node["lines_added"], node["lines_removed"]) == (5, 0)

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


def test_diff_context_counts_need_no_source(
    client: TestClient, checkout_commit: Commit, monkeypatch: pytest.MonkeyPatch
) -> None:
    files_read = set()

    def unavailable_source(self: Store, repo: str, index: dict, sha: str, file: str) -> list[str]:
        files_read.add(file)
        raise NotFound(f"No source for {file}")

    monkeypatch.setattr(Store, "_file_lines", unavailable_source)
    response = client.get(f"{REPO_URL}/diff", params={"head": checkout_commit.sha})

    assert response.status_code == 200
    nodes = {node["id"]: node for node in response.json()["nodes"]}
    context = nodes["shop.orders:create_order"]
    assert (context["status"], context["lines_added"], context["lines_removed"]) == (
        "context",
        0,
        0,
    )
    assert context["file"] not in files_read
    changed = nodes["shop.api:checkout"]
    assert (changed["lines_added"], changed["lines_removed"]) == (None, None)
    assert changed["file"] in files_read


def test_function_diff_uses_both_snapshot_spans(client: TestClient, demo_data: Path) -> None:
    node_id = "shop.checkout:new_checkout"
    commit = next(
        commit
        for commit in load_commits(demo_data / "shop-demo")
        if commit.message == "new_checkout: add fraud check"
    )
    base = commit.parents[0]
    head = commit.sha
    before = next(
        node for node in load_snapshot(demo_data / "shop-demo", base).nodes if node.id == node_id
    )
    after = next(
        node for node in load_snapshot(demo_data / "shop-demo", head).nodes if node.id == node_id
    )
    assert before.line != after.line
    url = f"{REPO_URL}/function-diff"
    params = {"head": head[:8], "node": node_id}

    response = client.get(url, params=params)
    assert response.status_code == 200
    result = response.json()
    assert client.get(url, params={**params, "base": base[:8]}).json() == result
    assert (result["node"], result["base"], result["head"], result["file"], result["status"]) == (
        node_id,
        base,
        head,
        "shop/checkout.py",
        "changed",
    )
    assert (result["lines_added"], result["lines_removed"]) == (2, 0)
    rows = result["rows"]
    assert rows[0] == {
        "kind": "context",
        "base_line": before.line,
        "head_line": after.line,
        "text": "def new_checkout(cart: Cart, card_token: str, inventory: dict[str, int]) -> dict:",
    }
    assert [row["base_line"] for row in rows if row["base_line"] is not None] == list(
        range(before.line, before.end_line + 1)
    )
    assert [row["head_line"] for row in rows if row["head_line"] is not None] == list(
        range(after.line, after.end_line + 1)
    )


def test_function_diff_added_removed_and_context(
    client: TestClient, demo_data: Path, checkout_commit: Commit
) -> None:
    root, *_, latest = load_commits(demo_data / "shop-demo")
    url = f"{REPO_URL}/function-diff"
    cases = [
        (root.sha, "shop.cart:Cart.total", "added", "added"),
        (latest.sha, "shop.pricing:apply_coupon", "removed", "removed"),
        (checkout_commit.sha, "shop.orders:create_order", "context", "context"),
    ]
    for sha, node_id, status, kind in cases:
        response = client.get(url, params={"head": sha, "node": node_id})
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == status
        assert {row["kind"] for row in data["rows"]} == {kind}
        assert data["rows"][0]["text"].lstrip().startswith("def ")
        assert all((row["base_line"] is None) == (kind == "added") for row in data["rows"])
        assert all((row["head_line"] is None) == (kind == "removed") for row in data["rows"])
        counts = (
            len(data["rows"]) if kind == "added" else 0,
            len(data["rows"]) if kind == "removed" else 0,
        )
        assert (data["lines_added"], data["lines_removed"]) == counts
        overlay = client.get(f"{REPO_URL}/diff", params={"head": sha}).json()
        node = next(node for node in overlay["nodes"] if node["id"] == node_id)
        assert (node["lines_added"], node["lines_removed"]) == counts
        if sha == root.sha:
            assert data["base"] == ""


def test_function_diff_unavailable_source_and_node(
    demo_data: Path, tmp_path: Path, checkout_commit: Commit
) -> None:
    repo = tmp_path / "shop-demo"
    shutil.copytree(demo_data / "shop-demo", repo)
    index_file = repo / "commits.json"
    index = json.loads(index_file.read_text())
    del index["repo_path"]
    index_file.write_text(json.dumps(index))

    with TestClient(create_app(Settings(tmp_path, "http://example.test"))) as client:
        url = f"{REPO_URL}/function-diff"
        params = {"head": checkout_commit.sha, "node": "shop.api:checkout"}
        missing_source = client.get(url, params=params)
        assert missing_source.status_code == 404
        assert "No source repository path" in missing_source.json()["detail"]
        assert client.get(url, params={**params, "node": "missing"}).status_code == 404
        assert client.get(url, params={**params, "head": "missing"}).status_code == 404
        overlay = client.get(f"{REPO_URL}/diff", params={"head": checkout_commit.sha}).json()
        assert overlay["nodes"]
        for node in overlay["nodes"]:
            counts = (node["lines_added"], node["lines_removed"])
            assert counts == ((0, 0) if node["status"] == "context" else (None, None))


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
