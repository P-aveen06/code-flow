"""Exercise the snapshot pipeline, its parse cache, and its readers."""

import json
from dataclasses import asdict
from unittest.mock import Mock

import pytest

from codeflow import analyze
from codeflow.analyze import analyze_repo, load_commits, load_snapshot, resolve_sha
from codeflow.graph import Commit


def test_snapshots_are_incremental_and_deterministic(make_repo, tmp_path, monkeypatch):
    shared_source = "def total():\n    return 25\n"
    repo = make_repo(
        [
            {"cart.py": shared_source, "catalog.py": shared_source},
            {"api.py": "from cart import total\n\ndef checkout():\n    return total()\n"},
        ]
    )
    spy = Mock(wraps=analyze.parse_file)
    monkeypatch.setattr(analyze, "parse_file", spy)
    out = tmp_path / "output"

    first, second = analyze_repo(repo.path, out)

    assert [call.args[0] for call in spy.call_args_list] == ["cart.py", "catalog.py", "api.py"]
    assert {path.name for path in (out / "snapshots").iterdir()} == {
        f"{result.commit.sha}.json" for result in (first, second)
    }
    assert [node.id for node in load_snapshot(out, first.commit.sha).nodes] == [
        "cart:total",
        "catalog:total",
    ]
    assert [node.id for node in load_snapshot(out, second.commit.sha).nodes] == [
        "api:checkout",
        "cart:total",
        "catalog:total",
    ]
    assert (first.node_count, first.edge_count, first.flag_count) == (2, 0, 0)
    assert (second.node_count, second.edge_count, second.flag_count) == (3, 1, 0)
    assert first.written and second.written
    assert load_commits(out) == [first.commit, second.commit]
    assert json.loads((out / "commits.json").read_text(encoding="utf-8")) == {
        "schema": "code-flow/commits@1",
        "repo": "repo",
        "branch": "HEAD",
        "source_root": "",
        "commits": [asdict(first.commit), asdict(second.commit)],
    }

    first_bytes = first.snapshot_path.read_bytes()
    second_bytes = second.snapshot_path.read_bytes()
    assert (
        second_bytes.decode()
        == json.dumps(json.loads(second_bytes), indent=2, sort_keys=True) + "\n"
    )

    cached = analyze_repo(repo.path, out)
    assert cached == [
        analyze.CommitResult(first.commit, first.snapshot_path, 2, 0, 0, False),
        analyze.CommitResult(second.commit, second.snapshot_path, 3, 1, 0, False),
    ]
    assert spy.call_count == 3

    fresh = analyze_repo(repo.path, tmp_path / "fresh-output")
    assert [result.snapshot_path.read_bytes() for result in fresh] == [first_bytes, second_bytes]


def test_source_root_selection_and_options(make_repo, tmp_path):
    repo = make_repo(
        [
            {"outside.py": "def outside(): pass\n", "src/shop/catalog.py": "def item(): pass\n"},
            {"src/shop/test_cart.py": "import requests\n\ndef cart():\n    requests.get('/')\n"},
        ]
    )
    out = tmp_path / "output"

    (result,) = analyze_repo(
        repo.path,
        out,
        branch="main",
        max_commits=1,
        source_root="src",
        include=("**/*.py",),
        exclude=(),
        keep_external=True,
    )

    assert [node.id for node in load_snapshot(out, result.commit.sha).nodes] == [
        "external:requests",
        "shop.catalog:item",
        "shop.test_cart:cart",
    ]
    assert result.commit.message == "Commit 2"
    index = json.loads((out / "commits.json").read_text(encoding="utf-8"))
    assert index["branch"] == "main"
    assert index["source_root"] == "src"


def test_undecodable_blobs_are_skipped_in_each_snapshot(make_repo, tmp_path):
    repo = make_repo(
        [
            {"broken.py": b"# invalid UTF-8: \xff\n", "cart.py": "def total(): pass\n"},
            {"api.py": "def checkout(): pass\n"},
            {"broken.py": "def fixed(): pass\n"},
        ]
    )

    first, second, third = analyze_repo(repo.path, tmp_path / "output")

    assert [result.skipped for result in (first, second, third)] == [
        ["broken.py"],
        ["broken.py"],
        [],
    ]
    assert [result.node_count for result in (first, second, third)] == [1, 2, 3]


def test_parser_recursion_failure_is_local_to_one_file(make_repo, tmp_path, monkeypatch):
    repo = make_repo([{"deep.py": "", "cart.py": "def total(): pass\n"}])
    parse_file = analyze.parse_file

    def parse(path: str, source: bytes, source_root: str):
        if path == "deep.py":
            raise RecursionError("expression exceeds parser depth")
        return parse_file(path, source, source_root)

    monkeypatch.setattr(analyze, "parse_file", parse)

    (result,) = analyze_repo(repo.path, tmp_path / "output")

    assert result.skipped == ["deep.py"]
    assert result.node_count == 1


def test_resolve_sha_uses_the_current_index(make_repo, tmp_path):
    repo = make_repo([{"cart.py": ""}, {"api.py": ""}])
    out = tmp_path / "output"
    first, second = analyze_repo(repo.path, out)
    assert resolve_sha(out, first.commit.sha) == first.commit.sha
    assert resolve_sha(out, second.commit.sha[:12]) == second.commit.sha
    assert not analyze_repo(repo.path, out, max_commits=1)[0].written
    with pytest.raises(ValueError, match="Unknown commit SHA or prefix"):
        resolve_sha(out, first.commit.sha)


def test_resolve_sha_rejects_ambiguous_prefix(tmp_path):
    shas = ["ab" + "0" * 38, "ab" + "1" * 38]
    commits = [asdict(Commit(sha, [], "Author", "2026-11-20T09:00:00Z", "Subject")) for sha in shas]
    (tmp_path / "commits.json").write_text(json.dumps({"commits": commits}), encoding="utf-8")

    assert resolve_sha(tmp_path, "ab0") == shas[0]
    with pytest.raises(ValueError, match="Ambiguous commit SHA prefix: 'ab'"):
        resolve_sha(tmp_path, "ab")
